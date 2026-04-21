// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Background-side handlers for the Server Name → ID Lookup tool.
//
// Pattern mirrors fabric-connection-handlers.js: pure factory that
// returns a { messageType: handler } map. The service worker merges
// this into the main router.
//
// Auth: API key via createProductionPanoptaClient (same as fabric).
// All lookups are read-only - no destructive operations here.

import {
  createProductionPanoptaClient,
  PanoptaError
} from '../lib/panopta-client.js';
import { mapConcurrent } from '../lib/concurrency.js';
import { withRetry, backoffDelayMs } from '../lib/retry.js';

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryable(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  if (err instanceof PanoptaError || err?.name === 'PanoptaError') {
    if (err.phase === 'auth') return false;
    if (err.status === null || err.status === undefined) return true;
    return RETRYABLE_STATUSES.has(err.status);
  }
  return true;
}

/**
 * Resolve a single name to a lookup result. Status values:
 *   - 'found'     - exactly one server matched
 *   - 'not_found' - zero servers matched
 *   - 'ambiguous' - 2+ servers matched (caller surfaces all candidates)
 *   - 'error'     - request failed after retries
 */
export async function lookupOne(client, name) {
  const matches = await client.lookupServersByName(name);
  if (matches.length === 0) return { name, status: 'not_found', matches: [] };
  if (matches.length === 1) {
    return { name, status: 'found', serverId: matches[0].id, matches };
  }
  return { name, status: 'ambiguous', matches };
}

/**
 * Batch-resolve a list of names. Dedupes input (a name appearing twice
 * costs one API call, both inputs share the result). Bounded concurrency
 * with retry on transient failures.
 *
 * @param {object} params
 * @param {string[]} params.names
 * @param {object} params.client
 * @param {number} [params.concurrency=4]
 * @param {number} [params.maxAttempts=3]
 * @param {AbortSignal} [params.signal]
 * @param {(i:number, name:string) => void} [params.onEntryStart]
 * @param {(i:number, result:object) => void} [params.onEntryDone]
 */
export async function lookupBatch({
  names,
  client,
  concurrency = 4,
  maxAttempts = 3,
  signal,
  onEntryStart,
  onEntryDone,
  sleep,
  backoff = backoffDelayMs
} = {}) {
  if (!Array.isArray(names)) throw new TypeError('lookupBatch: names must be an array');
  if (!client) throw new TypeError('lookupBatch: client is required');

  // Dedupe while preserving the first-seen order, so the user can still
  // map results back to their input. We resolve each unique name once,
  // then fan the result out to every original index that requested it.
  const uniqueNames = [];
  const indexByName = new Map();
  const inputToUnique = names.map((n) => {
    if (!indexByName.has(n)) {
      indexByName.set(n, uniqueNames.length);
      uniqueNames.push(n);
    }
    return indexByName.get(n);
  });

  const uniqueResults = await mapConcurrent(uniqueNames, async (name, i) => {
    onEntryStart?.(i, name);
    try {
      const result = await withRetry(
        () => lookupOne(client, name),
        { maxAttempts, shouldRetry: isRetryable, backoff, sleep, signal }
      );
      onEntryDone?.(i, result);
      return result;
    } catch (reason) {
      const result = {
        name,
        status: 'error',
        error: reason?.message ?? String(reason),
        errorStatus: reason?.status ?? null
      };
      onEntryDone?.(i, result);
      return result;
    }
  }, { concurrency, signal });

  // Fan unique results back out across the original input order.
  return inputToUnique.map((u) => uniqueResults[u].value);
}

/**
 * Build the message handlers map. Service worker merges this into the
 * main router alongside port-scope and fabric-connection handlers.
 */
export function createServerLookupHandlers({ events = {}, getClient } = {}) {
  const emit = events.emit ?? (() => {});
  const factory = getClient ?? (() => createProductionPanoptaClient());

  let currentRun = null;

  return {
    'lookup:server-ids': async (payload) => {
      if (currentRun) throw new Error('A server-lookup batch is already running');
      const ac = new AbortController();
      currentRun = { ac, startedAt: new Date().toISOString() };
      try {
        const client = await factory();
        const results = await lookupBatch({
          names: payload?.names ?? [],
          client,
          concurrency: payload?.concurrency ?? 4,
          maxAttempts: payload?.maxAttempts ?? 3,
          signal: ac.signal,
          onEntryStart: (i, name) => emit('lookup:entry-start', { index: i, name }),
          onEntryDone: (i, result) => emit('lookup:entry-done', {
            index: i,
            name: result.name,
            status: result.status,
            serverId: result.serverId ?? null,
            matchCount: result.matches?.length ?? 0,
            error: result.error ?? null
          })
        });
        return { results, startedAt: currentRun.startedAt, finishedAt: new Date().toISOString() };
      } finally {
        currentRun = null;
      }
    },

    'lookup:abort': async () => {
      if (!currentRun) return { aborted: false, reason: 'no active run' };
      currentRun.ac.abort();
      return { aborted: true };
    }
  };
}
