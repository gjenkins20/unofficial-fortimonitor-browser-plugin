// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-154: chrome.runtime message handlers for snapshot take / read / diff.
//
// Wraps runBpaAudit so the existing BPA fetcher is the single source of
// truth for what a "snapshot" contains. The bpa:run-audit handler stays
// untouched (used by the existing BPA UI); snapshots get their own
// handler that condenses the result via bpa-snapshots.js before
// persisting.

import { runBpaAudit } from './bpa-audit-handlers.js';
import { createBpaFetch } from '../lib/bpa-fetcher.js';
import { PanoptaClient, PanoptaError } from '../lib/panopta-client.js';
import {
  condenseForSnapshot,
  readSnapshots,
  writeSnapshot,
  diffServers,
} from '../lib/bpa-snapshots.js';

// FMN-164: tenant-size-aware ETA tuning.
//
// SERVERS_PER_SECOND is the projected BPA crawl throughput. Operator-side
// reports cite "3+ minutes is typical" on real tenants; the schema-discovery
// account ran ~120 servers in roughly that window, so ~0.7 servers/sec is the
// starting calibration. Tune from real runs - basedOn:'projected' carries the
// serverCount so post-run telemetry can refine N over time.
const SERVERS_PER_SECOND = 0.7;
const BASELINE_SECONDS = 30;
const DEFAULT_ESTIMATE_SECONDS = 180;
const PROBE_CACHE_KEY = 'fmn.bpaSnapshot.serverCountProbe';
const PROBE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes - covers a flurry of card mounts
const RUN_STATE_KEY = 'fmn.bpaSnapshot.runState';

async function defaultClientFactory() {
  const wrappedFetch = createBpaFetch(globalThis.fetch.bind(globalThis));
  const stored = await chrome.storage.local.get('panopta.apiKey');
  const apiKey = stored?.['panopta.apiKey'];
  if (!apiKey) {
    throw new PanoptaError(
      'No API key configured. Open the extension settings and paste a FortiMonitor RW API key.',
      { phase: 'auth' }
    );
  }
  return new PanoptaClient({ apiKey, fetch: wrappedFetch });
}

function projectEstimateSeconds(serverCount) {
  if (!Number.isFinite(serverCount) || serverCount <= 0) return DEFAULT_ESTIMATE_SECONDS;
  // baseline + serverCount/N; floor at the conservative 180s default so an
  // accurate-but-optimistic projection never undersells the wait.
  const projected = Math.round(BASELINE_SECONDS + serverCount / SERVERS_PER_SECOND);
  return Math.max(DEFAULT_ESTIMATE_SECONDS, projected);
}

async function readProbeCache(session) {
  if (!session) return null;
  try {
    const got = await session.get(PROBE_CACHE_KEY);
    const entry = got?.[PROBE_CACHE_KEY];
    if (!entry) return null;
    if (typeof entry.fetchedAt !== 'number') return null;
    if (Date.now() - entry.fetchedAt > PROBE_CACHE_TTL_MS) return null;
    return entry;
  } catch { return null; }
}

async function writeProbeCache(session, entry) {
  if (!session) return;
  try { await session.set({ [PROBE_CACHE_KEY]: entry }); } catch { /* quota / unavailable */ }
}

// Probe /v2/server?limit=1 to learn meta.total_count. Returns the count or
// null on any failure (no API key, network blip, malformed body). Callers
// must treat null as "fall back to the default estimate" - no error UI.
async function probeServerCount({ getClient }) {
  try {
    const factory = getClient ?? (() => defaultClientFactory());
    const client = await factory();
    const body = await client.listServers({ limit: 1, offset: 0 });
    const total = body?.meta?.total_count;
    if (typeof total === 'number' && total >= 0) return total;
    return null;
  } catch {
    return null;
  }
}

export function createBpaSnapshotHandlers({
  events = {},
  getClient,
  resolveOrigin,
  storage,
  sessionStorage,
} = {}) {
  const emit = events.emit ?? (() => {});
  const local = storage ?? (typeof chrome !== 'undefined' ? chrome.storage?.local : null);
  const session = sessionStorage ?? (typeof chrome !== 'undefined' ? chrome.storage?.session : null);

  let runInFlight = false;
  let runStartedAt = null;

  async function persistRunState(state) {
    if (!session) return;
    try {
      if (state == null) await session.remove(RUN_STATE_KEY);
      else await session.set({ [RUN_STATE_KEY]: state });
    } catch { /* session storage may be unavailable in tests */ }
  }

  async function readPersistedRunState() {
    if (!session) return null;
    try {
      const got = await session.get(RUN_STATE_KEY);
      return got?.[RUN_STATE_KEY] ?? null;
    } catch { return null; }
  }

  return {
    'bpa-snapshots:status': async () => {
      const { current, previous } = await readSnapshots(local);
      // FMN-164: if the SW lost in-memory state (idle eviction) but a run
      // is genuinely still happening, an opening card mount would otherwise
      // miss the in-flight banner. Persisted runStartedAt is the recovery
      // signal. We never trust persisted state alone to gate the runInFlight
      // boolean (the run could have crashed silently); we just surface it so
      // the UI can resume the elapsed counter from the actual start.
      const persisted = runInFlight ? null : await readPersistedRunState();
      const effectiveInFlight = runInFlight || Boolean(persisted?.startedAt);
      const startedAt = runStartedAt ?? persisted?.startedAt ?? null;
      return {
        hasCurrent: Boolean(current),
        hasPrevious: Boolean(previous),
        currentTakenAt: current?.takenAt ?? null,
        previousTakenAt: previous?.takenAt ?? null,
        runInFlight: effectiveInFlight,
        runStartedAt: effectiveInFlight ? startedAt : null,
      };
    },

    'bpa-snapshots:estimate': async () => {
      // Three branches, in priority order:
      //   1. We've taken a snapshot before -> use its actual run duration.
      //   2. We have an API key + the probe returns a server count
      //      -> project baseline + (serverCount / SERVERS_PER_SECOND).
      //   3. Otherwise -> conservative 180s default (matches the no-data
      //      first-run case operators see on a fresh install).
      // The probe is cached in chrome.storage.session for 5 minutes so a
      // flurry of card mounts (popup open / reload / tab focus) doesn't
      // hammer /v2/server. (FMN-164)
      const { current } = await readSnapshots(local);
      if (current?.durationMs && current.durationMs > 0) {
        return {
          estimatedSeconds: Math.max(5, Math.round(current.durationMs / 1000)),
          basedOn: 'last-run',
          lastServerCount: current.inventory?.servers?.length ?? null,
          serverCount: null,
        };
      }

      let probeServerCountValue = null;
      const cached = await readProbeCache(session);
      if (cached && typeof cached.serverCount === 'number') {
        probeServerCountValue = cached.serverCount;
      } else {
        probeServerCountValue = await probeServerCount({ getClient });
        if (probeServerCountValue !== null) {
          await writeProbeCache(session, {
            serverCount: probeServerCountValue,
            fetchedAt: Date.now(),
          });
        }
      }

      if (typeof probeServerCountValue === 'number') {
        return {
          estimatedSeconds: projectEstimateSeconds(probeServerCountValue),
          basedOn: 'projected',
          lastServerCount: null,
          serverCount: probeServerCountValue,
        };
      }

      return {
        estimatedSeconds: DEFAULT_ESTIMATE_SECONDS,
        basedOn: 'default',
        lastServerCount: null,
        serverCount: null,
      };
    },

    'bpa-snapshots:take': async (payload) => {
      if (runInFlight) throw new Error('A snapshot run is already in progress');
      const factory = getClient ?? (() => defaultClientFactory());
      runInFlight = true;
      runStartedAt = Date.now();
      // Persist the start time so a card that mounts mid-run after a SW
      // idle eviction can still resume the elapsed counter from the right
      // number. The runInFlight in-memory boolean is the source of truth
      // for the same-SW-session case; the persisted record is the recovery
      // path. (FMN-164)
      await persistRunState({ startedAt: runStartedAt });
      try {
        const client = await factory();
        const result = await runBpaAudit({
          client,
          deep: Boolean(payload?.deep),
          maxServers: Number.isFinite(payload?.maxServers) ? payload.maxServers : 0,
          includeFrontend: false,
          sections: payload?.sections ?? ['all'],
          frontendOrigin: resolveOrigin,
          onProgress: (evt) => emit('bpa-snapshots:progress', evt),
        });
        const condensed = condenseForSnapshot(result);
        const next = await writeSnapshot(condensed, local);
        return {
          ok: true,
          currentTakenAt: next.current?.takenAt ?? null,
          previousTakenAt: next.previous?.takenAt ?? null,
        };
      } finally {
        runInFlight = false;
        runStartedAt = null;
        await persistRunState(null);
      }
    },

    'bpa-snapshots:diff': async () => {
      const { current, previous } = await readSnapshots(local);
      if (!current) {
        return { ok: false, reason: 'no-snapshot', message: 'Take a snapshot first.' };
      }
      if (!previous) {
        return { ok: false, reason: 'no-previous', message: 'Only one snapshot stored. Take another snapshot after time has passed to compare.', currentTakenAt: current.takenAt };
      }
      const servers = diffServers(previous, current);
      return {
        ok: true,
        prevTakenAt: previous.takenAt,
        currTakenAt: current.takenAt,
        servers,
        counts: {
          added: servers.added.length,
          removed: servers.removed.length,
          modified: servers.modified.length,
        },
      };
    },
  };
}
