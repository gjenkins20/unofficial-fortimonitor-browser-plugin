// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// BPA Audit data layer (FMN-131).
//
// Pure data-collection module that walks ~25 v2 endpoints and returns a
// normalized inventory whose keys match the Python source's `data` dict
// (fortimonitor_audit.py / class AuditCollector). Analyzers in FMN-132
// will consume this dict unchanged, so the shape is the contract.
//
// Design notes:
//
//   * Reuses PanoptaClient for transport + ApiKey auth + redaction. Only
//     additive changes were made there: getJson(), paginate().
//   * 5 req/sec rate budget enforced in a fetch wrapper (createPacedFetch).
//     The wrapper is also where 5xx retry lives (createRetryingFetch),
//     because PanoptaClient itself doesn't retry. Matches the Python
//     source's MAX_RETRIES=3 with 2s/4s/6s backoff.
//   * 401 fail-fast (PanoptaError with phase='auth' bubbles up unhandled).
//     404 -> empty list / null. Recorded in errors[] but does not abort.
//   * AbortSignal is honored between requests via the paced fetch and
//     between pages via PanoptaClient._paginatedList.
//
// No UI, no flag wiring. Operator QA gated by FMN-132 landing.

import { PanoptaClient, PanoptaError } from './panopta-client.js';

// Default request budget. The Python source uses these exact values; do
// not change without re-running against a live tenant.
export const RATE_LIMIT_PER_SECOND = 5;
export const BACKOFF_DELAYS_MS = [2000, 4000, 6000];
export const MAX_RETRY_ATTEMPTS = BACKOFF_DELAYS_MS.length + 1; // 4 total
export const DEFAULT_MAX_ITEMS_PER_ENDPOINT = 5000;
export const DEFAULT_PAGE_SIZE = 200;

/**
 * Sleep that honors AbortSignal. Resolves when timeout elapses; rejects
 * with AbortError if the signal aborts first.
 */
export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Wrap a fetch function with serial-style rate limiting. Each call waits
 * until the next time slot is available, where slot interval is
 * 1000/rateLimit ms. Set rateLimit=0 to disable. The clock is shared
 * across all calls through the returned function, so concurrent callers
 * are still spaced at the same rate.
 *
 * @param {typeof fetch} fetch
 * @param {object} [options]
 * @param {number} [options.rateLimit] requests per second (default 5)
 * @param {() => number} [options.now] injectable clock for tests
 * @param {(ms:number, signal?:AbortSignal) => Promise<void>} [options.sleep]
 */
export function createPacedFetch(fetch, {
  rateLimit = RATE_LIMIT_PER_SECOND,
  now = () => Date.now(),
  sleep = abortableSleep
} = {}) {
  if (typeof fetch !== 'function') {
    throw new TypeError('createPacedFetch: fetch must be a function');
  }
  const minIntervalMs = rateLimit > 0 ? 1000 / rateLimit : 0;
  let nextSlot = 0;
  return async function pacedFetch(url, init = {}) {
    if (minIntervalMs > 0) {
      const t = now();
      const wait = Math.max(0, nextSlot - t);
      nextSlot = Math.max(t, nextSlot) + minIntervalMs;
      if (wait > 0) await sleep(wait, init.signal);
    }
    return fetch(url, init);
  };
}

/**
 * Wrap a fetch function with exponential backoff for 5xx responses and
 * network errors. Other statuses (including 401/404) pass through
 * immediately so PanoptaClient can convert them to PanoptaError.
 *
 * Backoff schedule defaults to BACKOFF_DELAYS_MS (2s, 4s, 6s) for a total
 * of 4 attempts.
 *
 * @param {typeof fetch} fetch
 * @param {object} [options]
 * @param {number[]} [options.backoffSchedule]
 * @param {(ms:number, signal?:AbortSignal) => Promise<void>} [options.sleep]
 */
export function createRetryingFetch(fetch, {
  backoffSchedule = BACKOFF_DELAYS_MS,
  sleep = abortableSleep
} = {}) {
  if (typeof fetch !== 'function') {
    throw new TypeError('createRetryingFetch: fetch must be a function');
  }
  const maxAttempts = backoffSchedule.length + 1;
  return async function retryingFetch(url, init = {}) {
    let lastNetworkError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res;
      try {
        res = await fetch(url, init);
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        lastNetworkError = err;
        const isLast = attempt === maxAttempts - 1;
        if (isLast) throw err;
        await sleep(backoffSchedule[attempt], init.signal);
        continue;
      }
      if (res.status >= 500 && res.status < 600 && attempt < maxAttempts - 1) {
        await sleep(backoffSchedule[attempt], init.signal);
        continue;
      }
      return res;
    }
    // Loop only exits via return or throw; this is unreachable.
    throw lastNetworkError ?? new Error('createRetryingFetch: exhausted attempts with no error');
  };
}

/**
 * Compose pacing + retry. Pacing wraps retry so each individual attempt
 * (including retries) is rate-limited. This matches the Python source,
 * where the throttle and retry both live in FortiMonitorAPI.get().
 */
export function createBpaFetch(fetch, {
  rateLimit = RATE_LIMIT_PER_SECOND,
  backoffSchedule = BACKOFF_DELAYS_MS,
  now,
  sleep = abortableSleep
} = {}) {
  const retrying = createRetryingFetch(fetch, { backoffSchedule, sleep });
  return createPacedFetch(retrying, { rateLimit, now, sleep });
}

// =============================================================================
// Endpoint registry
// =============================================================================
//
// Mirrors the Python source's AuditCollector.collect_all() exactly. Each
// row: [inventoryKey, path, envelopeKey]. The envelopeKey is informational -
// PanoptaClient._paginatedList probes a list of known wrappers, so any
// of these keys are picked up automatically. We track them for documentation
// and so the typedef can list them in one place.

const TOP_LEVEL_LIST_ENDPOINTS = [
  // Core inventory
  ['servers',                '/server',                 'server_list'],
  ['server_groups',          '/server_group',           'server_group_list'],
  ['server_templates',       '/server_template',        'server_template_list'],
  // Monitoring features
  ['outages',                '/outage',                 'outage_list'],
  ['compound_services',      '/compound_service',       'compound_service_list'],
  ['dem_applications',       '/monitoring/dem/application', 'dem_application_list'],
  // Dashboards
  ['dashboards',             '/dashboard',              'dashboard_list'],
  ['status_pages',           '/status_page',            'status_page_list'],
  // Notification
  ['contacts',               '/contact',                'contact_list'],
  ['contact_groups',         '/contact_group',          'contact_group_list'],
  ['notification_schedules', '/notification_schedule',  'notification_schedule_list'],
  ['rotating_contacts',      '/rotating_contact',       'rotating_contact_list'],
  // Infrastructure
  ['maintenance_windows',    '/maintenance_schedule',   'maintenance_schedule_list'],
  ['onsights',               '/onsight',                'onsight_list'],
  ['fabric_connections',     '/fabric_connection',      'fabric_connection_list'],
  ['cloud_credentials',      '/cloud_credential',       'cloud_credential_list'],
  ['snmp_credentials',       '/snmp_credential',        'snmp_credential_list'],
  ['monitoring_nodes',       '/monitoring_node',        'monitoring_node_list'],
  // Users
  ['users',                  '/user',                   'user_list'],
  ['account_history',        '/account_history',        'account_history_list']
];

const OUTAGE_STATS_DAYS = [7, 30, 60];
const ACTIVE_OUTAGE_LOG_CAP = 50;

// =============================================================================
// BpaInventory typedef (the contract for FMN-132 analyzers)
// =============================================================================

/**
 * @typedef {Object} BpaInventory
 *
 * @property {Object[]} servers                /server
 * @property {Object[]} server_groups          /server_group
 * @property {Object[]} server_templates       /server_template
 * @property {Object[]} outages                /outage
 * @property {Object[]} compound_services      /compound_service
 * @property {Object[]} dem_applications       /monitoring/dem/application
 * @property {Object[]} dashboards             /dashboard
 * @property {Object[]} status_pages           /status_page
 * @property {Object[]} contacts               /contact
 * @property {Object[]} contact_groups         /contact_group
 * @property {Object[]} notification_schedules /notification_schedule
 * @property {Object[]} rotating_contacts      /rotating_contact
 * @property {Object[]} maintenance_windows    /maintenance_schedule
 * @property {Object[]} onsights               /onsight
 * @property {Object[]} fabric_connections     /fabric_connection
 * @property {Object[]} cloud_credentials      /cloud_credential
 * @property {Object[]} snmp_credentials       /snmp_credential
 * @property {Object[]} monitoring_nodes       /monitoring_node
 * @property {Object[]} users                  /user
 * @property {Object[]} account_history        /account_history
 *
 * @property {Object[]} outages_recent         /outage (paged again, kept for parity)
 * @property {Object|{}} outage_stats_7d       /outage_statistics?days=7
 * @property {Object|{}} outage_stats_30d      /outage_statistics?days=30
 * @property {Object|{}} outage_stats_60d      /outage_statistics?days=60
 * @property {Object<string, Object[]>} outage_logs  /outage/{id}/log per active outage (cap 50)
 *
 * @property {Object<string, Object>} server_group_details      /server_group/{id}
 * @property {Object<string, Object>} server_template_details   /server_template/{id}
 *
 * @property {Object<string, Object>} [server_details]                /server/{id} (deep)
 * @property {Object<string, Object[]>} [server_resources]            /server/{id}/agent_resource (deep)
 * @property {Object<string, Object<string, Object>>} [server_resource_details]
 *   /server/{id}/agent_resource/{rid} (deep)
 * @property {Object<string, Object[]>} [server_network_services]     /server/{id}/network_service (deep)
 * @property {Object<string, Object[]>} [server_attributes]           /server/{id}/attribute (deep)
 *
 * @property {Object<string, {last_login:string|null, created_on:string|null}>} [frontend_user_data]
 *   Optional enrichment from BpaFrontendFetcher (FMN-135). Keyed by user id (string).
 *   Present when the operator opts into "Include FortiMonitor UI data" on the wizard.
 *
 * @property {string[]} errors  Per-endpoint error strings ("name: reason"); collection continues on each.
 * @property {{requests:number, deep:boolean, maxServers:number, durationMs:number}} stats
 */

// =============================================================================
// BpaFetcher
// =============================================================================

export class BpaFetcher {
  /**
   * @param {object} options
   * @param {PanoptaClient} options.client
   *   Client whose underlying fetch was wrapped with createBpaFetch (or
   *   equivalent) so rate-limit + 5xx retry are already in effect.
   * @param {AbortSignal} [options.signal]
   * @param {(event: BpaProgressEvent) => void} [options.onProgress]
   *   Called as collection progresses. Event shape:
   *     { type: 'endpoint-start' | 'endpoint-done' | 'endpoint-error'
   *           | 'deep-server' | 'collect-start' | 'collect-done',
   *       name?: string, count?: number, error?: string,
   *       index?: number, total?: number }
   * @param {number} [options.maxItemsPerEndpoint]
   * @param {number} [options.pageSize]
   */
  constructor({
    client,
    signal,
    onProgress,
    maxItemsPerEndpoint = DEFAULT_MAX_ITEMS_PER_ENDPOINT,
    pageSize = DEFAULT_PAGE_SIZE
  } = {}) {
    if (!client || typeof client.getJson !== 'function' || typeof client.paginate !== 'function') {
      throw new TypeError(
        'BpaFetcher requires a PanoptaClient instance with getJson() and paginate()'
      );
    }
    this.client = client;
    this.signal = signal;
    this.onProgress = onProgress ?? null;
    this.maxItemsPerEndpoint = maxItemsPerEndpoint;
    this.pageSize = pageSize;
    this._requestCount = 0;
  }

  /** Collect the full inventory and return a {@link BpaInventory}. */
  async collectInventory({ deep = false, maxServers = 0 } = {}) {
    const started = Date.now();
    /** @type {Partial<BpaInventory> & {errors: string[]}} */
    const data = { errors: [] };
    this._emit({ type: 'collect-start', deep });

    // --- Top-level lists ---
    for (const [name, path] of TOP_LEVEL_LIST_ENDPOINTS) {
      this._abortIfNeeded();
      data[name] = await this._collectList(name, path, data.errors);
    }

    // --- Outage trending ---
    await this._collectOutageTrending(data);

    // --- Server group + template details ---
    await this._collectGroupDetails(data);
    await this._collectTemplateDetails(data);

    // --- Deep dive (per-server) ---
    if (deep) {
      await this._collectDeepServerData(data, { maxServers });
    }

    const inventory = /** @type {BpaInventory} */ (data);
    inventory.stats = {
      requests: this._requestCount,
      deep,
      maxServers,
      durationMs: Date.now() - started
    };
    this._emit({ type: 'collect-done', requests: this._requestCount });
    return inventory;
  }

  // ---- Internal helpers -----------------------------------------------------

  _emit(event) {
    try { this.onProgress?.(event); } catch { /* ignore listener errors */ }
  }

  _abortIfNeeded() {
    if (this.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
  }

  /**
   * Paginated list collection. 404 / 405 -> []. Other errors -> recorded
   * into `errors` and []. 401 (auth) re-thrown so the caller can fail fast.
   *
   * 405 ("method not allowed") is treated like 404 because the v2 API
   * surfaces it for endpoints that don't support GET-list at all
   * (status_page, observed in FMN-133 QA on 2026-05-01). Recording every
   * such endpoint as an "error" is noise - the audit just doesn't have
   * data for it, same as 404.
   */
  async _collectList(name, path, errors) {
    this._emit({ type: 'endpoint-start', name });
    try {
      this._requestCount++;
      const out = await this.client.paginate(path, {
        pageSize: this.pageSize,
        maxPages: Math.ceil(this.maxItemsPerEndpoint / this.pageSize),
        signal: this.signal
      });
      this._emit({ type: 'endpoint-done', name, count: out.length });
      return out;
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      if (err instanceof PanoptaError && err.phase === 'auth') throw err;
      if (err instanceof PanoptaError && (err.status === 404 || err.status === 405)) {
        this._emit({ type: 'endpoint-done', name, count: 0 });
        return [];
      }
      const reason = err?.message ?? String(err);
      errors.push(`${name}: ${reason}`);
      this._emit({ type: 'endpoint-error', name, error: reason });
      return [];
    }
  }

  /**
   * Single-shot GET. 404 / 405 -> null. Other errors recorded; 401 re-thrown.
   */
  async _collectSingle(name, path, errors) {
    this._abortIfNeeded();
    try {
      this._requestCount++;
      return await this.client.getJson(path);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      if (err instanceof PanoptaError && err.phase === 'auth') throw err;
      if (err instanceof PanoptaError && (err.status === 404 || err.status === 405)) return null;
      const reason = err?.message ?? String(err);
      errors.push(`${name}: ${reason}`);
      return null;
    }
  }

  async _collectOutageTrending(data) {
    this._abortIfNeeded();
    // outages_recent: re-page /outage. Python keeps this redundant snapshot
    // separately so analyzers can compare against `outages` if a later
    // run needs to.
    data.outages_recent = await this._collectList('outages_recent', '/outage', data.errors);

    for (const days of OUTAGE_STATS_DAYS) {
      const key = `outage_stats_${days}d`;
      const result = await this._collectSingle(key, `/outage_statistics?days=${days}`, data.errors);
      data[key] = result ?? {};
    }

    /** @type {Object<string, Object[]>} */
    const outageLogs = {};
    const allOutages = Array.isArray(data.outages) ? data.outages : [];
    const active = allOutages.filter((o) => o?.active === true).slice(0, ACTIVE_OUTAGE_LOG_CAP);
    for (const outage of active) {
      this._abortIfNeeded();
      const oid = outage?.id ?? extractTrailingId(outage?.url);
      if (oid == null) continue;
      const logs = await this._collectList(
        `outage_log_${oid}`,
        `/outage/${encodeURIComponent(oid)}/log`,
        data.errors
      );
      outageLogs[String(oid)] = logs;
    }
    data.outage_logs = outageLogs;
  }

  async _collectGroupDetails(data) {
    /** @type {Object<string, Object>} */
    const out = {};
    const groups = Array.isArray(data.server_groups) ? data.server_groups : [];
    for (const g of groups) {
      this._abortIfNeeded();
      const gid = g?.id ?? extractTrailingId(g?.url);
      if (gid == null) continue;
      const detail = await this._collectSingle(
        `server_group_${gid}`,
        `/server_group/${encodeURIComponent(gid)}`,
        data.errors
      );
      if (detail) out[String(gid)] = detail;
    }
    data.server_group_details = out;
  }

  async _collectTemplateDetails(data) {
    /** @type {Object<string, Object>} */
    const out = {};
    const templates = Array.isArray(data.server_templates) ? data.server_templates : [];
    for (const t of templates) {
      this._abortIfNeeded();
      const tid = t?.id ?? extractTrailingId(t?.url);
      if (tid == null) continue;
      const detail = await this._collectSingle(
        `server_template_${tid}`,
        `/server_template/${encodeURIComponent(tid)}`,
        data.errors
      );
      if (detail) out[String(tid)] = detail;
    }
    data.server_template_details = out;
  }

  async _collectDeepServerData(data, { maxServers = 0 } = {}) {
    /** @type {Object<string, Object>} */
    const serverDetails = {};
    /** @type {Object<string, Object[]>} */
    const serverResources = {};
    /** @type {Object<string, Object<string, Object>>} */
    const serverResourceDetails = {};
    /** @type {Object<string, Object[]>} */
    const serverNetworkServices = {};
    /** @type {Object<string, Object[]>} */
    const serverAttributes = {};

    let servers = Array.isArray(data.servers) ? data.servers : [];
    if (maxServers > 0) servers = servers.slice(0, maxServers);
    const total = servers.length;

    for (let idx = 0; idx < total; idx++) {
      this._abortIfNeeded();
      const s = servers[idx];
      const sid = s?.id ?? extractTrailingId(s?.url);
      if (sid == null) continue;
      const sidKey = String(sid);
      this._emit({ type: 'deep-server', index: idx + 1, total });

      const detail = await this._collectSingle(
        `server_${sid}`,
        `/server/${encodeURIComponent(sid)}`,
        data.errors
      );
      if (detail) serverDetails[sidKey] = detail;

      const resources = await this._collectList(
        `server_${sid}_agent_resource`,
        `/server/${encodeURIComponent(sid)}/agent_resource`,
        data.errors
      );
      serverResources[sidKey] = resources;

      /** @type {Object<string, Object>} */
      const resDetails = {};
      for (const r of resources) {
        this._abortIfNeeded();
        const rid = r?.id ?? extractTrailingId(r?.url);
        if (rid == null) continue;
        const rd = await this._collectSingle(
          `server_${sid}_agent_resource_${rid}`,
          `/server/${encodeURIComponent(sid)}/agent_resource/${encodeURIComponent(rid)}`,
          data.errors
        );
        if (rd) resDetails[String(rid)] = rd;
      }
      serverResourceDetails[sidKey] = resDetails;

      serverNetworkServices[sidKey] = await this._collectList(
        `server_${sid}_network_service`,
        `/server/${encodeURIComponent(sid)}/network_service`,
        data.errors
      );

      serverAttributes[sidKey] = await this._collectList(
        `server_${sid}_attribute`,
        `/server/${encodeURIComponent(sid)}/attribute`,
        data.errors
      );
    }

    data.server_details = serverDetails;
    data.server_resources = serverResources;
    data.server_resource_details = serverResourceDetails;
    data.server_network_services = serverNetworkServices;
    data.server_attributes = serverAttributes;
  }
}

/** Pull the trailing numeric id from a v2 resource_url / url field. */
export function extractTrailingId(url) {
  if (!url || typeof url !== 'string') return null;
  const parts = url.replace(/\/+$/, '').split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    if (/^\d+$/.test(seg)) return Number(seg);
  }
  return null;
}

/**
 * Production factory. Builds a paced + retrying fetch on top of the
 * environment fetch, then constructs a PanoptaClient and BpaFetcher.
 *
 * @param {object} [overrides]
 * @param {string} [overrides.apiKey]   defaults to chrome.storage.local panopta.apiKey
 * @param {typeof fetch} [overrides.fetch]
 * @param {object} [overrides.storage]
 * @param {AbortSignal} [overrides.signal]
 * @param {(event:object)=>void} [overrides.onProgress]
 */
export async function createProductionBpaFetcher(overrides = {}) {
  const baseFetch = overrides.fetch ?? globalThis.fetch.bind(globalThis);
  const fetch = createBpaFetch(baseFetch);
  let apiKey = overrides.apiKey;
  if (!apiKey) {
    const storage = overrides.storage ?? chrome.storage.local;
    const stored = await storage.get('panopta.apiKey');
    apiKey = stored?.['panopta.apiKey'];
  }
  if (!apiKey) {
    throw new PanoptaError(
      'No API key configured. Open the extension settings and paste a FortiMonitor RW API key.',
      { phase: 'auth' }
    );
  }
  const client = new PanoptaClient({ apiKey, fetch });
  return new BpaFetcher({
    client,
    signal: overrides.signal,
    onProgress: overrides.onProgress
  });
}
