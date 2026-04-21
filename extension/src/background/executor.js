// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Queue executor: iterate over approved queue entries, invoke
// client.savePortSelection for each, honor retry + concurrency rules.
// Verbose mode forces serial execution (concurrency=1) without changing
// the rest of the pipeline.

import { FortimonitorError } from '../lib/fortimonitor-client.js';
import { mapConcurrent } from '../lib/concurrency.js';
import { withRetry, backoffDelayMs } from '../lib/retry.js';

// HTTP statuses where a retry stands a chance of succeeding.
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryable(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  if (err instanceof FortimonitorError || err?.name === 'FortimonitorError') {
    if (err.phase === 'auth') return false;          // won't improve on retry
    if (err.status === null || err.status === undefined) return true; // network error
    return RETRYABLE_STATUSES.has(err.status);
  }
  // Unknown error class - assume transient.
  return true;
}

/**
 * @typedef {Object} EntryResult
 * @property {object} entry
 * @property {'succeeded'|'failed'} status
 * @property {any} [value]
 * @property {any} [reason]
 * @property {number} attempts
 */

/**
 * Execute every entry in `entries` whose `status` is not already
 * terminal. Returns per-entry outcomes. Does not mutate entries.
 *
 * @param {Array<object>} entries
 * @param {object} options
 * @param {import('../lib/fortimonitor-client.js').FortimonitorClient} options.client
 * @param {number} [options.concurrency=3]
 * @param {boolean} [options.verbose=false]
 * @param {number} [options.maxAttempts=3]
 * @param {(index:number, entry:object) => void} [options.onEntryStart]
 * @param {(index:number, result:EntryResult) => void} [options.onEntryDone]
 * @param {(attemptIndex:number, entry:object, error:any) => void} [options.onAttemptFail]
 * @param {AbortSignal} [options.signal]
 * @param {(ms:number) => Promise<void>} [options.sleep]
 * @param {(attemptIndex:number) => number} [options.backoff]
 */
export async function executeQueue(entries, {
  client,
  concurrency = 3,
  verbose = false,
  maxAttempts = 3,
  onEntryStart,
  onEntryDone,
  onAttemptFail,
  signal,
  sleep,
  backoff = backoffDelayMs
} = {}) {
  if (!client) throw new TypeError('executeQueue requires a client');
  if (!Array.isArray(entries)) throw new TypeError('executeQueue: entries must be an array');

  const effectiveConcurrency = verbose ? 1 : concurrency;

  const work = entries.map((e, originalIndex) => ({ entry: e, originalIndex }));
  const pending = work.filter(({ entry }) =>
    entry.status !== 'succeeded' && entry.status !== 'skipped'
  );

  const pendingResults = await mapConcurrent(pending, async ({ entry, originalIndex }) => {
    onEntryStart?.(originalIndex, entry);
    let attempts = 0;
    try {
      const value = await withRetry(
        async (attempt) => {
          attempts = attempt + 1;
          return client.savePortSelection({
            serverId: entry.serverId,
            portSelectionType: entry.intendedAction?.portSelectionType ?? 'manual',
            selectedIndices: entry.intendedAction?.selectedIndices ?? [],
            totalPortCount: entry.intendedAction?.totalPortCount,
            searchTerm: entry.intendedAction?.searchTerm ?? '',
            filters: entry.intendedAction?.filters ?? []
          });
        },
        {
          maxAttempts,
          shouldRetry: (err) => {
            onAttemptFail?.(attempts - 1, entry, err);
            return isRetryable(err);
          },
          backoff,
          sleep,
          signal
        }
      );
      const out = { entry, status: 'succeeded', value, attempts };
      onEntryDone?.(originalIndex, out);
      return out;
    } catch (reason) {
      const out = { entry, status: 'failed', reason, attempts };
      onEntryDone?.(originalIndex, out);
      return out;
    }
  }, { concurrency: effectiveConcurrency, signal });

  // mapConcurrent returns per-item { status, value|reason }. Our fn above
  // never throws - it captures failure in the return value - so every
  // result here is 'fulfilled'.
  return pendingResults.map((r) => r.value);
}
