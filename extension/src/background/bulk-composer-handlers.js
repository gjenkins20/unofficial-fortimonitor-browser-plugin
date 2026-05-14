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
// FMN-196 additions (Stock Fabric Templates action):
//   bulk-composer:list-fabric-system-data    - batch /report/get_idp_data
//   bulk-composer:list-monitoring-policy-vocab - GET /monitoring_policy/get_page_data
//   bulk-composer:list-templates-with-groups - PanoptaClient.listTemplates() + group enrichment
//
// The composer's preview step is a pure-client computation (each action's
// describe()) so we don't expose a "preview" message - the UI computes it
// directly from the cached omni-search entries.

import {
  createProductionPanoptaClient,
  PanoptaError
} from '../lib/panopta-client.js';
import { createProductionClient as createProductionFortimonitorClient } from '../lib/fortimonitor-client.js';
import { mapConcurrent } from '../lib/concurrency.js';
import { getAction } from '../lib/bulk-actions/index.js';
import { ensureTemplate } from '../lib/template-ensurer.js';

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

export function createBulkComposerHandlers({ events = {}, getClient, getFortimonitorClient } = {}) {
  const emit = events.emit ?? (() => {});
  const factory = getClient ?? (() => createProductionPanoptaClient());
  const fmFactory = getFortimonitorClient ?? (() => createProductionFortimonitorClient());
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
        // FMN-196: per-run shared state lets actions memoize per-profile
        // preflight work (e.g. policy create) across per-target commit
        // calls. Older actions ignore the extra ctx fields.
        const fortimonitorClient = await fmFactory();
        const sharedState = new Map();
        const settled = await mapConcurrent(targets, async (target, i) => {
          emit('bulk-composer:row-start', { index: i, id: target?.id, name: target?.name });
          try {
            const result = await action.commit(target, params, { client, fortimonitorClient, sharedState });
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
    },

    // ---------------- FMN-206 fetch handlers ----------------

    /**
     * Batch-fetch the current tag list for a set of server ids by hitting
     * v2 GET /server/{id}. Returns a map keyed by id; failures map to
     * null and the caller treats null as "tags unknown" (the Remove Tag
     * chip UI just omits that server from its aggregation). Used as a
     * fallback when the omni-search cache doesn't cover all picked IDs.
     *
     * Concurrency capped to keep the v2 API happy.
     */
    'bulk-composer:list-tags-batch': async (payload = {}) => {
      const ids = Array.isArray(payload?.serverIds) ? payload.serverIds.slice(0, MAX_TARGETS) : [];
      if (ids.length === 0) return { byServerId: {} };
      const client = await factory();
      const concurrency = Math.max(1, Math.min(10, payload?.concurrency || DEFAULT_CONCURRENCY));
      const settled = await mapConcurrent(ids, async (id) => {
        try {
          const server = await client.getServer(id);
          return { id, tags: Array.isArray(server?.tags) ? server.tags : [] };
        } catch {
          return { id, tags: null };
        }
      }, { concurrency });
      const byServerId = {};
      for (const r of settled) {
        if (r.status === 'fulfilled') byServerId[r.value.id] = r.value.tags;
      }
      return { byServerId };
    },

    // ---------------- FMN-196 fetch handlers ----------------

    /**
     * Batch-fetch fabricSystemData for a list of server ids. Returns a
     * map keyed by server id. Servers without fabricSystemData (non-
     * Fortinet or unauthenticated) get null entries. Used by the
     * Stock Fabric Templates action's Configure step to classify picked
     * devices.
     *
     * Concurrency capped to keep the live tenant happy.
     */
    'bulk-composer:list-fabric-system-data': async (payload = {}) => {
      const ids = Array.isArray(payload?.serverIds) ? payload.serverIds.slice(0, MAX_TARGETS) : [];
      if (ids.length === 0) return { byServerId: {} };
      const fmClient = await fmFactory();
      const concurrency = Math.max(1, Math.min(10, payload?.concurrency || DEFAULT_CONCURRENCY));
      const settled = await mapConcurrent(ids, async (id) => {
        try {
          const fsd = await fmClient.getFabricSystemData(id);
          return { id, fsd };
        } catch {
          return { id, fsd: null };
        }
      }, { concurrency });
      const byServerId = {};
      for (const r of settled) {
        if (r.status === 'fulfilled') byServerId[r.value.id] = r.value.fsd;
      }
      return { byServerId };
    },

    /**
     * One-shot fetch of /monitoring_policy/get_page_data. Returns the
     * fields the Stock Fabric Templates action's Configure step needs:
     * existing rulesets (for idempotence by-name lookup) and the live
     * nounOptions vocabulary (for the recommendation engine's
     * policy-clause builder).
     */
    'bulk-composer:list-monitoring-policy-vocab': async () => {
      const fmClient = await fmFactory();
      const data = await fmClient.getMonitoringPolicyPageData();
      return {
        rulesets: Array.isArray(data?.rulesets) ? data.rulesets : [],
        nounOptions: data?.nounOptions ?? {}
      };
    },

    // ---------------- FMN-200 fetch handlers ----------------

    /**
     * Batch-fetch get_monitoring_config_data for a list of server (or
     * template) ids. Returns a map keyed by id. Servers whose fetch
     * fails (auth, 404, etc.) get null entries; callers treat null as
     * "no config available" and route to unclassified.
     *
     * Concurrency-capped because the live tenant doesn't enjoy 50
     * parallel reads against the same surface.
     */
    'bulk-composer:list-monitoring-config-batch': async (payload = {}) => {
      const ids = Array.isArray(payload?.serverIds) ? payload.serverIds.slice(0, MAX_TARGETS) : [];
      if (ids.length === 0) return { byServerId: {} };
      const fmClient = await fmFactory();
      const concurrency = Math.max(1, Math.min(10, payload?.concurrency || DEFAULT_CONCURRENCY));
      const settled = await mapConcurrent(ids, async (id) => {
        try {
          const json = await fmClient._getFortimonitorJson(
            `/report/get_monitoring_config_data?server_id=${encodeURIComponent(String(id))}`,
            'monitoring_config'
          );
          // FMN-135 read-shape: { success, categories: { added: [...] }, ... }
          const categories = Array.isArray(json?.categories?.added) ? json.categories.added : [];
          return { id, categories };
        } catch {
          return { id, categories: null };
        }
      }, { concurrency });
      const byServerId = {};
      for (const r of settled) {
        if (r.status === 'fulfilled') byServerId[r.value.id] = r.value.categories;
      }
      return { byServerId };
    },

    /**
     * Batch-fetch getDevicePorts for a list of server ids (FortiGate
     * devices only). Returns a map keyed by id, value = array of
     * selected port indices or null on failure. Non-FortiGate devices
     * naturally fail this fetch with an HTML/error response; we treat
     * those as null (caller's clusterer reads null as "no port scope
     * information" and clusters accordingly).
     */
    'bulk-composer:list-port-scope-batch': async (payload = {}) => {
      const ids = Array.isArray(payload?.serverIds) ? payload.serverIds.slice(0, MAX_TARGETS) : [];
      if (ids.length === 0) return { byServerId: {} };
      const fmClient = await fmFactory();
      const concurrency = Math.max(1, Math.min(10, payload?.concurrency || DEFAULT_CONCURRENCY));
      const settled = await mapConcurrent(ids, async (id) => {
        try {
          const parsed = await fmClient.getDevicePorts(id);
          // parseDevicePortsResponse output: { filter_type, portFilters, ports[{ name, index, isActive, ... }] }
          const selectedIndices = (parsed?.ports || [])
            .filter((p) => p && p.isActive)
            .map((p) => p.index);
          return { id, ports: selectedIndices };
        } catch {
          return { id, ports: null };
        }
      }, { concurrency });
      const byServerId = {};
      for (const r of settled) {
        if (r.status === 'fulfilled') byServerId[r.value.id] = r.value.ports;
      }
      return { byServerId };
    },

    /**
     * FMN-211: fetch the Save-as-Template dialog defaults for one
     * server. Powers per-cluster template_type plumbing (different
     * Fabric device classes return different template_type_options).
     * Input: { serverId }
     * Output: { defaults: { template_type_options, ... } | null }
     */
    'bulk-composer:get-create-template-defaults': async (payload = {}) => {
      const serverId = payload?.serverId;
      if (serverId === undefined || serverId === null) return { defaults: null };
      const fmClient = await fmFactory();
      try {
        const defaults = await fmClient.getCreateTemplateDefaults(serverId);
        return { defaults };
      } catch {
        return { defaults: null };
      }
    },

    /**
     * Idempotent create-and-populate for a Stock template.
     *
     * Input: { name, templateType, destinationGroup, sourceServerId?,
     *          resources: [{ plugin_textkey, resource_textkey, name,
     *                        units? }, ...],
     *          dryRun? }
     *
     * Output: { templateId, name, created, populated_count, dry_run,
     *           reused }
     *
     * Behavior:
     *   1. Look up existing template by name via PanoptaClient.listTemplates
     *      (v2 read; per FMN-196 frontend-primary + v2-fallback rule).
     *   2. If found, return { reused: true, templateId, created: false }.
     *   3. If not found and dryRun, return would_create signal.
     *   4. If not found and live, POST /config/createServerTemplate
     *      (FortimonitorClient.createServerTemplate). Look up the new
     *      id via listTemplates after create (the FMN-199 response body
     *      is too thin to extract id reliably).
     *   5. For each resource, POST /config/monitoring/editAgentMetric.
     *      Skip when sourceServerId was set (clone-from-device populates
     *      automatically).
     *   6. Return template id.
     */
    'bulk-composer:ensure-template': async (payload = {}) => {
      const panopta = await factory();
      const fmClient = await fmFactory();
      return ensureTemplate({ panopta, fmClient }, payload || {});
    },

    /**
     * List the tenant's server groups (for the Configure step's
     * destination-group picker). Returns the parseListResponse shape
     * straight from PanoptaClient.listServerGroups.
     *
     * Returns: { groups: [{ id, name, resourceUrl }, ...] }
     */
    'bulk-composer:list-server-groups': async () => {
      const client = await factory();
      try {
        const groups = await client.listServerGroups();
        return { groups };
      } catch {
        return { groups: [] };
      }
    },

    // ---------------- FMN-196 (pre-existing) fetch handlers ----------------

    /**
     * Returns the tenant's templates with their server_group_name
     * attached. The recommendation engine partitions stock vs customer
     * templates by `server_group_name === "Default Monitoring Templates"`
     * (per FMN-135 finding). PanoptaClient.listTemplates exposes the
     * server_group URL; this handler resolves each URL to its group name
     * once per call.
     *
     * Returns: { templates: [{ id, name, server_group_name }] }
     */
    'bulk-composer:list-templates-with-groups': async () => {
      const client = await factory();
      const templates = await client.listTemplates();
      // listTemplates output shape (per FMN-155 work) carries
      // server_group_url or server_group (string URL). Resolve via the
      // tenant's group list. We over-fetch groups deliberately to avoid
      // per-template fetches.
      let groups = [];
      try {
        groups = typeof client.listServerGroups === 'function'
          ? await client.listServerGroups()
          : [];
      } catch {
        groups = [];
      }
      const groupNameByUrl = new Map();
      for (const g of groups) {
        if (g && typeof g.resourceUrl === 'string') groupNameByUrl.set(g.resourceUrl, g.name);
      }
      const out = templates.map((t) => ({
        id: t.id,
        name: t.name,
        server_group_name: typeof t.serverGroupUrl === 'string'
          ? (groupNameByUrl.get(t.serverGroupUrl) ?? null)
          : null
      }));
      return { templates: out };
    }
  };
}
