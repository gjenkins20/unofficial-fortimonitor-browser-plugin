// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Background-side handlers for the Manage Server Templates (Bulk) tool.
//
// Pattern mirrors attribute-handlers.js: a factory that returns
// { messageType: handler } maps, merged into the main router by the
// service worker.
//
// Message types surfaced to the UI:
//   * tmpl:list-templates      - populate the template picker
//   * tmpl:plan-batch          - resolve names→ids, pre-flight each server,
//                                produce a per-row preview plan
//   * tmpl:execute-batch       - apply the plan (attach/detach), emit
//                                progress, return results
//   * tmpl:abort               - cancel in-flight execute

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

function looksLikeId(s) {
  return /^\d+$/.test(String(s).trim());
}

/**
 * Resolve a list of server names/ids into target rows. Copy of the
 * attribute tool's helper - dedupes identical entries, preserves input
 * order. Kept local (not shared) because the shape of `row` differs
 * between tools and a shared helper would grow flags for each.
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
 * Build the per-row plan.
 *
 * For attach: check whether the chosen template is already attached to
 *   the server. If yes → skip (prevents duplicate mapping - the API
 *   does NOT dedupe on its own). If no → attach.
 * For detach: check whether the chosen template is currently attached.
 *   If no → skip. If yes → detach. Strategy=delete escalates the plan
 *   label to 'destroy' so the UI can style it as destructive.
 */
export async function planBatch({
  targets,
  operation,
  templateUrl,
  templateId,
  strategy = 'dissociate',
  client,
  concurrency = 4,
  signal,
  onEntryStart,
  onEntryDone
} = {}) {
  if (operation !== 'attach' && operation !== 'detach') {
    throw new TypeError(`planBatch: operation must be 'attach' or 'detach'`);
  }
  if (!templateUrl) throw new TypeError('planBatch: templateUrl is required');
  if (operation === 'detach' && !templateId) {
    throw new TypeError('planBatch: templateId is required for detach');
  }

  const results = await mapConcurrent(targets, async (t, i) => {
    onEntryStart?.(i, t);
    if (t.status !== 'resolved') {
      const row = { ...t, plan: 'error' };
      onEntryDone?.(i, row);
      return row;
    }
    try {
      const mappings = await client.listServerTemplateMappings(t.serverId);
      const attached = mappings.find((m) => m.templateUrl === templateUrl) ?? null;
      const row = { ...t, attached, plan: 'pending' };

      if (operation === 'attach') {
        row.plan = attached ? 'skip' : 'attach';
      } else {
        if (!attached) row.plan = 'skip';
        else row.plan = strategy === 'delete' ? 'destroy' : 'detach';
      }
      onEntryDone?.(i, row);
      return row;
    } catch (reason) {
      const row = {
        ...t,
        plan: 'error',
        error: reason?.message ?? String(reason),
        errorStatus: reason?.status ?? null
      };
      onEntryDone?.(i, row);
      return row;
    }
  }, { concurrency, signal });

  return results.map((r) => r.value);
}

/**
 * Apply the plan. Per row:
 *   * 'attach'  → POST /server/{id}/template
 *   * 'detach'  → DELETE /server/{id}/template/{templateId} strategy=dissociate
 *   * 'destroy' → DELETE /server/{id}/template/{templateId} strategy=delete
 *   * 'skip' / 'error' → no-op, surfaced in results
 *
 * Retry on transient 5xx / rate limits. Abort-aware.
 */
export async function executeBatch({
  plan,
  templateUrl,
  templateId,
  continuous = true,
  strategy = 'dissociate',
  client,
  concurrency = 4,
  maxAttempts = 3,
  signal,
  onEntryStart,
  onEntryDone,
  sleep,
  backoff = backoffDelayMs
} = {}) {
  if (!Array.isArray(plan)) throw new TypeError('executeBatch: plan must be an array');
  if (!client) throw new TypeError('executeBatch: client is required');
  if (!templateUrl) throw new TypeError('executeBatch: templateUrl is required');

  const settled = await mapConcurrent(plan, async (row, i) => {
    onEntryStart?.(i, row);

    if (row.plan === 'skip' || row.plan === 'error') {
      const res = { ...row, status: row.plan === 'skip' ? 'skipped' : 'error' };
      onEntryDone?.(i, res);
      return res;
    }

    try {
      const result = await withRetry(async () => {
        if (row.plan === 'attach') {
          const out = await client.attachTemplate(row.serverId, { templateUrl, continuous });
          return { mappingId: out.resourceId ?? null, templateId };
        }
        if (row.plan === 'detach') {
          await client.detachTemplate(row.serverId, templateId, { strategy: 'dissociate' });
          return { mappingId: null, templateId };
        }
        if (row.plan === 'destroy') {
          await client.detachTemplate(row.serverId, templateId, { strategy: 'delete' });
          return { mappingId: null, templateId };
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
export function createTemplateHandlers({ events = {}, getClient } = {}) {
  const emit = events.emit ?? (() => {});
  const factory = getClient ?? (() => createProductionPanoptaClient());

  let currentRun = null;

  return {
    'tmpl:list-templates': async () => {
      const client = await factory();
      return await client.listTemplates();
    },

    'tmpl:plan-batch': async (payload = {}) => {
      const client = await factory();
      const ac = new AbortController();
      const targets = await resolveTargets({
        entries: payload.entries ?? [],
        client,
        concurrency: payload.resolveConcurrency ?? 4,
        signal: ac.signal
      });
      const plan = await planBatch({
        targets,
        operation: payload.operation,
        templateUrl: payload.templateUrl,
        templateId: payload.templateId,
        strategy: payload.strategy ?? 'dissociate',
        client,
        concurrency: payload.planConcurrency ?? 4,
        signal: ac.signal,
        onEntryStart: (i, t) => emit('tmpl:plan-start', { index: i, input: t.input }),
        onEntryDone: (i, row) => emit('tmpl:plan-done', {
          index: i,
          input: row.input,
          plan: row.plan,
          serverId: row.serverId ?? null,
          displayName: row.displayName ?? null,
          attached: row.attached ?? null,
          error: row.error ?? null
        })
      });
      return { plan };
    },

    'tmpl:execute-batch': async (payload = {}) => {
      if (currentRun) throw new Error('A template batch is already running');
      const ac = new AbortController();
      currentRun = { ac, startedAt: new Date().toISOString() };
      try {
        const client = await factory();
        const results = await executeBatch({
          plan: payload.plan ?? [],
          templateUrl: payload.templateUrl,
          templateId: payload.templateId,
          continuous: payload.continuous ?? true,
          strategy: payload.strategy ?? 'dissociate',
          client,
          concurrency: payload.concurrency ?? 4,
          maxAttempts: payload.maxAttempts ?? 3,
          signal: ac.signal,
          onEntryStart: (i, row) => emit('tmpl:exec-start', { index: i, input: row.input }),
          onEntryDone: (i, res) => emit('tmpl:exec-done', {
            index: i,
            input: res.input,
            status: res.status,
            plan: res.plan,
            mappingId: res.mappingId ?? null,
            templateId: res.templateId ?? null,
            error: res.error ?? null,
            errorStatus: res.errorStatus ?? null
          })
        });
        return { results, startedAt: currentRun.startedAt, finishedAt: new Date().toISOString() };
      } finally {
        currentRun = null;
      }
    },

    'tmpl:abort': async () => {
      if (!currentRun) return { aborted: false, reason: 'no active run' };
      currentRun.ac.abort();
      return { aborted: true };
    }
  };
}
