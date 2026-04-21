// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Message router handlers. Pure functions over injected client + queue;
// testable in Node without touching chrome.runtime.onMessage.
//
// The service worker calls createHandlers(...) at module init, then maps
// each incoming message type to a handler function. All handlers return
// Promises; the service worker wraps their resolve/reject into the
// Chrome runtime response shape.

import { scanDevices, groupByFingerprint, resolveServerNames } from './scanner.js';
import { executeQueue } from './executor.js';

/**
 * @param {object} deps
 * @param {import('../lib/fortimonitor-client.js').FortimonitorClient} deps.client
 * @param {import('../lib/queue.js').Queue} deps.queue
 * @param {{ emit?: (event: string, payload: any) => void }} [deps.events]
 */
export function createHandlers({ client, queue, events = {} }) {
  if (!client) throw new TypeError('createHandlers requires a client');
  if (!queue) throw new TypeError('createHandlers requires a queue');

  const emit = events.emit ?? (() => {});
  let currentRun = null;

  return {
    'scan-devices': async ({ serverIds }) => {
      if (!Array.isArray(serverIds)) throw new TypeError('scan-devices: serverIds must be an array');
      // Run the port scan and name resolution in parallel. Port scan is
      // the authoritative source for progress (scan:progress events);
      // name resolution is best-effort and silent - it populates
      // store.nameById so the step-3 queue CSV always has a name column
      // even for plain-ID input (FMN-61).
      const [results, nameById] = await Promise.all([
        scanDevices(serverIds, {
          client,
          onProgress: (done, total, last) => emit('scan:progress', { done, total, last })
        }),
        resolveServerNames(serverIds, { client }).catch(() => ({}))
      ]);
      return { ...groupByFingerprint(results), nameById };
    },

    'session:probe': async () => {
      if (typeof client.probeSession !== 'function') {
        throw new Error('client does not expose probeSession');
      }
      return client.probeSession();
    },

    'queue:list': async () => {
      return queue.list();
    },

    'queue:replace': async ({ entries }) => {
      await queue.replaceAll(Array.isArray(entries) ? entries : []);
      return { count: Array.isArray(entries) ? entries.length : 0 };
    },

    'queue:add-many': async ({ entries }) => {
      if (!Array.isArray(entries)) throw new TypeError('queue:add-many: entries must be an array');
      return queue.addMany(entries);
    },

    'queue:clear': async () => {
      await queue.clear();
      return { ok: true };
    },

    'execute-queue': async ({ verbose = false, maxAttempts = 3 } = {}) => {
      // Claim the run slot synchronously before any await so two rapid
      // calls don't both slip past the guard.
      if (currentRun) {
        throw new Error('A batch is already running');
      }
      const ac = new AbortController();
      currentRun = { ac, startedAt: new Date().toISOString() };
      try {
        const entries = await queue.list();
        const results = await executeQueue(entries, {
          client,
          verbose,
          maxAttempts,
          signal: ac.signal,
          onEntryStart: (i, entry) => {
            emit('execute:entry-start', { index: i, entryId: entry.id });
          },
          onEntryDone: async (i, result) => {
            const patch = { status: result.status };
            if (result.status === 'failed') {
              patch.lastError = result.reason?.message ?? String(result.reason);
            }
            try {
              await queue.update(result.entry.id, patch);
            } catch {
              // queue update failure is non-fatal for the execution
            }
            emit('execute:entry-done', {
              index: i,
              entryId: result.entry.id,
              status: result.status,
              attempts: result.attempts
            });
          }
        });
        return { results, startedAt: currentRun.startedAt };
      } finally {
        currentRun = null;
      }
    },

    'abort-run': async () => {
      if (!currentRun) return { aborted: false, reason: 'no active run' };
      currentRun.ac.abort();
      return { aborted: true };
    },

    'run-status': async () => {
      return { running: currentRun !== null, startedAt: currentRun?.startedAt ?? null };
    }
  };
}

/**
 * Dispatch helper. The service worker can use this to route an incoming
 * message to the correct handler; tests use it directly to exercise the
 * full routing layer.
 */
export async function dispatch(handlers, message) {
  if (!message || typeof message !== 'object') {
    throw new TypeError('dispatch: message must be an object');
  }
  const handler = handlers[message.type];
  if (!handler) {
    throw new Error(`Unknown message type: ${message.type}`);
  }
  return handler(message.payload ?? {});
}
