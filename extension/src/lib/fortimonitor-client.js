// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FortiMonitor session-riding client.
//
// Wraps the internal FortiMonitor WebGUI operations the plugin needs:
//   - GET /onboarding/getDevicePorts   (read port scope)
//   - POST /config/save_port_selection (write port scope)
//   - GET /report/get_idp_data         (resolve server id -> human name)
//
// Auth is the user's existing FortiMonitor session cookie, plus the
// X-XSRF-TOKEN header derived from the XSRF-TOKEN cookie value.
//
// All IO is injectable (fetch, getCookie) so this module is testable in
// Node without any Chrome APIs. See createProductionClient() at the bottom
// for the production factory that wires chrome.cookies + global fetch.

// Default origin kept for tests and back-compat. In production the
// service worker resolves the tenant origin at runtime and injects it
// into the client - see origin-resolver.js.
export const FM_ORIGIN = 'https://fortimonitor.forticloud.com';
const XSRF_COOKIE_NAME = 'XSRF-TOKEN';

export class FortimonitorError extends Error {
  constructor(message, {
    status = null,
    phase = null,
    responseBody = null,
    responseUrl = null,
    contentType = null,
    bodyPreview = null
  } = {}) {
    super(message);
    this.name = 'FortimonitorError';
    this.status = status;
    this.phase = phase;
    this.responseBody = responseBody;
    this.responseUrl = responseUrl;
    this.contentType = contentType;
    this.bodyPreview = bodyPreview;
  }
}

/**
 * Remove long opaque tokens and query strings from a string before we
 * attach it to an error. Long base64-ish runs (32+ chars) and entire
 * query strings are the two shapes most likely to contain session
 * secrets - redacting both keeps diagnostics useful without leaking
 * cookies or XSRF values into log surfaces.
 *
 * Exported for tests.
 */
export function redactSensitive(text) {
  if (text == null) return text;
  const s = String(text);
  return s
    .replace(/\?[^\s"'<>]+/g, '?<redacted-query>')
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, '<redacted-token>');
}

/**
 * Build the query string the FortiMonitor WebGUI sends when the user
 * clicks Save in the Port Selection dialog. The body is empty; all
 * parameters go in the URL. Parameter order matches the captured UI
 * traffic (see docs/api-discovery/port-scope.md).
 */
export function buildSavePortSelectionUrl({
  serverId,
  portSelectionType,
  selectedIndices = [],
  totalPortCount,
  searchTerm = '',
  filters = [],
  origin = FM_ORIGIN
}) {
  if (serverId === undefined || serverId === null) {
    throw new TypeError('buildSavePortSelectionUrl: serverId is required');
  }
  if (!portSelectionType) {
    throw new TypeError('buildSavePortSelectionUrl: portSelectionType is required');
  }
  if (!Number.isFinite(Number(totalPortCount))) {
    throw new TypeError('buildSavePortSelectionUrl: totalPortCount must be numeric');
  }

  const params = new URLSearchParams();
  params.append('serverId', String(serverId));
  params.append('filters', JSON.stringify(filters));
  params.append('portSelectionType', portSelectionType);
  params.append('searchTerm', searchTerm);
  params.append('totalPortCount', String(totalPortCount));
  for (const idx of selectedIndices) {
    params.append('selectedPorts[]', String(idx));
  }
  return `${origin}/config/save_port_selection?${params.toString()}`;
}

/**
 * Normalize the device-ports response shape. The FortiMonitor WebGUI wraps
 * the payload in { data: ... }; callers should not need to care.
 */
export function parseDevicePortsResponse(json) {
  if (!json || typeof json !== 'object' || !json.data) {
    throw new FortimonitorError('Malformed getDevicePorts response: missing data', {
      phase: 'read',
      responseBody: json
    });
  }
  const d = json.data;
  return {
    filterType: d.filter_type ?? 'all',
    portFilters: {
      searchTerm: d.portFilters?.searchTerm ?? '',
      filters: Array.isArray(d.portFilters?.filters) ? d.portFilters.filters : []
    },
    ports: Array.isArray(d.ports) ? d.ports.map((p) => ({
      name: p.name,
      index: p.index,
      alias: p.alias ?? '',
      descr: p.descr ?? null,
      admin_status: p.admin_status ?? 'Unknown',
      oper_status: p.oper_status ?? 'Unknown',
      isActive: Boolean(p.isActive),
      isDisabled: Boolean(p.isDisabled)
    })) : []
  };
}

export class FortimonitorClient {
  /**
   * @param {object} deps
   * @param {typeof fetch} deps.fetch
   * @param {(name: string) => Promise<string|null>} deps.getCookie
   * @param {string|(() => Promise<string>)} [deps.origin] tenant base URL;
   *   accepts a string or an async resolver so the service worker can
   *   discover the regional subdomain lazily from open tabs.
   */
  constructor({ fetch, getCookie, origin = FM_ORIGIN } = {}) {
    if (typeof fetch !== 'function') {
      throw new TypeError('FortimonitorClient requires a fetch function');
    }
    if (typeof getCookie !== 'function') {
      throw new TypeError('FortimonitorClient requires a getCookie function');
    }
    this.fetch = fetch;
    this.getCookie = getCookie;
    this._origin = origin;
  }

  /**
   * Resolve the tenant origin for this call. Accepts a string or a
   * resolver function; caches resolver output so we only hit tab-query
   * once per service-worker lifetime.
   */
  async origin() {
    if (typeof this._origin === 'function') {
      if (!this._originCache) this._originCache = Promise.resolve(this._origin());
      return this._originCache;
    }
    return this._origin;
  }

  async getDevicePorts(serverId) {
    if (serverId === undefined || serverId === null) {
      throw new TypeError('getDevicePorts: serverId is required');
    }
    const origin = await this.origin();
    const url = `${origin}/onboarding/getDevicePorts?server_id=${encodeURIComponent(serverId)}`;
    const res = await this.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    const responseUrl = redactSensitive(res.url ?? url);
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (!res.ok) {
      throw new FortimonitorError(`getDevicePorts failed: HTTP ${res.status}`, {
        status: res.status,
        phase: 'read',
        responseUrl,
        contentType
      });
    }
    // FortiMonitor redirects unauthenticated requests to a login HTML page
    // with HTTP 200, so res.ok doesn't catch it. Sniff content-type and
    // surface a clean auth error instead of a JSON parse failure.
    if (contentType && !contentType.toLowerCase().includes('json')) {
      let bodyPreview = null;
      try {
        const text = await res.text();
        bodyPreview = redactSensitive(text.slice(0, 200));
      } catch { /* best effort */ }
      throw new FortimonitorError(
        'FortiMonitor returned a non-JSON response (likely a login page). Your browser session is not being recognized by the extension - confirm you are logged into fortimonitor.forticloud.com in this Chrome profile and that the server ID belongs to that tenant.',
        {
          status: res.status,
          phase: 'auth',
          responseUrl,
          contentType,
          bodyPreview
        }
      );
    }
    const json = await res.json();
    return parseDevicePortsResponse(json);
  }

  async savePortSelection({
    serverId,
    portSelectionType = 'manual',
    selectedIndices = [],
    totalPortCount,
    searchTerm = '',
    filters = []
  }) {
    const origin = await this.origin();
    const xsrf = await this.getCookie(XSRF_COOKIE_NAME, origin);
    if (!xsrf) {
      throw new FortimonitorError(
        `No ${XSRF_COOKIE_NAME} cookie - user is not logged in to FortiMonitor.`,
        { phase: 'auth' }
      );
    }
    const url = buildSavePortSelectionUrl({
      serverId, portSelectionType, selectedIndices, totalPortCount, searchTerm, filters, origin
    });
    const res = await this.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-XSRF-TOKEN': xsrf
      }
      // body intentionally empty: FortiMonitor puts the form data in the query string
    });
    if (!res.ok) {
      throw new FortimonitorError(`save_port_selection failed: HTTP ${res.status}`, {
        status: res.status,
        phase: 'write',
        responseUrl: redactSensitive(res.url ?? url),
        contentType: res.headers?.get?.('content-type') ?? ''
      });
    }
    const json = await res.json();
    if (!json || json.success !== true) {
      throw new FortimonitorError('save_port_selection rejected by server', {
        phase: 'write',
        responseBody: json
      });
    }
    return json;
  }

  /**
   * Resolve a server id to its human-readable name. Returns null on any
   * failure (non-existent id, expired session, SPA-shell HTML response,
   * JSON parse error, missing name field). Callers should treat null as
   * "name not resolvable" and fall back to the id for display.
   *
   * This endpoint returns 200 + HTML for any bad input - see
   * docs/api-discovery/server-metadata.md for the full failure matrix.
   *
   * @param {number|string} serverId
   * @returns {Promise<string | null>}
   */
  async getServerName(serverId) {
    if (serverId === undefined || serverId === null) return null;
    const origin = await this.origin();
    const url = `${origin}/report/get_idp_data?server_id=${encodeURIComponent(String(serverId))}`;
    let res;
    try {
      res = await this.fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const ct = (res.headers?.get?.('content-type') || '').toLowerCase();
    if (!ct.includes('json')) return null;
    let body;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    const name = body?.pageData?.instance?.name;
    return (typeof name === 'string' && name.length > 0) ? name : null;
  }

  /**
   * Cheap diagnostic probe used by the developer-mode "Check session"
   * button. Does not throw - returns a shape the UI can render directly.
   * Redacts URLs and long tokens so the result is safe to show next to
   * operator-facing error text.
   */
  async probeSession() {
    const origin = await this.origin();
    const xsrf = await this.getCookie(XSRF_COOKIE_NAME, origin).catch(() => null);
    const url = `${origin}/onboarding/getDevicePorts?server_id=0`;
    let probe;
    try {
      const res = await this.fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      probe = {
        ok: res.ok,
        status: res.status,
        responseUrl: redactSensitive(res.url ?? url),
        contentType: res.headers?.get?.('content-type') ?? ''
      };
    } catch (err) {
      probe = { ok: false, error: err?.message ?? String(err) };
    }
    return {
      origin,
      hasXsrfCookie: Boolean(xsrf),
      xsrfCookiePrefix: xsrf ? `${String(xsrf).slice(0, 6)}…` : null,
      probe
    };
  }

  // ---------------------------------------------------------------
  // Fabric metadata (FMN-196 dependency)
  // ---------------------------------------------------------------

  /**
   * Returns the `fabricSystemData` blob for a server (or null on failure),
   * augmented with `isFabric` and `deviceSubType` from the surrounding
   * instance record so callers have everything they need to identify
   * the device class in one network round-trip.
   *
   * Per project memory idp_data_field_path_findings.md, fabricSystemData
   * is populated only on Fortinet/Fabric-onboarded rows. FMN-211 Phase
   * A captures showed that fabricSystemData shape varies across types
   * (FortiGate carries model_name/model_number; FortiAP/Switch carry
   * `model` plus `os_version` with the product code as a prefix). The
   * canonical type signal across all three classes is `deviceSubType`
   * (fortinet.fortigate / fortinet.fortiap / fortinet.fortiswitch),
   * which lives on the instance, not inside fabricSystemData.
   *
   * @param {number|string} serverId
   * @returns {Promise<{
   *   model_name?: string,
   *   model_number?: string,
   *   model?: string,
   *   os_version?: string,
   *   isFabric?: boolean|null,
   *   deviceSubType?: string|null
   * } | null>}
   */
  async getFabricSystemData(serverId) {
    if (serverId === undefined || serverId === null) return null;
    const origin = await this.origin();
    const url = `${origin}/report/get_idp_data?server_id=${encodeURIComponent(String(serverId))}`;
    let res;
    try {
      res = await this.fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const ct = (res.headers?.get?.('content-type') || '').toLowerCase();
    if (!ct.includes('json')) return null;
    let body;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    const instance = body?.pageData?.instance || {};
    const fsd = instance.fabricSystemData;
    if (!fsd || typeof fsd !== 'object') return null;
    // FMN-211: surface the identity flags from the parent `instance`
    // alongside fabricSystemData so the clusterer can route by type.
    return {
      ...fsd,
      isFabric: instance.isFabric ?? null,
      deviceSubType: instance.deviceSubType ?? null
    };
  }

  /**
   * Fetch the Save-as-Template dialog defaults for a server. Powers the
   * FMN-211 per-cluster template_type plumbing: FortiMonitor returns
   * different `template_type_options` per device class (Fabric FortiAP
   * and FortiSwitch -> "fabric_template"; SNMP-monitored network
   * devices -> "network_device_template"). Reading the default from
   * this endpoint avoids hardcoding fabric_template across all writes.
   *
   * @param {number|string} serverId
   * @returns {Promise<{
   *   template_name?: string,
   *   template_type_options?: Array<{value: string, label: string}>,
   *   alert_timeline_options?: Array<{value: number, label: string}>,
   *   preselected?: string[]
   * } | null>}
   */
  async getCreateTemplateDefaults(serverId) {
    if (serverId === undefined || serverId === null) return null;
    const origin = await this.origin();
    const url = `${origin}/config/get_create_server_template_data?instance_id=${encodeURIComponent(String(serverId))}`;
    let res;
    try {
      res = await this.fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const ct = (res.headers?.get?.('content-type') || '').toLowerCase();
    if (!ct.includes('json')) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  /**
   * Fetch the FortiMonitor monitoring tree (groups + servers + templates).
   * One round-trip, ~26KB for a tenant with ~60 groups + ~100 servers
   * (FMN-199 capture 2026-05-13). Powers FMN-224's server-group input
   * mode for Bulk Composer: walks the nested tree to enumerate every
   * group and its (recursive) device members without requiring a v2
   * API key.
   *
   * Request: POST with no body. Mimics FortiMonitor's own UI: includes
   * X-XSRF-TOKEN when the cookie is available (the captured browser
   * request sent it; the session may or may not validate it but
   * matching the browser is the safest path).
   *
   * @returns {Promise<{ nodes: Array<object>, userHash?: string }>}
   * @see extension/src/lib/monitoring-tree.js for the parser
   * @see docs/api-discovery/monitoring-tree.md for the contract
   */
  async getMonitoringTree() {
    const origin = await this.origin();
    const url = `${origin}/util/monitoring_tree?include_templates=1`;
    const headers = {
      'Accept': 'application/json, text/plain, */*'
    };
    try {
      const xsrf = await this.getCookie(XSRF_COOKIE_NAME, origin);
      if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;
    } catch { /* no cookie helper available - fall through without header */ }
    const res = await this.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers
    });
    const responseUrl = redactSensitive(res.url ?? url);
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (!res.ok) {
      throw new FortimonitorError(`getMonitoringTree failed: HTTP ${res.status}`, {
        status: res.status,
        phase: 'read',
        responseUrl,
        contentType
      });
    }
    if (contentType && !contentType.toLowerCase().includes('json')) {
      let bodyPreview = null;
      try { const text = await res.text(); bodyPreview = redactSensitive(text.slice(0, 200)); } catch { /* */ }
      throw new FortimonitorError(
        'FortiMonitor returned a non-JSON response (likely a login page); session not recognized.',
        { status: res.status, phase: 'auth', responseUrl, contentType, bodyPreview }
      );
    }
    return await res.json();
  }

  // ---------------------------------------------------------------
  // Monitoring Policies (FMN-194 capture, FMN-196 consumer)
  //
  // POST endpoints do NOT use X-XSRF-TOKEN (different from
  // /config/save_port_selection). They take form-encoded bodies with
  // X-Requested-With: XMLHttpRequest. See docs/api-discovery/
  // monitoring-policies.md.
  // ---------------------------------------------------------------

  /**
   * Fetch the Monitoring Policies page-data payload. Returns the entire
   * envelope: `{ success, rulesets, defaultServerGroup, nounOptions,
   * actionValueOptions, applySubAccounts, allowOverride, isSubtenant,
   * canOverride }`. Callers typically only consume `rulesets` and
   * `nounOptions` (the latter feeds the recommendation engine's
   * vocabulary-driven policy-clause builder).
   */
  async getMonitoringPolicyPageData() {
    return this._getFortimonitorJson('/monitoring_policy/get_page_data', 'getMonitoringPolicyPageData');
  }

  /**
   * Create a new (empty) ruleset. Returns the server-assigned ruleset
   * object: `{ id, name, latest_version: 0, config: { rules: [] }, ... }`.
   * Caller typically follows up with updateMonitoringPolicyConfig() to
   * populate the rules.
   *
   * @param {object} opts
   * @param {string} opts.name           Ruleset name. Idempotence key when
   *                                     callers check for existing policies.
   * @param {number} [opts.index]        SPA-side ordinal. Defaults to 0;
   *                                     the server assigns the real id.
   * @param {string} [opts.description]
   */
  async createMonitoringPolicy({ name, index = 0, description = '' } = {}) {
    if (!name || typeof name !== 'string') {
      throw new TypeError('createMonitoringPolicy: name is required');
    }
    const json = await this._postMonitoringPolicy('/monitoring_policy/addRuleset', {
      index: String(index),
      name,
      description
    });
    if (!json.ruleset || typeof json.ruleset !== 'object') {
      throw new FortimonitorError('addRuleset response missing ruleset payload', {
        phase: 'write',
        responseBody: json
      });
    }
    return json.ruleset;
  }

  /**
   * Replace a ruleset's rules wholesale. The server stores it under a new
   * version_id and bumps latest_version. Returns the full server response:
   * `{ success, config, ruleset_id, version_id }`.
   *
   * @param {number|string} rulesetId
   * @param {object} config              `{ rules: [...] }` shape per
   *                                     docs/api-discovery/monitoring-policies.md.
   */
  async updateMonitoringPolicyConfig(rulesetId, config) {
    if (rulesetId === undefined || rulesetId === null) {
      throw new TypeError('updateMonitoringPolicyConfig: rulesetId is required');
    }
    if (!config || typeof config !== 'object') {
      throw new TypeError('updateMonitoringPolicyConfig: config object is required');
    }
    return this._postMonitoringPolicy('/monitoring_policy/editRuleset', {
      ruleset_id: String(rulesetId),
      config_json: JSON.stringify(config)
    });
  }

  /**
   * Rename or re-describe a ruleset. Does NOT touch `config.rules`.
   */
  async updateMonitoringPolicyMetadata(rulesetId, { name, description = '' } = {}) {
    if (rulesetId === undefined || rulesetId === null) {
      throw new TypeError('updateMonitoringPolicyMetadata: rulesetId is required');
    }
    if (!name || typeof name !== 'string') {
      throw new TypeError('updateMonitoringPolicyMetadata: name is required');
    }
    return this._postMonitoringPolicy('/monitoring_policy/editRulesetMetadata', {
      ruleset_id: String(rulesetId),
      name,
      description
    });
  }

  /**
   * Delete a ruleset.
   */
  async deleteMonitoringPolicy(rulesetId) {
    if (rulesetId === undefined || rulesetId === null) {
      throw new TypeError('deleteMonitoringPolicy: rulesetId is required');
    }
    return this._postMonitoringPolicy('/monitoring_policy/deleteRuleset', {
      ruleset_id: String(rulesetId)
    });
  }

  // ---------------------------------------------------------------
  // Server templates (FMN-199 + FMN-203 capture, FMN-200 consumer)
  //
  // /config/createServerTemplate takes JSON and DOES require
  // X-XSRF-TOKEN. /config/monitoring/editAgentMetric is form-encoded
  // and does NOT (FMN-203 finding). See:
  //   docs/api-discovery/templates-create.md
  //   docs/api-discovery/template-create-from-device.md
  // ---------------------------------------------------------------

  /**
   * Create a server template. Two modes:
   *   - Shell:        omit `sourceServerId` or pass null.
   *   - Clone-from:   pass `sourceServerId` to copy that server's
   *                   monitoring config + metrics into the new template.
   *
   * @param {object} opts
   * @param {string} opts.name              Template name. Idempotence key.
   * @param {string} opts.templateType      e.g. "fabric_template". One of
   *                                        the values from
   *                                        get_create_server_template_data.
   * @param {string} opts.destinationGroup  Server-group prefixed id
   *                                        (e.g. "grp-617598"). Where the
   *                                        new template lives in the UI.
   * @param {number} [opts.notificationSchedule]  Alert-timeline id
   *                                              (0 = inherit). Default 0.
   * @param {string} [opts.instanceGroupName]     UI group label. Defaults
   *                                              to `name` (FMN-203 capture
   *                                              showed operator using
   *                                              `template_name` as the
   *                                              instance_grp_name).
   * @param {number|null} [opts.sourceServerId]   For clone-from-device.
   * @param {"yes"|"no"} [opts.selectOptions]     `"no"` skips the picker
   *                                              and produces an empty
   *                                              shell when sourceServerId
   *                                              is null. Default "no".
   * @returns {Promise<object>}  Server response JSON. Body shape not yet
   *                             fully captured; status is the
   *                             authoritative success signal.
   */
  async createServerTemplate({
    name,
    templateType,
    destinationGroup,
    notificationSchedule = 0,
    instanceGroupName,
    sourceServerId = null,
    selectOptions = 'no'
  } = {}) {
    if (!name || typeof name !== 'string') {
      throw new TypeError('createServerTemplate: name is required');
    }
    if (!templateType || typeof templateType !== 'string') {
      throw new TypeError('createServerTemplate: templateType is required');
    }
    if (!destinationGroup || typeof destinationGroup !== 'string') {
      throw new TypeError('createServerTemplate: destinationGroup is required (e.g. "grp-617598")');
    }
    const body = {
      server_id: sourceServerId ?? null,
      template_name: name,
      template_type: templateType,
      select_options: selectOptions,
      instance_grp_name: instanceGroupName ?? name,
      notification_schedule: Number(notificationSchedule) || 0,
      element_ids: destinationGroup
    };
    return this._postFortimonitorJsonWithXsrf('/config/createServerTemplate', body);
  }

  /**
   * Get the create-template form's option vocabulary. Returns the
   * `template_type_options` and `alert_timeline_options` arrays the
   * SPA's New Template form populates from.
   */
  async getCreateServerTemplateData() {
    return this._getFortimonitorJson('/config/get_create_server_template_data', 'getCreateServerTemplateData');
  }

  /**
   * Add a Fabric agent_metric to an existing template.
   *
   * Form-encoded POST (NOT JSON). No X-XSRF-Token observed in the
   * captured SPA traffic; X-Requested-With: XMLHttpRequest is required.
   *
   * @param {object} opts
   * @param {number|string} opts.templateId
   * @param {string} opts.pluginTextkey      e.g. "fortigate.resources"
   * @param {string} opts.resourceTextkey    e.g. "memory_usage_percent"
   * @param {string} opts.pluginName         display label
   * @param {string} opts.resourceName       display label
   * @param {string} [opts.units]            e.g. "%". Default empty.
   * @param {number} [opts.frequency]        Polling interval seconds. Default 60.
   * @param {string} [opts.checkMethod]      Discriminator. Default "fabric".
   * @param {string} [opts.matchType]        Default "positive_pattern".
   * @param {boolean} [opts.templateFromScratch]  Default true.
   */
  async addTemplateMetric({
    templateId,
    pluginTextkey,
    resourceTextkey,
    pluginName,
    resourceName,
    units = '',
    frequency = 60,
    checkMethod = 'fabric',
    matchType = 'positive_pattern',
    templateFromScratch = true
  } = {}) {
    if (templateId === undefined || templateId === null) {
      throw new TypeError('addTemplateMetric: templateId is required');
    }
    if (!pluginTextkey || !resourceTextkey) {
      throw new TypeError('addTemplateMetric: pluginTextkey and resourceTextkey are required');
    }
    return this._postFortimonitorForm('/config/monitoring/editAgentMetric', {
      server_id: String(templateId),
      plugin_textkey: pluginTextkey,
      resource_textkey: resourceTextkey,
      check_method: checkMethod,
      plugin_name: pluginName ?? pluginTextkey,
      resource_name: resourceName ?? resourceTextkey,
      server_resource_id: '',           // empty = create new
      action: 'add',
      frequency: String(frequency),
      units,
      isTemplate: 'true',
      template_from_scratch: templateFromScratch ? 'true' : 'false',
      match_type: matchType,
      send_new: 'true'
    });
  }

  // ---------------------------------------------------------------
  // Shared GET / POST helpers for the session-auth surfaces above.
  // ---------------------------------------------------------------

  async _getFortimonitorJson(path, callerLabel) {
    const origin = await this.origin();
    const url = `${origin}${path}`;
    const res = await this.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json, text/plain, */*' }
    });
    const responseUrl = redactSensitive(res.url ?? url);
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (!res.ok) {
      throw new FortimonitorError(`${callerLabel || path} failed: HTTP ${res.status}`, {
        status: res.status,
        phase: 'read',
        responseUrl,
        contentType
      });
    }
    if (contentType && !contentType.toLowerCase().includes('json')) {
      let bodyPreview = null;
      try { const text = await res.text(); bodyPreview = redactSensitive(text.slice(0, 200)); } catch { /* */ }
      throw new FortimonitorError(
        'FortiMonitor returned a non-JSON response (likely a login page); session not recognized.',
        { status: res.status, phase: 'auth', responseUrl, contentType, bodyPreview }
      );
    }
    return await res.json();
  }

  async _postMonitoringPolicy(path, formParams) {
    const origin = await this.origin();
    const url = `${origin}${path}`;
    const body = new URLSearchParams(formParams).toString();
    const res = await this.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body
    });
    const responseUrl = redactSensitive(res.url ?? url);
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (!res.ok) {
      throw new FortimonitorError(`${path} failed: HTTP ${res.status}`, {
        status: res.status,
        phase: 'write',
        responseUrl,
        contentType
      });
    }
    if (contentType && !contentType.toLowerCase().includes('json')) {
      let bodyPreview = null;
      try { const text = await res.text(); bodyPreview = redactSensitive(text.slice(0, 200)); } catch { /* */ }
      throw new FortimonitorError(
        'FortiMonitor returned a non-JSON response (likely a login page); session unauthenticated for monitoring_policy operations.',
        { status: res.status, phase: 'auth', responseUrl, contentType, bodyPreview }
      );
    }
    const json = await res.json();
    if (!json || json.success !== true) {
      throw new FortimonitorError(`${path} rejected by server`, {
        phase: 'write',
        responseBody: json
      });
    }
    return json;
  }

  /**
   * POST helper: JSON body + X-XSRF-TOKEN (required). Used by
   * /config/createServerTemplate per FMN-199/203 capture.
   */
  async _postFortimonitorJsonWithXsrf(path, jsonBody) {
    const origin = await this.origin();
    const xsrf = await this.getCookie(XSRF_COOKIE_NAME, origin);
    if (!xsrf) {
      throw new FortimonitorError(
        `No ${XSRF_COOKIE_NAME} cookie - user is not logged in to FortiMonitor.`,
        { phase: 'auth' }
      );
    }
    const url = `${origin}${path}`;
    const res = await this.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'X-XSRF-TOKEN': xsrf
      },
      body: JSON.stringify(jsonBody)
    });
    const responseUrl = redactSensitive(res.url ?? url);
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (!res.ok) {
      throw new FortimonitorError(`${path} failed: HTTP ${res.status}`, {
        status: res.status,
        phase: 'write',
        responseUrl,
        contentType
      });
    }
    if (contentType && !contentType.toLowerCase().includes('json')) {
      let bodyPreview = null;
      try { const text = await res.text(); bodyPreview = redactSensitive(text.slice(0, 200)); } catch { /* */ }
      throw new FortimonitorError(
        'FortiMonitor returned a non-JSON response (likely a login page); session unauthenticated.',
        { status: res.status, phase: 'auth', responseUrl, contentType, bodyPreview }
      );
    }
    // Response body may be empty on success for some FortiMonitor write
    // endpoints (observed FMN-199 capture). Try to parse; if empty,
    // return a synthesized success envelope so callers can treat the
    // 200 as authoritative.
    try {
      const json = await res.json();
      return json ?? { success: true };
    } catch {
      return { success: true };
    }
  }

  /**
   * POST helper: form-encoded body, no X-XSRF-TOKEN, with
   * X-Requested-With. Used by /config/monitoring/editAgentMetric
   * per FMN-203 capture.
   */
  async _postFortimonitorForm(path, formParams) {
    const origin = await this.origin();
    const url = `${origin}${path}`;
    const body = new URLSearchParams(formParams).toString();
    const res = await this.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body
    });
    const responseUrl = redactSensitive(res.url ?? url);
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (!res.ok) {
      throw new FortimonitorError(`${path} failed: HTTP ${res.status}`, {
        status: res.status,
        phase: 'write',
        responseUrl,
        contentType
      });
    }
    if (contentType && !contentType.toLowerCase().includes('json')) {
      let bodyPreview = null;
      try { const text = await res.text(); bodyPreview = redactSensitive(text.slice(0, 200)); } catch { /* */ }
      throw new FortimonitorError(
        'FortiMonitor returned a non-JSON response (likely a login page); session unauthenticated.',
        { status: res.status, phase: 'auth', responseUrl, contentType, bodyPreview }
      );
    }
    try {
      const json = await res.json();
      return json ?? { success: true };
    } catch {
      return { success: true };
    }
  }
}

/**
 * Production factory. Wires chrome.cookies and global fetch. The origin
 * resolver is injected so the service worker can pick the tenant URL
 * (regional my.*.fortimonitor.com vs. the federation URL) once and
 * cache it for the life of the worker.
 *
 * @param {object} [deps]
 * @param {string|(() => Promise<string>)} [deps.origin] override for tests
 */
export function createProductionClient({ origin = FM_ORIGIN } = {}) {
  return new FortimonitorClient({
    fetch: globalThis.fetch.bind(globalThis),
    getCookie: async (name, urlOverride) => {
      // eslint-disable-next-line no-undef
      const c = await chrome.cookies.get({ url: urlOverride ?? FM_ORIGIN, name });
      return c?.value ?? null;
    },
    origin
  });
}
