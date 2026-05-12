// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155: background handlers for the Bulk Action Composer.
//
// Surfaces:
//   bulk-composer:list-templates  - for the Apply Template action picker
//   bulk-composer:commit          - run committed plan with bounded concurrency
//   bulk-composer:abort           - cancel in-flight commit
//   bulk-composer:save-draft      - persist mid-wizard state to chrome.storage.local
//   bulk-composer:load-draft      - read the most recent draft (single slot)
//   bulk-composer:clear-draft     - remove the saved draft
//   bulk-composer:current-selection - read selected server ids stashed by
//                                     a content-script selection-handoff
//
// The composer's preview step is a pure-client computation (each action's
// describe()) so we don't expose a "preview" message - the UI computes it
// directly from the cached omni-search entries.

import {
  createProductionPanoptaClient,
  PanoptaError
} from '../lib/panopta-client.js';
import { mapConcurrent } from '../lib/concurrency.js';
import { getAction } from '../lib/bulk-actions/index.js';

const DRAFT_STORAGE_KEY = 'fm:bulkDrafts';
const SELECTION_STORAGE_KEY = 'fm:bulkComposerSelection';
const DEFAULT_CONCURRENCY = 3;
const MAX_TARGETS = 500;

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRetryable(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  if (err instanceof PanoptaError || err?.name === 'PanoptaError') {
    if (err.phase === 'auth') return false;
    if (err.status === null || err.status === undefined) return true;
    return RETRYABLE_STATUSES.has(err.status);
  }
  return true;
}

export function createBulkComposerHandlers({ events = {}, getClient } = {}) {
  const emit = events.emit ?? (() => {});
  const factory = getClient ?? (() => createProductionPanoptaClient());
  let currentRun = null;

  return {
    'bulk-composer:list-templates': async () => {
      const client = await factory();
      return await client.listTemplates();
    },

    'bulk-composer:commit': async (payload = {}) => {
      if (currentRun) throw new Error('A bulk-composer run is already in progress.');
      const actionId = String(payload?.actionId ?? '');
      const action = getAction(actionId);
      if (!action) throw new Error(`Unknown action: ${actionId || '(empty)'}`);
      const params = payload?.params ?? {};
      const targets = Array.isArray(payload?.targets) ? payload.targets : [];
      if (targets.length === 0) throw new Error('No targets selected.');
      if (targets.length > MAX_TARGETS) {
        throw new Error(`Too many targets (${targets.length}); max ${MAX_TARGETS} per run.`);
      }
      const validation = action.validate?.(params);
      if (validation && validation.ok === false) {
        throw new Error(`Invalid action params: ${validation.error}`);
      }

      const concurrency = Math.max(1, Math.min(10, payload?.concurrency || DEFAULT_CONCURRENCY));
      const ac = new AbortController();
      currentRun = { ac, startedAt: new Date().toISOString() };

      try {
        const client = await factory();
        const settled = await mapConcurrent(targets, async (target, i) => {
          emit('bulk-composer:row-start', { index: i, id: target?.id, name: target?.name });
          try {
            const result = await action.commit(target, params, { client });
            emit('bulk-composer:row-done', {
              index: i, id: target?.id, name: target?.name,
              status: 'succeeded',
              noop: !!result?.noop,
              detail: result
            });
            return { id: target?.id, name: target?.name, status: 'succeeded', noop: !!result?.noop, detail: result };
          } catch (err) {
            const retryable = isRetryable(err);
            emit('bulk-composer:row-done', {
              index: i, id: target?.id, name: target?.name,
              status: 'failed',
              error: err?.message ?? String(err),
              errorStatus: err?.status ?? null,
              retryable
            });
            return {
              id: target?.id, name: target?.name, status: 'failed',
              error: err?.message ?? String(err),
              errorStatus: err?.status ?? null,
              retryable
            };
          }
        }, { concurrency, signal: ac.signal });
        const rows = settled.map((r) => r.value);
        return {
          actionId, params, rows,
          startedAt: currentRun.startedAt,
          finishedAt: new Date().toISOString(),
          aborted: ac.signal.aborted,
          succeeded: rows.filter((r) => r.status === 'succeeded').length,
          failed: rows.filter((r) => r.status === 'failed').length,
          noops: rows.filter((r) => r.noop).length
        };
      } finally {
        currentRun = null;
      }
    },

    'bulk-composer:abort': async () => {
      if (!currentRun) return { aborted: false, reason: 'no active run' };
      currentRun.ac.abort();
      return { aborted: true };
    },

    'bulk-composer:save-draft': async (payload = {}) => {
      const draft = {
        savedAt: Date.now(),
        actionId: payload?.actionId ?? null,
        params: payload?.params ?? null,
        targetIds: Array.isArray(payload?.targetIds) ? payload.targetIds.slice(0, MAX_TARGETS) : [],
        step: payload?.step ?? null
      };
      try {
        await chrome.storage.local.set({ [DRAFT_STORAGE_KEY]: draft });
        return { ok: true, savedAt: draft.savedAt };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },

    'bulk-composer:load-draft': async () => {
      try {
        const data = await chrome.storage.local.get(DRAFT_STORAGE_KEY);
        return data?.[DRAFT_STORAGE_KEY] ?? null;
      } catch {
        return null;
      }
    },

    'bulk-composer:clear-draft': async () => {
      try {
        await chrome.storage.local.remove(DRAFT_STORAGE_KEY);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },

    'bulk-composer:current-selection': async () => {
      // FMN-155: read the most recent selection stashed by a content
      // script (Phase-2 enhancement plumbs through augment.js; for v1
      // this is a read-only door so the UI's "Load from current page
      // selection" button still has a clear contract.)
      try {
        const data = await chrome.storage.session.get(SELECTION_STORAGE_KEY);
        const stash = data?.[SELECTION_STORAGE_KEY];
        if (!stash || !Array.isArray(stash.ids)) return { ids: [], stashedAt: null };
        return { ids: stash.ids, stashedAt: stash.stashedAt ?? null };
      } catch {
        return { ids: [], stashedAt: null };
      }
    }
  };
}
