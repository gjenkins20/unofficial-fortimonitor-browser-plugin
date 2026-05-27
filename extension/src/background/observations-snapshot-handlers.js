// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-154: chrome.runtime message handlers for snapshot take / read / diff.
//
// Wraps runTenantObservations so the existing Observations fetcher is the single source of
// truth for what a "snapshot" contains. The observations:run-audit handler stays
// untouched (used by the existing Tenant Observations UI); snapshots get their own
// handler that condenses the result via observations-snapshots.js before
// persisting.

import { runTenantObservations, defaultKeepAlive } from './tenant-observations-handlers.js';
import { createObservationsFetch } from '../lib/observations-fetcher.js';
import { PanoptaClient, PanoptaError } from '../lib/panopta-client.js';
import {
  condenseForSnapshot,
  readSnapshots,
  writeSnapshot,
  setPreviousSnapshot,
  diffServers,
  diffAllSections,
  listAllSnapshots,
  getSnapshotById,
  clearAllSnapshots,
  getMaxSnapshots,
  setMaxSnapshots,
} from '../lib/observations-snapshots.js';
import {
  wrapSnapshot,
  unwrapSnapshot,
  filenameFor,
  SnapshotIoError,
} from '../lib/snapshot-io.js';

// FMN-164: 180s is the observed minimum for a first-run snapshot on real
// tenants ("3+ minutes is typical"). Used until a real run lands a
// durationMs in storage, at which point that measured value wins.
const DEFAULT_ESTIMATE_SECONDS = 180;
const RUN_STATE_KEY = 'fmn.observationsSnapshot.runState';

async function defaultClientFactory() {
  const wrappedFetch = createObservationsFetch(globalThis.fetch.bind(globalThis));
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

export function createObservationsSnapshotHandlers({
  events = {},
  getClient,
  resolveOrigin,
  storage,
  sessionStorage,
  keepAlive,
} = {}) {
  const emit = events.emit ?? (() => {});
  const local = storage ?? (typeof chrome !== 'undefined' ? chrome.storage?.local : null);
  const session = sessionStorage ?? (typeof chrome !== 'undefined' ? chrome.storage?.session : null);
  // FMN-261: same MV3 worker-survival heartbeat observations:run-audit uses
  // (FMN-256). Injectable for tests; defaults to the getPlatformInfo pinger.
  const startKeepAlive = keepAlive ?? defaultKeepAlive;

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
    'observations-snapshots:status': async () => {
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

    'observations-snapshots:estimate': async () => {
      // Two branches:
      //   1. We've taken a snapshot before -> use its actual run duration.
      //   2. Otherwise -> 180s default. Set from observed first-run
      //      performance ("3+ minutes typical"); a projection equation
      //      tuned without real-tenant data only mis-sold the wait.
      const { current } = await readSnapshots(local);
      if (current?.durationMs && current.durationMs > 0) {
        return {
          estimatedSeconds: Math.max(5, Math.round(current.durationMs / 1000)),
          basedOn: 'last-run',
          lastServerCount: current.inventory?.servers?.length ?? null,
        };
      }
      return {
        estimatedSeconds: DEFAULT_ESTIMATE_SECONDS,
        basedOn: 'default',
        lastServerCount: null,
      };
    },

    'observations-snapshots:take': async (payload) => {
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
      // FMN-261: keep the worker alive across the crawl's paced sleeps and
      // retry backoffs. Without this the MV3 worker is evicted mid-run, the
      // writeSnapshot below never executes, and the take fails silently -
      // exactly why captures stopped landing once the run grew long enough.
      // observations:run-audit got this in FMN-256; the snapshot take did not.
      const stopKeepAlive = startKeepAlive();
      try {
        const client = await factory();
        const result = await runTenantObservations({
          client,
          deep: Boolean(payload?.deep),
          maxServers: Number.isFinite(payload?.maxServers) ? payload.maxServers : 0,
          includeFrontend: false,
          sections: payload?.sections ?? ['all'],
          frontendOrigin: resolveOrigin,
          onProgress: (evt) => emit('observations-snapshots:progress', evt),
        });
        const condensed = condenseForSnapshot(result);
        const next = await writeSnapshot(condensed, local);
        return {
          ok: true,
          currentTakenAt: next.current?.takenAt ?? null,
          previousTakenAt: next.previous?.takenAt ?? null,
        };
      } finally {
        try { stopKeepAlive?.(); } catch { /* best-effort */ }
        runInFlight = false;
        runStartedAt = null;
        await persistRunState(null);
      }
    },

    // FMN-161: produce a downloadable JSON envelope for a stored slot. The
    // page that initiated the request turns { filename, contents } into a
    // Blob + <a download>; the SW just owns the storage read + envelope
    // formatting because the page has no chrome.storage access.
    'observations-snapshots:export': async (payload) => {
      const slot = payload?.slot === 'previous' ? 'previous' : 'current';
      const { current, previous } = await readSnapshots(local);
      const snapshot = slot === 'current' ? current : previous;
      if (!snapshot) {
        return { ok: false, reason: 'empty-slot', message: `No ${slot} snapshot to export.` };
      }
      const extensionVersion =
        (typeof chrome !== 'undefined' && chrome.runtime?.getManifest)
          ? chrome.runtime.getManifest().version
          : null;
      const envelope = wrapSnapshot(snapshot, { extensionVersion });
      return {
        ok: true,
        filename: filenameFor(snapshot),
        contents: JSON.stringify(envelope, null, 2),
        slot,
      };
    },

    // FMN-161: take an envelope from the file picker and land it in the
    // "previous" slot for diffing against current. If previous already
    // holds a snapshot, refuse unless the caller passed { force: true } -
    // the UI surfaces a confirmation in that case. Current is never
    // overwritten by an import: only newly-taken snapshots rotate into
    // current, by design.
    'observations-snapshots:import': async (payload) => {
      try {
        const { snapshot } = unwrapSnapshot(payload?.envelope);
        const { previous } = await readSnapshots(local);
        const hadPrevious = Boolean(previous);
        if (hadPrevious && !payload?.force) {
          return {
            ok: false,
            reason: 'previous-exists',
            message: 'A baseline snapshot is already loaded. Importing this file will replace it.',
            existingPreviousTakenAt: previous.takenAt ?? null,
            incomingTakenAt: snapshot.takenAt ?? null,
          };
        }
        await setPreviousSnapshot(snapshot, local);
        return {
          ok: true,
          previousTakenAt: snapshot.takenAt ?? null,
          replaced: hadPrevious,
        };
      } catch (err) {
        if (err instanceof SnapshotIoError) {
          return { ok: false, reason: err.code, message: err.message };
        }
        throw err;
      }
    },

    'observations-snapshots:diff': async (payload) => {
      // Phase 2.3: callers may pass { baselineId, currentId } to diff an
      // arbitrary pair. When omitted, default to the latest (current vs
      // previous) so the phase-1 viewer behavior is preserved.
      let baseline = null;
      let current = null;
      if (payload?.baselineId && payload?.currentId) {
        baseline = await getSnapshotById(payload.baselineId, local);
        current = await getSnapshotById(payload.currentId, local);
        if (!baseline || !current) {
          return { ok: false, reason: 'unknown-id', message: 'One of the selected snapshots is no longer in storage.' };
        }
      } else {
        const slots = await readSnapshots(local);
        current = slots.current;
        baseline = slots.previous;
        if (!current) {
          return { ok: false, reason: 'no-snapshot', message: 'Take a snapshot first.' };
        }
        if (!baseline) {
          return { ok: false, reason: 'no-previous', message: 'Only one snapshot stored. Take another snapshot after time has passed to compare.', currentTakenAt: current.takenAt };
        }
      }
      const sections = diffAllSections(baseline, current);
      // Back-compat with the phase-1 viewer: keep .servers + .counts at
      // the top level. New viewers consume .sections.
      const servers = sections.servers;
      return {
        ok: true,
        prevTakenAt: baseline.takenAt,
        currTakenAt: current.takenAt,
        servers,
        counts: {
          added: servers.added.length,
          removed: servers.removed.length,
          modified: servers.modified.length,
        },
        sections,
      };
    },

    // Phase 2.3: enumerate all stored snapshots for the picker UI.
    'observations-snapshots:list': async () => {
      const items = await listAllSnapshots(local);
      return { ok: true, items };
    },

    // Phase 2.5: Settings affordances. Surfaced here so the popup can
    // configure rotation without the picker being open.
    'observations-snapshots:get-config': async () => {
      const maxSnapshots = await getMaxSnapshots(local);
      return { ok: true, maxSnapshots };
    },

    'observations-snapshots:set-max': async (payload) => {
      const requested = Number.isFinite(payload?.maxSnapshots) ? payload.maxSnapshots : null;
      if (requested == null) {
        return { ok: false, reason: 'bad-input', message: 'maxSnapshots must be a finite number.' };
      }
      const applied = await setMaxSnapshots(requested, local);
      return { ok: true, maxSnapshots: applied };
    },

    'observations-snapshots:clear-all': async () => {
      await clearAllSnapshots(local);
      return { ok: true };
    },
  };
}
