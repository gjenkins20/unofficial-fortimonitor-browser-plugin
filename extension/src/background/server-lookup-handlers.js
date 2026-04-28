// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Background-side handlers for the Server Lookup tool (FMN-113).
//
// Pattern mirrors fabric-connection-handlers.js: pure factory that
// returns a { messageType: handler } map. The service worker merges
// this into the main router.
//
// Auth: API key via createProductionPanoptaClient (same as fabric).
// All lookups are read-only - no destructive operations here.
//
// Entry shapes accepted by lookup:server-ids:
//   { kind: 'url',  raw, serverId }   -> resolved without /server lookup
//   { kind: 'id',   raw, serverId }   -> resolved without /server lookup
//   { kind: 'name', raw, name }       -> exact-match against /server
//
// Legacy shape (string array of names, old UI) is still accepted: each
// string is wrapped into a name-kind entry. This keeps the message type
// stable for the popup-via-bare-strings path during the FMN-113 rollout.
//
// When confirm=true, URL/ID entries also fire GET /server/{id} to verify
// the ID exists in the tenant. A 404 surfaces as 'not_found'.

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
 * Resolve a name entry against the v2 /server endpoint. Status values:
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
 * Confirm a server ID exists in the tenant via GET /server/{id}. Returns
 * one of:
 *   - { status: 'resolved', serverId, server }
 *   - { status: 'not_found' }
 *   - throws (caller decides to surface as 'error')
 */
export async function confirmServerId(client, serverId) {
  try {
    const server = await client.getServer(serverId);
    return { status: 'resolved', serverId, server };
  } catch (err) {
    if ((err instanceof PanoptaError || err?.name === 'PanoptaError') && err.status === 404) {
      return { status: 'not_found', serverId };
    }
    throw err;
  }
}

/**
 * Normalise the legacy string-list payload into structured entries. New
 * callers should pass entries directly; this is a defensive shim.
 */
function normaliseEntries(payload) {
  if (Array.isArray(payload?.entries) && payload.entries.length >= 0) {
    return payload.entries;
  }
  if (Array.isArray(payload?.names)) {
    return payload.names.map((name) => ({ kind: 'name', raw: String(name), name: String(name) }));
  }
  return [];
}

/**
 * Build the dedup key for fanning unique work onto multiple input rows.
 *   - url/id entries: 'id:N' (so a URL and a raw ID for the same server
 *     coalesce - the upstream parser already dedupes, this is belt+braces)
 *   - name entries:   'name:S'
 */
function dedupKey(entry) {
  if (entry.kind === 'url' || entry.kind === 'id') return `id:${entry.serverId}`;
  return `name:${entry.name}`;
}

/**
 * Resolve a list of structured entries. Names are deduplicated so one API
 * call covers every input that asked for the same name; same goes for IDs.
 *
 * @param {object} params
 * @param {Array<object>} params.entries
 * @param {object} params.client
 * @param {boolean} [params.confirm=false]    - GET /server/{id} for url/id entries
 * @param {number} [params.concurrency=4]
 * @param {number} [params.maxAttempts=3]
 * @param {AbortSignal} [params.signal]
 * @param {(i:number, label:string, kind:string) => void} [params.onEntryStart]
 * @param {(i:number, result:object) => void} [params.onEntryDone]
 */
export async function lookupBatch({
  entries,
  client,
  confirm = false,
  concurrency = 4,
  maxAttempts = 3,
  signal,
  onEntryStart,
  onEntryDone,
  sleep,
  backoff = backoffDelayMs
} = {}) {
  if (!Array.isArray(entries)) throw new TypeError('lookupBatch: entries must be an array');
  if (!client) throw new TypeError('lookupBatch: client is required');

  // Dedup while preserving first-seen order so the original input order
  // is preserved on the way out. Each unique entry is resolved once and
  // its result is fanned to every original index.
  const uniqueEntries = [];
  const indexByKey = new Map();
  const inputToUnique = entries.map((e) => {
    const key = dedupKey(e);
    if (!indexByKey.has(key)) {
      indexByKey.set(key, uniqueEntries.length);
      uniqueEntries.push(e);
    }
    return indexByKey.get(key);
  });

  const labelOf = (e) => e.kind === 'name' ? e.name : (e.raw ?? `id ${e.serverId}`);

  const uniqueResults = await mapConcurrent(uniqueEntries, async (entry, i) => {
    onEntryStart?.(i, labelOf(entry), entry.kind);
    try {
      const result = await withRetry(
        async () => {
          if (entry.kind === 'name') {
            return await lookupOne(client, entry.name);
          }
          // url or id
          if (!confirm) {
            return { raw: entry.raw, kind: entry.kind, status: 'resolved', serverId: entry.serverId, matches: [] };
          }
          const r = await confirmServerId(client, entry.serverId);
          if (r.status === 'resolved') {
            return { raw: entry.raw, kind: entry.kind, status: 'resolved', serverId: entry.serverId, matches: [{ id: entry.serverId }] };
          }
          return { raw: entry.raw, kind: entry.kind, status: 'not_found', serverId: entry.serverId, matches: [] };
        },
        { maxAttempts, shouldRetry: isRetryable, backoff, sleep, signal }
      );
      // Annotate name entries with the source kind/raw so the UI can render
      // a Source column without consulting the input separately.
      const annotated = entry.kind === 'name'
        ? { raw: entry.raw, kind: 'name', ...result }
        : result;
      onEntryDone?.(i, annotated);
      return annotated;
    } catch (reason) {
      const result = {
        raw: entry.raw,
        kind: entry.kind,
        name: entry.kind === 'name' ? entry.name : null,
        serverId: entry.kind === 'name' ? null : entry.serverId,
        status: 'error',
        error: reason?.message ?? String(reason),
        errorStatus: reason?.status ?? null,
        matches: []
      };
      onEntryDone?.(i, result);
      return result;
    }
  }, { concurrency, signal });

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
        const entries = normaliseEntries(payload);
        const results = await lookupBatch({
          entries,
          client,
          confirm: payload?.confirm === true,
          concurrency: payload?.concurrency ?? 4,
          maxAttempts: payload?.maxAttempts ?? 3,
          signal: ac.signal,
          onEntryStart: (i, label, kind) => emit('lookup:entry-start', { index: i, name: label, kind }),
          onEntryDone: (i, result) => emit('lookup:entry-done', {
            index: i,
            name: result.name ?? result.raw ?? null,
            kind: result.kind ?? null,
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
