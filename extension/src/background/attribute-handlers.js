// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Background-side handlers for the Manage Server Attributes (Bulk) tool.
//
// Pattern mirrors fabric-connection-handlers.js: a factory that returns
// { messageType: handler } maps, merged into the main router by the
// service worker.
//
// Three main operations surfaced to the UI:
//   * attr:list-types          - populate the type dropdown
//   * attr:plan-batch          - resolve names→ids, fetch current values,
//                                produce a per-row preview plan
//   * attr:execute-batch       - apply the plan (add/replace/delete),
//                                emit progress, return results
//   * attr:abort               - cancel in-flight execute

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

// A numeric-id target skips name resolution. Operator can paste either.
function looksLikeId(s) {
  return /^\d+$/.test(String(s).trim());
}

/**
 * Resolve a list of server names/ids into target rows. Preserves input
 * order. Dedupes identical entries (one lookup per unique name). Each row
 * is either resolved (serverId + displayName) or tagged with a resolution
 * error.
 */
export async function resolveTargets({ entries, client, concurrency = 4, signal }) {
  if (!Array.isArray(entries)) throw new TypeError('resolveTargets: entries must be an array');

  const unique = [];
  const idxByEntry = new Map();
  const inputToUnique = entries.map((raw) => {
    const key = String(raw).trim();
    if (!idxByEntry.has(key)) {
      idxByEntry.set(key, unique.length);
      unique.push(key);
    }
    return idxByEntry.get(key);
  });

  const resolved = await mapConcurrent(unique, async (entry) => {
    if (entry === '') return { input: entry, status: 'error', error: 'Empty line' };
    if (looksLikeId(entry)) {
      return { input: entry, status: 'resolved', serverId: Number(entry), displayName: entry };
    }
    try {
      const matches = await client.lookupServersByName(entry);
      if (matches.length === 0) return { input: entry, status: 'error', error: 'Name not found' };
      if (matches.length > 1) return { input: entry, status: 'error', error: `Ambiguous - ${matches.length} matches` };
      return { input: entry, status: 'resolved', serverId: matches[0].id, displayName: matches[0].name };
    } catch (reason) {
      return {
        input: entry,
        status: 'error',
        error: reason?.message ?? String(reason),
        errorStatus: reason?.status ?? null
      };
    }
  }, { concurrency, signal });

  return inputToUnique.map((u) => resolved[u].value);
}

/**
 * Build the per-row plan as the cross-product of (target × attribute).
 * For each resolved target, fetch its current attributes once, then
 * iterate the requested attributes locally and decide add / replace /
 * remove / skip per (server, attribute). Unresolved targets pass through
 * as error rows for every attribute.
 *
 * Each input attribute is { operation, typeUrl, typeName?, value? } where
 *   - operation = 'set'    : ensure typeUrl has `value` on the server
 *   - operation = 'remove' : drop typeUrl from the server (value ignored)
 *
 * Each output row carries `attrIndex` (its index in the input array) and
 * `typeUrl` so executeBatch and the UI can disambiguate when one server
 * appears multiple times in the plan.
 */
export async function planBatch({
  targets,
  attributes,
  client,
  concurrency = 4,
  signal,
  onEntryStart,
  onEntryDone
} = {}) {
  if (!Array.isArray(attributes) || attributes.length === 0) {
    throw new TypeError('planBatch: attributes must be a non-empty array');
  }
  for (let ai = 0; ai < attributes.length; ai++) {
    const a = attributes[ai];
    if (a.operation !== 'set' && a.operation !== 'remove') {
      throw new TypeError(`planBatch: attributes[${ai}].operation must be 'set' or 'remove'`);
    }
    if (!a.typeUrl) {
      throw new TypeError(`planBatch: attributes[${ai}].typeUrl is required`);
    }
    if (a.operation === 'set' && (a.value === undefined || a.value === null)) {
      throw new TypeError(`planBatch: attributes[${ai}].value is required when operation='set'`);
    }
  }

  // One snapshot fetch per resolved target, regardless of how many
  // attributes we are mutating on it.
  const snapshots = await mapConcurrent(targets, async (t) => {
    if (t.status !== 'resolved') return { target: t, attrs: null, snapshotError: null };
    try {
      const attrs = await client.listServerAttributes(t.serverId);
      return { target: t, attrs, snapshotError: null };
    } catch (reason) {
      return {
        target: t,
        attrs: null,
        snapshotError: {
          message: reason?.message ?? String(reason),
          status: reason?.status ?? null
        }
      };
    }
  }, { concurrency, signal });

  const out = [];
  let rowIndex = 0;
  for (let ti = 0; ti < targets.length; ti++) {
    const snap = snapshots[ti].value;
    const t = snap.target;
    for (let ai = 0; ai < attributes.length; ai++) {
      const a = attributes[ai];
      onEntryStart?.(rowIndex, t, ai);

      const base = {
        ...t,
        attrIndex: ai,
        typeUrl: a.typeUrl,
        typeName: a.typeName ?? null,
        operation: a.operation,
        newValue: a.operation === 'set' ? String(a.value) : null
      };

      if (t.status !== 'resolved') {
        const row = { ...base, plan: 'error' };
        onEntryDone?.(rowIndex, row);
        out.push(row);
        rowIndex++;
        continue;
      }
      if (snap.snapshotError) {
        const row = {
          ...base,
          plan: 'error',
          error: snap.snapshotError.message,
          errorStatus: snap.snapshotError.status
        };
        onEntryDone?.(rowIndex, row);
        out.push(row);
        rowIndex++;
        continue;
      }

      const existing = snap.attrs.find((x) => x.typeUrl === a.typeUrl) ?? null;
      const row = { ...base, existing, plan: 'pending' };
      if (a.operation === 'set') {
        if (!existing) row.plan = 'add';
        else if (existing.value === String(a.value)) row.plan = 'skip';
        else row.plan = 'replace';
      } else if (a.operation === 'remove') {
        row.plan = existing ? 'remove' : 'skip';
      }
      onEntryDone?.(rowIndex, row);
      out.push(row);
      rowIndex++;
    }
  }

  return out;
}

/**
 * Apply the plan. For each row:
 *   * 'add'     → POST attribute value
 *   * 'replace' → DELETE existing, then POST new
 *   * 'remove'  → DELETE existing
 *   * 'skip' / 'error' → no-op, surfaced in results
 *
 * Each row carries its own `typeUrl` (set by planBatch) so a multi-
 * attribute plan can target different attribute types per row without
 * the caller plumbing them through.
 *
 * Retry on transient 5xx / rate limits. Abort aware.
 */
export async function executeBatch({
  plan,
  client,
  concurrency = 2,
  maxAttempts = 3,
  signal,
  onEntryStart,
  onEntryDone,
  sleep,
  backoff = backoffDelayMs
} = {}) {
  if (!Array.isArray(plan)) throw new TypeError('executeBatch: plan must be an array');
  if (!client) throw new TypeError('executeBatch: client is required');

  const settled = await mapConcurrent(plan, async (row, i) => {
    onEntryStart?.(i, row);

    if (row.plan === 'skip' || row.plan === 'error') {
      const res = { ...row, status: row.plan === 'skip' ? 'skipped' : 'error' };
      onEntryDone?.(i, res);
      return res;
    }

    if (!row.typeUrl) {
      const res = {
        ...row,
        status: 'failed',
        error: 'plan row missing typeUrl'
      };
      onEntryDone?.(i, res);
      return res;
    }

    try {
      const result = await withRetry(async () => {
        if (row.plan === 'add') {
          const out = await client.createServerAttribute(row.serverId, { typeUrl: row.typeUrl, value: row.newValue });
          return { created: out.resourceId ?? null, deleted: null };
        }
        if (row.plan === 'replace') {
          if (!row.existing?.resourceUrl) throw new Error('Replace row missing existing resourceUrl');
          await client.deleteServerAttribute(row.existing.resourceUrl);
          const out = await client.createServerAttribute(row.serverId, { typeUrl: row.typeUrl, value: row.newValue });
          return { created: out.resourceId ?? null, deleted: row.existing.id };
        }
        if (row.plan === 'remove') {
          if (!row.existing?.resourceUrl) throw new Error('Remove row missing existing resourceUrl');
          await client.deleteServerAttribute(row.existing.resourceUrl);
          return { created: null, deleted: row.existing.id };
        }
        throw new Error(`Unknown plan: ${row.plan}`);
      }, { maxAttempts, shouldRetry: isRetryable, backoff, sleep, signal });

      const res = { ...row, status: 'succeeded', ...result };
      onEntryDone?.(i, res);
      return res;
    } catch (reason) {
      const res = {
        ...row,
        status: 'failed',
        error: reason?.message ?? String(reason),
        errorStatus: reason?.status ?? null,
        errorBody: reason?.responseBody ?? null
      };
      onEntryDone?.(i, res);
      return res;
    }
  }, { concurrency, signal });

  return settled.map((r) => r.value);
}

/**
 * Build the message handlers map. Service worker merges this into the
 * main router.
 */
export function createAttributeHandlers({ events = {}, getClient } = {}) {
  const emit = events.emit ?? (() => {});
  const factory = getClient ?? (() => createProductionPanoptaClient());

  let currentRun = null;

  return {
    'attr:list-types': async () => {
      const client = await factory();
      return await client.listAttributeTypes();
    },

    'attr:plan-batch': async (payload = {}) => {
      const client = await factory();
      const ac = new AbortController();
      // Backward-compatible: accept either `attributes` (array) or the
      // legacy single-attribute shape (operation/typeUrl/value/typeName).
      const attributes = Array.isArray(payload.attributes) && payload.attributes.length > 0
        ? payload.attributes
        : [{
            operation: payload.operation,
            typeUrl: payload.typeUrl,
            typeName: payload.typeName ?? null,
            value: payload.value
          }];
      const targets = await resolveTargets({
        entries: payload.entries ?? [],
        client,
        concurrency: payload.resolveConcurrency ?? 4,
        signal: ac.signal
      });
      const plan = await planBatch({
        targets,
        attributes,
        client,
        concurrency: payload.planConcurrency ?? 4,
        signal: ac.signal,
        onEntryStart: (i, t, ai) => emit('attr:plan-start', { index: i, input: t.input, attrIndex: ai }),
        onEntryDone: (i, row) => emit('attr:plan-done', {
          index: i,
          input: row.input,
          attrIndex: row.attrIndex,
          plan: row.plan,
          serverId: row.serverId ?? null,
          displayName: row.displayName ?? null,
          currentValue: row.existing?.value ?? null,
          newValue: row.newValue ?? null,
          typeUrl: row.typeUrl ?? null,
          typeName: row.typeName ?? null,
          error: row.error ?? null
        })
      });
      return { plan };
    },

    'attr:execute-batch': async (payload = {}) => {
      if (currentRun) throw new Error('An attribute batch is already running');
      const ac = new AbortController();
      currentRun = { ac, startedAt: new Date().toISOString() };
      try {
        const client = await factory();
        const results = await executeBatch({
          plan: payload.plan ?? [],
          client,
          concurrency: payload.concurrency ?? 2,
          maxAttempts: payload.maxAttempts ?? 3,
          signal: ac.signal,
          onEntryStart: (i, row) => emit('attr:exec-start', {
            index: i,
            input: row.input,
            attrIndex: row.attrIndex ?? 0
          }),
          onEntryDone: (i, res) => emit('attr:exec-done', {
            index: i,
            input: res.input,
            attrIndex: res.attrIndex ?? 0,
            status: res.status,
            plan: res.plan,
            createdId: res.created ?? null,
            deletedId: res.deleted ?? null,
            error: res.error ?? null,
            errorStatus: res.errorStatus ?? null
          })
        });
        return { results, startedAt: currentRun.startedAt, finishedAt: new Date().toISOString() };
      } finally {
        currentRun = null;
      }
    },

    'attr:abort': async () => {
      if (!currentRun) return { aborted: false, reason: 'no active run' };
      currentRun.ac.abort();
      return { aborted: true };
    }
  };
}
