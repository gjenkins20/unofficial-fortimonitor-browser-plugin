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

export function createBpaSnapshotHandlers({
  events = {},
  getClient,
  resolveOrigin,
  storage,
} = {}) {
  const emit = events.emit ?? (() => {});
  const local = storage ?? (typeof chrome !== 'undefined' ? chrome.storage?.local : null);

  let runInFlight = false;

  return {
    'bpa-snapshots:status': async () => {
      const { current, previous } = await readSnapshots(local);
      return {
        hasCurrent: Boolean(current),
        hasPrevious: Boolean(previous),
        currentTakenAt: current?.takenAt ?? null,
        previousTakenAt: previous?.takenAt ?? null,
        runInFlight,
      };
    },

    'bpa-snapshots:estimate': async () => {
      // Prefer the last snapshot's actual run duration. Falls back to a
      // conservative 3-minute default for the very first snapshot - on
      // real tenants the BPA crawl typically runs 1-5 minutes, and the
      // prior 30s default underset operator expectations (FMN-164).
      const { current } = await readSnapshots(local);
      if (current?.durationMs && current.durationMs > 0) {
        return {
          estimatedSeconds: Math.max(5, Math.round(current.durationMs / 1000)),
          basedOn: 'last-run',
          lastServerCount: current.inventory?.servers?.length ?? null,
        };
      }
      return {
        estimatedSeconds: 180,
        basedOn: 'default',
        lastServerCount: null,
      };
    },

    'bpa-snapshots:take': async (payload) => {
      if (runInFlight) throw new Error('A snapshot run is already in progress');
      const factory = getClient ?? (() => defaultClientFactory());
      runInFlight = true;
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
