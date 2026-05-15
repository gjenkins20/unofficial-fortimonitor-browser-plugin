// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Observations frontend (session-auth) data layer (FMN-135).
//
// Companion to ObservationsFetcher. Walks the FortiMonitor UI's per-user data
// endpoint to harvest fields the v2 API does not expose - currently
// `last_login` and `created_on`. Designed to be invoked AFTER ObservationsFetcher
// has populated inventory.users; the result is merged into inventory
// under `frontend_user_data` so the user analyzer can pick it up.
//
// Endpoint: GET /users/users/get_edit_user_data?contact_id={id}
//   Discovered by Playwright probe on 2026-05-01: the EditUser page
//   itself is a SPA shell (the same 938kB HTML for every user); the
//   actual user data is loaded by a JSON XHR after hydration. The
//   earlier HTML-regex approach could not work because the labels
//   "Last Login" / "Created On" are not present in the response body
//   the SW receives - they are injected by client-side JavaScript.
//
//   Authenticated response: 200 application/json, shape:
//     { "success": true, "data": { ..., "config_data": {
//         "last_login": "2026-05-01 20:03 PDT",
//         "created_on": "2024-12-11 15:24 PST",
//         ...
//       }}}
//   Unauthenticated response: 200 text/html, the SPA shell. We detect
//   auth failure by Content-Type alone - no need to peek at body.
//
// Auth: session cookie attached automatically by Chromium when the SW
// fetches with credentials:'include' and host_permissions covers the
// origin (per FMN-70 and memory extension_page_cross_origin_cookies.md).
// No XSRF, X-Requested-With, or Referer header needed (verified in the
// Playwright probe).

import { createObservationsFetch } from './observations-fetcher.js';
import { userKeyOf, contactIdOf, extractTrailingId } from './observation-analyzers/_helpers.js';

export const FORTIMONITOR_ORIGIN = 'https://fortimonitor.forticloud.com';
export const EDIT_USER_DATA_PATH = '/users/users/get_edit_user_data';
export const MONITORING_CONFIG_PATH = '/report/get_monitoring_config_data';

// =============================================================================
// JSON parsing
// =============================================================================

/**
 * Pull metric + alert (threshold) counts off the get_monitoring_config_data
 * response shape (FMN-135 follow-up, 2026-05-01).
 *
 * Live response shape:
 *   { success: true,
 *     categories: { added: [{ name, textkey, metrics: [{ id, name,
 *                                                        alert_items: [...] }] }] }}
 *
 * `alert_items` carries the threshold tuples: [severity, label, timeline,
 * condition_text, extras]. A non-empty array means the metric has at
 * least one alert configured.
 *
 * Returns:
 *   { total_metrics, alerts_count, metric_names: string[],
 *     metrics_without_alerts: string[] }
 * or null when the shape is unrecognized.
 *
 * Used by the analyzer to detect:
 *   - default-only templates (metrics > 0, alerts == 0)
 *   - cleanup candidates    (most metrics lack alerts)
 *   - overlapping templates (metric-name set intersection)
 */
export function parseMonitoringConfig(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.success !== true) return null;
  const cats = json?.categories?.added;
  if (!Array.isArray(cats)) return null;
  let total_metrics = 0;
  let alerts_count = 0;
  const metric_names = [];
  const metrics_without_alerts = [];
  for (const c of cats) {
    const ms = Array.isArray(c?.metrics) ? c.metrics : [];
    for (const m of ms) {
      total_metrics += 1;
      const name = typeof m?.name === 'string' ? m.name : '';
      if (name) metric_names.push(name);
      const hasAlerts = Array.isArray(m?.alert_items) && m.alert_items.length > 0;
      if (hasAlerts) {
        alerts_count += 1;
      } else if (name) {
        metrics_without_alerts.push(name);
      }
    }
  }
  return { total_metrics, alerts_count, metric_names, metrics_without_alerts };
}

/**
 * Pull last_login and created_on off the get_edit_user_data response.
 * Returns null if the shape is unrecognized.
 *
 * @param {object} json  Parsed response body.
 * @returns {{last_login: string|null, created_on: string|null}|null}
 */
export function parseEditUserData(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.success !== true) return null;
  const cd = json?.data?.config_data;
  if (!cd || typeof cd !== 'object') return null;
  const ll = typeof cd.last_login === 'string' ? cd.last_login : null;
  const co = typeof cd.created_on === 'string' ? cd.created_on : null;
  return { last_login: ll, created_on: co };
}

// =============================================================================
// ObservationsFrontendFetcher
// =============================================================================

/**
 * @typedef {Object} FrontendUserDatum
 * @property {string|null} last_login
 *   The last_login value from data.config_data, verbatim. Null when the
 *   user has no recorded login or the field is absent on the response.
 * @property {string|null} created_on
 *   The created_on value from data.config_data, verbatim.
 */

/**
 * @typedef {Object} ObservationsFrontendResult
 * @property {Object<string, FrontendUserDatum>} users  Keyed by user id (string)
 * @property {string[]} errors  Per-user error strings ("user 581047: reason")
 * @property {{requests:number, durationMs:number, total:number}} stats
 */

export class ObservationsFrontendFetcher {
  /**
   * @param {object} options
   * @param {typeof fetch} options.fetch
   *   Wrapped fetch (rate-limited + retry). Production callers pass
   *   createObservationsFetch(globalThis.fetch). Tests inject a stub.
   * @param {string} [options.origin]  defaults to FortiMonitor production origin
   * @param {AbortSignal} [options.signal]
   * @param {(event:object) => void} [options.onProgress]
   *   Same event shape vocabulary as ObservationsFetcher:
   *     { type: 'frontend-user-start' | 'frontend-user-done' | 'frontend-user-error',
   *       index?: number, total?: number, id?: string, error?: string }
   */
  constructor({ fetch, origin = FORTIMONITOR_ORIGIN, signal, onProgress } = {}) {
    if (typeof fetch !== 'function') {
      throw new TypeError('ObservationsFrontendFetcher requires a fetch function');
    }
    this.fetch = fetch;
    this.origin = origin;
    this.signal = signal;
    this.onProgress = onProgress ?? null;
    this._requestCount = 0;
  }

  /**
   * Walk inventory.users, fetching each user's get_edit_user_data and
   * extracting last_login / created_on. Returns a ObservationsFrontendResult;
   * never throws on per-user failures (those are recorded in errors[]).
   * Aborts cleanly if the caller's AbortSignal fires.
   *
   * Auth failure on the FIRST user is treated as fatal - if the operator
   * isn't logged in, every subsequent fetch will return the SPA shell,
   * and we'd rather surface the problem once than spam errors[] N times.
   *
   * @param {Object[]} users  inventory.users from ObservationsFetcher
   * @returns {Promise<ObservationsFrontendResult>}
   */
  async collect(users) {
    const started = Date.now();
    /** @type {ObservationsFrontendResult} */
    const result = {
      users: {},
      errors: [],
      stats: { requests: 0, durationMs: 0, total: 0 }
    };
    const list = Array.isArray(users) ? users : [];
    result.stats.total = list.length;

    for (let idx = 0; idx < list.length; idx++) {
      this._abortIfNeeded();
      const u = list[idx];
      // Two distinct identifiers per user (FMN-135 QA, 2026-05-01):
      //   - userKey:   /v2/user/{id} - join key for the result map
      //                (matches the analyzer's userKeyOf(u) lookup).
      //   - contactId: /v2/contact/{id} - the URL parameter the
      //                get_edit_user_data endpoint expects. These number
      //                spaces are different and not interchangeable.
      const userKey = userKeyOf(u);
      if (userKey == null) continue;
      const contactId = contactIdOf(u);
      if (contactId == null) {
        const reason = 'no contact_info on record (cannot derive contact_id)';
        result.errors.push(`user ${userKey}: ${reason}`);
        this._emit({ type: 'frontend-user-error', index: idx + 1, total: list.length, id: userKey, error: reason });
        continue;
      }
      this._emit({ type: 'frontend-user-start', index: idx + 1, total: list.length, id: userKey });

      try {
        const datum = await this._fetchOne(contactId);
        result.users[userKey] = datum;
        this._emit({ type: 'frontend-user-done', index: idx + 1, total: list.length, id: userKey });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        const reason = err?.message ?? String(err);
        result.errors.push(`user ${userKey}: ${reason}`);
        this._emit({ type: 'frontend-user-error', index: idx + 1, total: list.length, id: userKey, error: reason });
        // Fatal-on-first-failure: if this is the first user and the cause
        // is auth, abort the whole walk rather than producing N
        // unhelpful "session expired" errors.
        if (idx === 0 && /not logged in|session|auth/i.test(reason)) {
          throw new Error(
            `FortiMonitor session not detected at ${this.origin}. `
            + 'Open your tenant URL (e.g. https://my.<region>.fortimonitor.com) '
            + 'in another tab, sign in, then retry the assessment.'
          );
        }
      }
    }

    result.stats.requests = this._requestCount;
    result.stats.durationMs = Date.now() - started;
    return result;
  }

  /**
   * Walk the server_templates list, fetching each template's monitoring
   * config (metrics + thresholds). Same fatal-on-first-failure pattern
   * as collect(). Templates and servers share an id namespace - the
   * same get_monitoring_config_data endpoint accepts a template id under
   * `server_id=...`.
   *
   * @param {Object[]} templates  inventory.server_templates from ObservationsFetcher
   * @returns {Promise<{ configs: Object<string, object>, errors: string[],
   *                     stats: { requests:number, durationMs:number, total:number } }>}
   */
  async collectTemplateConfigs(templates) {
    const started = Date.now();
    const requestsBefore = this._requestCount;
    const result = {
      configs: {},
      errors: [],
      stats: { requests: 0, durationMs: 0, total: 0 }
    };
    const list = Array.isArray(templates) ? templates : [];
    result.stats.total = list.length;

    for (let idx = 0; idx < list.length; idx++) {
      this._abortIfNeeded();
      const t = list[idx];
      const tid = (t?.id != null && t.id !== '')
        ? String(t.id)
        : extractTrailingId(t?.url);
      if (!tid) continue;
      this._emit({ type: 'frontend-template-start', index: idx + 1, total: list.length, id: tid });
      try {
        const config = await this._fetchMonitoringConfig(tid);
        result.configs[tid] = config;
        this._emit({ type: 'frontend-template-done', index: idx + 1, total: list.length, id: tid });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        const reason = err?.message ?? String(err);
        result.errors.push(`template ${tid}: ${reason}`);
        this._emit({ type: 'frontend-template-error', index: idx + 1, total: list.length, id: tid, error: reason });
        if (idx === 0 && /not logged in|session|auth/i.test(reason)) {
          throw new Error(
            `FortiMonitor session not detected at ${this.origin}. `
            + 'Open your tenant URL (e.g. https://my.<region>.fortimonitor.com) '
            + 'in another tab, sign in, then retry the assessment.'
          );
        }
      }
    }

    result.stats.requests = this._requestCount - requestsBefore;
    result.stats.durationMs = Date.now() - started;
    return result;
  }

  // ---- Internal -----------------------------------------------------------

  async _fetchMonitoringConfig(serverOrTemplateId) {
    this._requestCount++;
    const url = `${this.origin}${MONITORING_CONFIG_PATH}?server_id=${encodeURIComponent(serverOrTemplateId)}`;
    const res = await this.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
      signal: this.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = (
      typeof res.headers?.get === 'function'
        ? (res.headers.get('content-type') ?? '')
        : (res.headers?.['content-type'] ?? '')
    ) + '';
    if (!/json/i.test(ct)) {
      throw new Error('Not logged into FortiMonitor (got HTML instead of JSON; session expired or absent)');
    }
    const json = await res.json();
    const parsed = parseMonitoringConfig(json);
    if (!parsed) throw new Error('Unexpected response shape from get_monitoring_config_data');
    return parsed;
  }

  async _fetchOne(contactId) {
    this._requestCount++;
    const url = `${this.origin}${EDIT_USER_DATA_PATH}?contact_id=${encodeURIComponent(contactId)}`;
    const res = await this.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
      signal: this.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    // When the session cookie is missing/expired, FortiMonitor returns
    // 200 with the SPA shell HTML rather than a redirect. The Content-
    // Type tells us instantly which we got.
    const ct = (
      typeof res.headers?.get === 'function'
        ? (res.headers.get('content-type') ?? '')
        : (res.headers?.['content-type'] ?? '')
    ) + '';
    if (!/json/i.test(ct)) {
      throw new Error('Not logged into FortiMonitor (got HTML instead of JSON; session expired or absent)');
    }
    const json = await res.json();
    const parsed = parseEditUserData(json);
    if (!parsed) {
      throw new Error('Unexpected response shape from get_edit_user_data');
    }
    return parsed;
  }

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
}

/**
 * Production factory. Builds a paced + retrying fetch (same wrapper
 * ObservationsFetcher uses) and returns a ObservationsFrontendFetcher ready to collect().
 *
 * @param {object} [overrides]
 * @param {typeof fetch} [overrides.fetch]
 * @param {AbortSignal} [overrides.signal]
 * @param {(event:object)=>void} [overrides.onProgress]
 */
export function createProductionObservationsFrontendFetcher(overrides = {}) {
  const baseFetch = overrides.fetch ?? globalThis.fetch.bind(globalThis);
  const fetch = createObservationsFetch(baseFetch);
  return new ObservationsFrontendFetcher({
    fetch,
    signal: overrides.signal,
    onProgress: overrides.onProgress
  });
}

export const ACCOUNT_HISTORY_PATH = '/report/get_history_data';

// FMN-223: pull the Account History slice that the FortiMonitor Logs page
// renders. v2 /account_history returns 500 consistently (per FMN-135 note);
// this DataTables-style session-auth endpoint is the only path. The
// response is a flat 5-element array per row:
//   [date, time, user, instance_html, action]
// We parse the instance HTML for server_id when present, and the action
// text for the bracketed entity id (Server Group / User / Server Template).
//
// Returns an array of { date, time, user, server_id, instance_name,
// action, entity_type, entity_id }, ordered newest-first as the endpoint
// returns them. Stops after `maxRows` to keep storage bounded; the diff
// correlator matches by entity id so a generous cap is fine.
export async function fetchAccountHistory({ fetch, origin, signal, maxRows = 200 } = {}) {
  const baseFetch = fetch ?? globalThis.fetch.bind(globalThis);
  const host = (typeof origin === 'string' && origin.length > 0) ? origin : FORTIMONITOR_ORIGIN;
  const PAGE = 100;
  const out = [];
  let offset = 0;
  while (out.length < maxRows) {
    const params = new URLSearchParams({
      to_html: 'true',
      draw: '1',
      start: String(offset),
      length: String(Math.min(PAGE, maxRows - out.length)),
      'search[value]': '',
      'search[regex]': 'false',
    });
    let res;
    try {
      res = await baseFetch(`${host}${ACCOUNT_HISTORY_PATH}?${params}`, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        signal,
      });
    } catch {
      break;
    }
    if (!res.ok) break;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) break;
    let body;
    try { body = await res.json(); } catch { break; }
    const rows = Array.isArray(body?.data) ? body.data : [];
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push(parseAccountHistoryRow(r));
      if (out.length >= maxRows) break;
    }
    if (rows.length < PAGE) break;
    offset += rows.length;
  }
  return out;
}

function parseAccountHistoryRow(r) {
  const date = typeof r[0] === 'string' ? r[0] : '';
  const time = typeof r[1] === 'string' ? r[1] : '';
  const user = typeof r[2] === 'string' ? r[2] : '';
  const instanceHtml = typeof r[3] === 'string' ? r[3] : '';
  const action = typeof r[4] === 'string' ? r[4] : '';

  // server_id from <a href="../report/InstanceDetails?server_id=42024061">name</a>
  const serverIdMatch = instanceHtml.match(/server_id=(\d+)/);
  const serverId = serverIdMatch ? Number(serverIdMatch[1]) : null;
  const nameMatch = instanceHtml.match(/>([^<]+)<\/a>/);
  const instanceName = nameMatch ? nameMatch[1] : '';

  // entity_type + entity_id from action text. Common formats:
  //   "API POST ...: Created User <name> [<id>]"
  //   "API DELETE ...: Deleted Server Group <name> [<id>]"
  //   "Removed template association to <name>, preserved metrics."
  let entityType = null;
  let entityId = null;
  const bracketMatch = action.match(/\b(User|Server Group|Server Template|Template)\b[^[]*\[(\d+)\]/);
  if (bracketMatch) {
    entityType = bracketMatch[1].toLowerCase().replace(/\s+/g, '_');
    if (entityType === 'template') entityType = 'server_template';
    entityId = Number(bracketMatch[2]);
  }

  return { date, time, user, server_id: serverId, instance_name: instanceName, action, entity_type: entityType, entity_id: entityId };
}

// FMN-221: pull tenant identity (customer name) off the inline
// `window.sentry_user` block that every authenticated FortiMonitor SPA
// page emits. The v2 /customer endpoint returns 401 with a regular user
// API key, so this session-auth scrape is the only path to a tenant
// identifier without elevated permissions.
//
// Returns { id, name, subdomain } shaped for pickCustomer in
// observations-snapshots.js. id stays null because the sentry block carries
// the user id, not a customer id; subdomain stays empty because the host is
// shared across tenants (fortimonitor.forticloud.com). filenameFor falls
// back to sanitizing `name` when subdomain is empty.
export async function fetchCustomerIdentity({ fetch, origin, signal } = {}) {
  const baseFetch = fetch ?? globalThis.fetch.bind(globalThis);
  const host = (typeof origin === 'string' && origin.length > 0) ? origin : FORTIMONITOR_ORIGIN;
  const url = host + '/report/ListReports';
  let res;
  try {
    res = await baseFetch(url, { credentials: 'include', signal });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return null;
  const html = await res.text();
  const userMatch = html.match(/window\.sentry_user\s*=\s*(\{[^;]+\})/);
  if (!userMatch) return null;
  let parsed;
  try { parsed = JSON.parse(userMatch[1]); } catch { return null; }
  const name = typeof parsed.customer === 'string' ? parsed.customer.trim() : '';
  if (!name) return null;
  return { id: null, name, subdomain: '' };
}
