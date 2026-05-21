// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FortiMonitor v2 public API client (Panopta hosted).
//
// Used by the Add Fabric Connection (Bulk) tool. Unlike FortimonitorClient
// (which rides FortiMonitor session cookies for internal-UI endpoints), this
// client uses an `Authorization: ApiKey {key}` header with a user-supplied
// RW API key.
//
// Per-tool auth-choice rule: tools whose capability lives only in the UI
// (port scope) use FortimonitorClient. Tools whose capability is exposed
// cleanly in v2 (fabric_connection) use this client. See project memory
// `no_fortimonitor_api.md`.
//
// All IO is injectable so this module is testable in Node without any
// Chrome APIs. See createProductionPanoptaClient() at the bottom for the
// production factory that wires global fetch + chrome.storage.

export const PANOPTA_BASE = 'https://api2.panopta.com/v2';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// 401 Unauthorized and 403 Forbidden are the textbook auth failures. 405
// Method Not Allowed shows up too because FortiMonitor's RO keys reject
// write methods at the routing layer rather than returning 403.
const AUTH_LIKE_STATUSES = new Set([401, 403, 405]);

export class PanoptaError extends Error {
  constructor(message, {
    status = null,
    phase = null,
    responseBody = null,
    responseUrl = null,
    contentType = null
  } = {}) {
    super(message);
    this.name = 'PanoptaError';
    this.status = status;
    this.phase = phase;
    this.responseBody = responseBody;
    this.responseUrl = responseUrl;
    this.contentType = contentType;
  }
}

/**
 * Redact long opaque tokens and query strings from diagnostic text
 * before it is surfaced in errors. API keys frequently appear in URLs
 * or response echoes - strip them before they reach log surfaces.
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
 * Build the request body the v2 fabric_connection endpoint expects.
 * `appliance_group` is omitted (not nulled) when not provided so the API
 * default kicks in - the sibling Python script does the same.
 */
export function buildFabricConnectionPayload({
  serial,
  ip,
  port,
  onsightUrl,
  serverGroupUrl,
  applianceGroupUrl = null,
  label = null,
  discoverFrequency = 60,
  fortiosVersion = 7,
  verifySslCert = false,
  importImmediately = false
}) {
  if (!serial) throw new TypeError('buildFabricConnectionPayload: serial is required');
  if (!ip) throw new TypeError('buildFabricConnectionPayload: ip is required');
  if (!Number.isFinite(Number(port))) {
    throw new TypeError('buildFabricConnectionPayload: port must be numeric');
  }
  if (!onsightUrl) throw new TypeError('buildFabricConnectionPayload: onsightUrl is required');
  if (!serverGroupUrl) throw new TypeError('buildFabricConnectionPayload: serverGroupUrl is required');

  const payload = {
    integration_type: 'onsight_csf_tunnel',
    label: label || ip,
    onsight: onsightUrl,
    server_group: serverGroupUrl,
    upstream_host: ip,
    upstream_port: Number(port),
    upstream_sn: serial,
    fortios_version: fortiosVersion,
    discover_frequency: discoverFrequency,
    verify_ssl_cert: verifySslCert,
    import_immediately: importImmediately
  };
  if (applianceGroupUrl) payload.appliance_group = applianceGroupUrl;
  return payload;
}

/**
 * Normalize a v2 list response (e.g., /v2/onsight, /v2/server_group,
 * /v2/onsight_group). The v2 API wraps list payloads under a
 * resource-specific key (`onsight_list`, `server_group_list`,
 * `onsight_group_list`), not the historical `objects` array - callers
 * pass the wrapper key explicitly.
 *
 * Items typically expose `url` (full URL ending in the resource id) and
 * `name`. `id` is extracted from the trailing numeric segment of `url`
 * when not present directly, mirroring parseServerListResponse.
 *
 * Returns an array of { id, name, resourceUrl } suitable for dropdowns
 * and for passing resourceUrl back to write endpoints.
 *
 * Note: the original implementation expected `{ objects: [...] }` per
 * an earlier (incorrect) schema assumption. That shape was never
 * returned by the live tenant; the bug surfaced during FMN-119 live
 * E2E rollout when Add Fabric Connection's start step failed to
 * populate its dropdowns. See test/panopta-client.test.js for the
 * corrected shapes by wrapper key.
 */
const LIST_ITEM_URL_ID_RE = /\/(\d+)\/?$/;

// FMN-206: surface structured v2 API errors. The API uses three
// different error-body shapes depending on endpoint and validation
// path. Returns a single human-readable string or null when the body
// has nothing useful in it (callers fall back to method/path).
export function extractApiErrorMessage(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.message === 'string' && parsed.message.trim()) {
    return parsed.message;
  }
  if (typeof parsed.error === 'string' && parsed.error.trim()) {
    return parsed.error;
  }
  // Per-field validation errors: { field_name: "Please enter a ..." }.
  // Surface as "field1: msg1; field2: msg2" so the operator sees
  // exactly which fields the server rejected.
  const fieldEntries = Object.entries(parsed)
    .filter(([, v]) => typeof v === 'string' && v.trim());
  if (fieldEntries.length > 0) {
    return fieldEntries.map(([k, v]) => `${k}: ${v}`).join('; ');
  }
  return null;
}

// FMN-206: GET /server/{id} returns several fields the PUT validator
// then refuses to accept echoed-back unchanged. Reconcile them before
// any PUT round-trip so a tag flip doesn't randomly 400 on instances
// the operator never customized.
//
// Cases observed on a live tenant (2026-05-13 HAR):
//   - geo_latitude / geo_longitude come back as quoted strings ("61.21")
//     but PUT rejects with "Please enter a valid integer or float".
//   - snmp_heartbeat_enabled=true paired with snmp_scan_frequency=0 yields
//     "Can't enable SNMP heartbeat on a non-SNMP instance." The instance
//     was migrated into an inconsistent state; we conform the body to
//     what the validator accepts (heartbeat disabled when scanning is off).
//
// The helper only adjusts fields that fail validation. Fields the
// operator intends to change (e.g. tags) are passed through untouched.
export function sanitizeServerBodyForPut(server) {
  if (!server || typeof server !== 'object') return server;
  const out = { ...server };

  const coerceLatLong = (key) => {
    if (out[key] === null || out[key] === undefined) return;
    if (typeof out[key] === 'number') return;
    const n = parseFloat(out[key]);
    out[key] = Number.isFinite(n) ? n : null;
  };
  coerceLatLong('geo_latitude');
  coerceLatLong('geo_longitude');

  // SNMP heartbeat can only be enabled when SNMP scanning is configured.
  // snmp_scan_frequency = 0 / null / undefined means SNMP is off.
  if (out.snmp_heartbeat_enabled === true && !out.snmp_scan_frequency) {
    out.snmp_heartbeat_enabled = false;
    out.snmp_heartbeat_notification_schedule = null;
  }

  return out;
}

export function parseListResponse(json, wrapperKey, baseUrl = PANOPTA_BASE) {
  if (!wrapperKey || typeof wrapperKey !== 'string') {
    throw new TypeError('parseListResponse: wrapperKey is required');
  }
  if (!json || typeof json !== 'object' || !Array.isArray(json[wrapperKey])) {
    throw new PanoptaError(`Malformed list response: missing ${wrapperKey} array`, {
      phase: 'read',
      responseBody: json
    });
  }
  const root = baseUrl.replace(/\/v2$/, '');
  return json[wrapperKey].map((o) => {
    let id = o.id ?? null;
    if (id == null && typeof o.url === 'string') {
      const m = o.url.match(LIST_ITEM_URL_ID_RE);
      if (m) id = Number(m[1]);
    }
    let resourceUrl = null;
    if (typeof o.url === 'string') {
      resourceUrl = o.url;
    } else if (typeof o.resource_uri === 'string') {
      resourceUrl = `${root}${o.resource_uri}`;
    }
    return {
      id,
      name: o.name ?? (id != null ? `#${id}` : '(unnamed)'),
      resourceUrl
    };
  });
}

/**
 * Normalize a /v2/server list response. Differs from parseListResponse
 * in two ways:
 *   1. Wrapper is `server_list`, not `objects`.
 *   2. Items do not expose `id` or `resource_uri` directly - the numeric
 *      server id is only reachable by parsing the trailing segment of
 *      the `url` field (e.g. ".../v2/server/40234446"). We still honor
 *      `o.id` / `o.resource_uri` defensively in case a future API build
 *      adds them.
 */
const SERVER_URL_ID_RE = /\/server\/(\d+)\/?$/;

export function parseServerListResponse(json, baseUrl = PANOPTA_BASE) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.server_list)) {
    throw new PanoptaError('Malformed /server list response: missing server_list array', {
      phase: 'read',
      responseBody: json
    });
  }
  const root = baseUrl.replace(/\/v2$/, '');
  return json.server_list.map((o) => {
    let id = o.id ?? null;
    if (id == null && typeof o.url === 'string') {
      const m = o.url.match(SERVER_URL_ID_RE);
      if (m) id = Number(m[1]);
    }
    let resourceUrl = null;
    if (typeof o.url === 'string') {
      resourceUrl = o.url;
    } else if (typeof o.resource_uri === 'string') {
      resourceUrl = `${root}${o.resource_uri}`;
    }
    return {
      id,
      name: o.name ?? (id != null ? `#${id}` : '(unnamed)'),
      resourceUrl
    };
  });
}

export class PanoptaClient {
  /**
   * @param {object} deps
   * @param {string} deps.apiKey
   * @param {typeof fetch} deps.fetch
   * @param {string} [deps.baseUrl]
   */
  constructor({ apiKey, fetch, baseUrl = PANOPTA_BASE } = {}) {
    if (!apiKey) throw new TypeError('PanoptaClient requires an apiKey');
    if (typeof fetch !== 'function') {
      throw new TypeError('PanoptaClient requires a fetch function');
    }
    this.apiKey = apiKey;
    this.fetch = fetch;
    this.baseUrl = baseUrl;
  }

  _headers(extra = {}) {
    return {
      'Authorization': `ApiKey ${this.apiKey}`,
      'Accept': 'application/json',
      ...extra
    };
  }

  /**
   * Public single-shot GET helper. Returns the parsed JSON body. Used by
   * tools (e.g. Tenant Observations) that need to fetch arbitrary endpoints not
   * covered by a dedicated wrapper. Errors surface as PanoptaError - 401
   * is phase='auth', 404 throws status=404, 5xx throws status=5xx.
   */
  async getJson(path) {
    const { body } = await this._request('GET', path);
    return body;
  }

  /**
   * Public paginated walk over `endpoint`. Thin alias for the internal
   * _paginatedList so external modules don't have to reach into a name
   * convention they shouldn't depend on. Same options.
   */
  async paginate(endpoint, opts = {}) {
    return this._paginatedList(endpoint, opts);
  }

  async _request(method, path, { body = null } = {}) {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const init = { method, headers: this._headers() };
    if (body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await this.fetch(url, init);
    } catch (err) {
      throw new PanoptaError(`Network error: ${err?.message ?? err}`, { phase: 'network' });
    }
    let parsed = null;
    const ct = res.headers?.get?.('content-type') ?? '';
    if (ct.includes('application/json')) {
      try { parsed = await res.json(); } catch { parsed = null; }
    } else {
      try { parsed = await res.text(); } catch { parsed = null; }
    }
    if (!res.ok) {
      // FMN-206: the v2 API surfaces three error-body shapes we want to
      // expose in the UI instead of the generic `${method} ${path} failed`:
      //   { message: "..." }                  - canonical
      //   { error: "human prose" }            - some endpoints
      //   { field1: "This field is invalid",  - PUT validation errors
      //     field2: "..." }
      // extractApiErrorMessage tries each in turn; falls back to the
      // method/path line so callers always get *something* useful.
      const baseMessage = extractApiErrorMessage(parsed)
        || `${method} ${path} failed: HTTP ${res.status}`;
      const isWriteMethod = WRITE_METHODS.has(method);
      const isAuthLikeWriteFailure = isWriteMethod && AUTH_LIKE_STATUSES.has(res.status);
      const message = isAuthLikeWriteFailure
        ? `Your API key may be read-only - verify in popup → ⚙ Settings. (${baseMessage})`
        : baseMessage;
      throw new PanoptaError(message, {
        status: res.status,
        phase: (res.status === 401 || isAuthLikeWriteFailure) ? 'auth' : 'write',
        responseBody: typeof parsed === 'string' ? redactSensitive(parsed.slice(0, 200)) : parsed,
        responseUrl: redactSensitive(res.url ?? url),
        contentType: ct
      });
    }
    return { res, body: parsed };
  }

  async createFabricConnection(input) {
    const payload = buildFabricConnectionPayload(input);
    const { res, body } = await this._request('POST', '/fabric_connection', { body: payload });
    return {
      status: res.status,
      location: res.headers?.get?.('location') ?? null,
      resourceId: res.headers?.get?.('id') ?? (body?.id ?? null),
      body
    };
  }

  async listOnsight({ limit = 100 } = {}) {
    const { body } = await this._request('GET', `/onsight?limit=${limit}`);
    return parseListResponse(body, 'onsight_list', this.baseUrl);
  }

  async listServerGroups({ limit = 100 } = {}) {
    const { body } = await this._request('GET', `/server_group?limit=${limit}`);
    return parseListResponse(body, 'server_group_list', this.baseUrl);
  }

  /**
   * Create a new server group by name (FMN-200 follow-up). Returns
   * `{ id, name, resourceUrl }` matching the parseListResponse shape.
   *
   * v2 POST /server_group expects `{ name }`. Other fields (parent,
   * customer, etc.) are accepted optionally; we omit them for the
   * top-level "FM Toolkit Templates"-style groups the Bulk Composer
   * creates.
   *
   * Frontend session-auth alternative is not yet captured; v2 fallback
   * per FMN-196 operator decision (frontend-primary, v2-fallback).
   *
   * @param {string} name
   */
  async createServerGroup(name) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new TypeError('createServerGroup: name is required');
    }
    const { body, res } = await this._request('POST', `/server_group`, {
      body: { name: name.trim() }
    });
    if (!body || typeof body !== 'object') {
      throw new PanoptaError('Malformed server_group create response', {
        phase: 'write',
        responseBody: body,
        status: res.status
      });
    }
    // v2 typically returns the created resource directly. Normalize to
    // the same shape parseListResponse produces.
    const url = typeof body.url === 'string' ? body.url : null;
    let id = body.id ?? null;
    if (id == null && url) {
      const m = url.match(/\/server_group\/(\d+)\/?$/);
      if (m) id = Number(m[1]);
    }
    return {
      id,
      name: body.name ?? name.trim(),
      resourceUrl: url
    };
  }

  async listOnsightGroups({ limit = 100 } = {}) {
    const { body } = await this._request('GET', `/onsight_group?limit=${limit}`);
    return parseListResponse(body, 'onsight_group_list', this.baseUrl);
  }

  /**
   * Look up servers whose name exactly matches `name`.
   *
   * The v2 `/server?name=` filter is a substring/contains match (verified
   * live 2026-04-17 - partial prefix returned 3 hits). We pass the term
   * through unchanged for server-side prefiltering, then enforce exact
   * equality client-side. Case-sensitive - callers wanting CI must lower
   * both sides themselves.
   *
   * Returns an array (0, 1, or N matches). Caller decides how to handle
   * not-found and ambiguous outcomes.
   */
  async lookupServersByName(name, { limit = 50 } = {}) {
    if (!name || typeof name !== 'string') {
      throw new TypeError('lookupServersByName: name is required');
    }
    const path = `/server?name=${encodeURIComponent(name)}&limit=${limit}`;
    const { body } = await this._request('GET', path);
    const all = parseServerListResponse(body, this.baseUrl);
    return all.filter((s) => s.name === name);
  }

  /**
   * Cheap probe used by the settings UI's "Test Connection" button.
   * 200 → key works (read access at minimum); 401 → bad key.
   * This does NOT verify RW vs RO permissions - that surfaces only on
   * the actual POST.
   */
  async testConnection() {
    const { res } = await this._request('GET', '/onsight?limit=1');
    return { ok: true, status: res.status };
  }

  // ---- Server attribute management (FMN-48) -----------------------------
  //
  // Two-resource model (see docs/api-discovery/attributes.md):
  //   * server_attribute_type - the "key" (customer-global, has name/textkey)
  //   * server_attribute      - the "value" attached to one server
  //
  // Endpoints:
  //   GET    /server_attribute_type
  //   GET    /server/{id}/server_attribute
  //   POST   /server/{id}/server_attribute       body: { server_attribute_type: <url>, value }
  //   DELETE /server/{id}/server_attribute/{aid}
  //
  // v1 scope: manipulate values only; do NOT create/edit/delete types.

  /**
   * List all attribute types the customer owns (for the UI dropdown).
   * Pages through until total_count is exhausted - the test account has
   * 183 types so one round trip at limit=200 is sufficient in practice,
   * but we page to be safe.
   *
   * @returns {Promise<Array<{id:number, name:string, textkey:string, resourceUrl:string}>>}
   */
  async listAttributeTypes({ pageSize = 200, maxPages = 10 } = {}) {
    const out = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const { body } = await this._request('GET', `/server_attribute_type?limit=${pageSize}&offset=${offset}`);
      if (!body || !Array.isArray(body.server_attribute_type_list)) {
        throw new PanoptaError('Malformed server_attribute_type list response', {
          phase: 'read',
          responseBody: body
        });
      }
      for (const t of body.server_attribute_type_list) {
        const id = typeof t.url === 'string'
          ? Number(t.url.split('/').filter(Boolean).pop())
          : null;
        out.push({
          id,
          name: t.name,
          textkey: t.textkey,
          resourceUrl: t.url
        });
      }
      const total = body.meta?.total_count ?? out.length;
      offset += body.server_attribute_type_list.length;
      if (offset >= total || body.server_attribute_type_list.length === 0) break;
    }
    return out;
  }

  /**
   * List all attributes currently attached to a server.
   *
   * @returns {Promise<Array<{id:number, name:string, textkey:string, value:string, typeUrl:string, resourceUrl:string}>>}
   */
  async listServerAttributes(serverId, { pageSize = 200, maxPages = 5 } = {}) {
    if (!serverId) throw new TypeError('listServerAttributes: serverId is required');
    const out = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const { body } = await this._request(
        'GET',
        `/server/${encodeURIComponent(serverId)}/server_attribute?limit=${pageSize}&offset=${offset}`
      );
      if (!body || !Array.isArray(body.server_attribute_list)) {
        throw new PanoptaError('Malformed server_attribute list response', {
          phase: 'read',
          responseBody: body
        });
      }
      for (const a of body.server_attribute_list) {
        const id = typeof a.url === 'string'
          ? Number(a.url.split('/').filter(Boolean).pop())
          : null;
        out.push({
          id,
          name: a.name,
          textkey: a.textkey,
          value: a.value,
          typeUrl: a.server_attribute_type,
          resourceUrl: a.url
        });
      }
      const total = body.meta?.total_count ?? out.length;
      offset += body.server_attribute_list.length;
      if (offset >= total || body.server_attribute_list.length === 0) break;
    }
    return out;
  }

  /**
   * Attach an attribute value to a server.
   *
   * @param {string|number} serverId
   * @param {object} params
   * @param {string} params.typeUrl  Full URL of an existing server_attribute_type
   * @param {string} params.value
   * @returns {Promise<{status:number, location:string|null, resourceId:string|number|null, body:any}>}
   */
  async createServerAttribute(serverId, { typeUrl, value } = {}) {
    if (!serverId) throw new TypeError('createServerAttribute: serverId is required');
    if (!typeUrl) throw new TypeError('createServerAttribute: typeUrl is required');
    if (value === undefined || value === null) {
      throw new TypeError('createServerAttribute: value is required');
    }
    const payload = { server_attribute_type: typeUrl, value: String(value) };
    const { res, body } = await this._request(
      'POST',
      `/server/${encodeURIComponent(serverId)}/server_attribute`,
      { body: payload }
    );
    return {
      status: res.status,
      location: res.headers?.get?.('location') ?? null,
      resourceId: res.headers?.get?.('id') ?? (body?.id ?? null),
      body
    };
  }

  /**
   * Remove an attribute from a server. Accepts either a full resource URL
   * (preferred - comes straight from listServerAttributes) or a
   * {serverId, attributeId} pair.
   *
   * @returns {Promise<{status:number}>}
   */
  async deleteServerAttribute(refOrIds) {
    let path;
    if (typeof refOrIds === 'string') {
      path = refOrIds; // full URL → _request short-circuits on http(s)
    } else if (refOrIds && refOrIds.serverId && refOrIds.attributeId) {
      path = `/server/${encodeURIComponent(refOrIds.serverId)}/server_attribute/${encodeURIComponent(refOrIds.attributeId)}`;
    } else {
      throw new TypeError('deleteServerAttribute: pass a resourceUrl or { serverId, attributeId }');
    }
    const { res } = await this._request('DELETE', path);
    return { status: res.status };
  }

  // ---- Server template management (FMN-49) ------------------------------
  //
  // See docs/api-discovery/templates.md. Templates are their own resource
  // (/server_template) and the attach/detach relationship lives on the
  // server side as a mapping resource:
  //   GET    /server_template                          (catalog)
  //   GET    /server/{id}/template                     (list attached)
  //   POST   /server/{id}/template                     body: { continuous, server_template(url) }
  //   DELETE /server/{id}/template/{server_template_id}  optional body: { strategy }
  //
  // The DELETE's strategy query parameter is the most sensitive part of
  // this tool: "dissociate" (default) unlinks only; "delete" also wipes
  // metrics and attributes the template seeded - destructive, no undo.

  /**
   * List all monitoring templates the customer owns (for the template
   * picker in the start step). Pages through until total_count is
   * exhausted.
   *
   * @returns {Promise<Array<{id:number, name:string, templateType:string, serverGroupUrl:string, resourceUrl:string, appliedServerUrls:string[]}>>}
   */
  async listTemplates({ pageSize = 100, maxPages = 20 } = {}) {
    const out = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const { body } = await this._request('GET', `/server_template?limit=${pageSize}&offset=${offset}`);
      if (!body || !Array.isArray(body.server_template_list)) {
        throw new PanoptaError('Malformed server_template list response', {
          phase: 'read',
          responseBody: body
        });
      }
      for (const t of body.server_template_list) {
        const id = typeof t.url === 'string'
          ? Number(t.url.split('/').filter(Boolean).pop())
          : null;
        out.push({
          id,
          name: t.name ?? `#${id}`,
          templateType: t.template_type ?? null,
          serverGroupUrl: t.server_group ?? null,
          resourceUrl: t.url,
          appliedServerUrls: Array.isArray(t.applied_servers) ? t.applied_servers : []
        });
      }
      const total = body.meta?.total_count ?? out.length;
      offset += body.server_template_list.length;
      if (offset >= total || body.server_template_list.length === 0) break;
    }
    return out;
  }

  /**
   * Fetch a single server template, including its applied_servers list.
   * FMN-121: Find Servers's applied_template criterion uses this to
   * resolve the set of servers a template is attached to in one call,
   * rather than paginating the full template catalog.
   *
   * @param {number|string} templateId
   * @returns {Promise<{id:number, name:string, resourceUrl:string|null, appliedServerUrls:string[], appliedServerIds:number[]}>}
   */
  async getServerTemplate(templateId) {
    if (templateId == null || templateId === '') {
      throw new TypeError('getServerTemplate: templateId is required');
    }
    const { body } = await this._request('GET', `/server_template/${encodeURIComponent(templateId)}`);
    if (!body || typeof body !== 'object') {
      throw new PanoptaError('Malformed server_template response', { phase: 'read', responseBody: body });
    }
    const appliedUrls = Array.isArray(body.applied_servers) ? body.applied_servers : [];
    const appliedIds = [];
    for (const url of appliedUrls) {
      if (typeof url !== 'string') continue;
      const m = url.match(/\/server\/(\d+)\/?$/);
      if (m) appliedIds.push(Number(m[1]));
    }
    const id = typeof body.url === 'string'
      ? Number(body.url.split('/').filter(Boolean).pop())
      : Number(templateId);
    return {
      id,
      name: body.name ?? `#${id}`,
      resourceUrl: body.url ?? null,
      appliedServerUrls: appliedUrls,
      appliedServerIds: appliedIds
    };
  }

  /**
   * List the templates currently attached to a server. Used by the
   * preview step to decide attach-vs-skip / detach-vs-skip per row.
   *
   * Note: the mapping resource shape is NOT the full template - it's
   * `{continuous, server_template: <url>}`. Caller extracts templateId
   * from the URL.
   *
   * @returns {Promise<Array<{continuous:boolean, templateUrl:string, templateId:number|null}>>}
   */
  async listServerTemplateMappings(serverId, { pageSize = 100, maxPages = 5 } = {}) {
    if (!serverId) throw new TypeError('listServerTemplateMappings: serverId is required');
    const out = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const { body } = await this._request(
        'GET',
        `/server/${encodeURIComponent(serverId)}/template?limit=${pageSize}&offset=${offset}`
      );
      if (!body || !Array.isArray(body.server_template_list)) {
        throw new PanoptaError('Malformed server template mapping list response', {
          phase: 'read',
          responseBody: body
        });
      }
      for (const m of body.server_template_list) {
        const templateUrl = m.server_template ?? null;
        const templateId = typeof templateUrl === 'string'
          ? Number(templateUrl.split('/').filter(Boolean).pop())
          : null;
        out.push({
          continuous: Boolean(m.continuous),
          templateUrl,
          templateId
        });
      }
      const total = body.meta?.total_count ?? out.length;
      offset += body.server_template_list.length;
      if (offset >= total || body.server_template_list.length === 0) break;
    }
    return out;
  }

  /**
   * Attach a template to a server. `continuous=true` (default) matches
   * the FortiMonitor UI's default: the template keeps adding new metrics
   * to the server as data collection discovers them.
   *
   * The API does NOT deduplicate - a repeat POST creates a second
   * mapping row. Callers are expected to pre-flight via
   * listServerTemplateMappings and skip already-attached rows.
   *
   * @returns {Promise<{status:number, location:string|null, resourceId:string|number|null}>}
   */
  async attachTemplate(serverId, { templateUrl, continuous = true } = {}) {
    if (!serverId) throw new TypeError('attachTemplate: serverId is required');
    if (!templateUrl) throw new TypeError('attachTemplate: templateUrl is required');
    const payload = { continuous: Boolean(continuous), server_template: templateUrl };
    const { res, body } = await this._request(
      'POST',
      `/server/${encodeURIComponent(serverId)}/template`,
      { body: payload }
    );
    return {
      status: res.status,
      location: res.headers?.get?.('location') ?? null,
      resourceId: res.headers?.get?.('id') ?? (body?.id ?? null)
    };
  }

  // ---- Chat prototype read-only helpers (FMN-53) ------------------------
  //
  // Narrow slice of the v2 API surfaced to the in-plugin Claude chat.
  // See docs/mcp-chat-prototype.md. All methods here are GET-only except
  // acknowledgeOutage, which is gated behind a UI confirm in the chat.

  async listServers({ limit = 50, offset = 0, name = null } = {}) {
    const params = [`limit=${limit}`, `offset=${offset}`];
    if (name) params.push(`name=${encodeURIComponent(name)}`);
    const { body } = await this._request('GET', `/server?${params.join('&')}`);
    return body;
  }

  async getServer(serverId) {
    if (!serverId) throw new TypeError('getServer: serverId is required');
    const { body } = await this._request('GET', `/server/${encodeURIComponent(serverId)}`);
    return body;
  }

  async listOutages({ limit = 50, offset = 0, serverId = null, active = false } = {}) {
    const params = [`limit=${limit}`, `offset=${offset}`];
    if (serverId) params.push(`server_id=${encodeURIComponent(serverId)}`);
    const path = active ? '/outage/active' : '/outage';
    const { body } = await this._request('GET', `${path}?${params.join('&')}`);
    return body;
  }

  async getOutage(outageId) {
    if (!outageId) throw new TypeError('getOutage: outageId is required');
    const { body } = await this._request('GET', `/outage/${encodeURIComponent(outageId)}`);
    return body;
  }

  async listAgentResourcesForServer(serverId, { limit = 50, offset = 0 } = {}) {
    if (!serverId) throw new TypeError('listAgentResourcesForServer: serverId is required');
    const params = [`limit=${limit}`, `offset=${offset}`];
    const { body } = await this._request(
      'GET',
      `/server/${encodeURIComponent(serverId)}/agent_resource?${params.join('&')}`
    );
    return body;
  }

  // ---- SD-WAN Report (FMN-129) -----------------------------------------
  //
  // Paginated walks of the per-server resource collections that the
  // SD-WAN report classifies. Each method returns a flat array; pagination
  // and envelope-key probing are handled internally so callers only deal
  // with records.
  //
  // Pagination probes a fixed list of known wrapper keys because v2
  // varies the envelope by endpoint (server_list, snmp_resource_list,
  // agent_resource_list, network_services, objects, ...). The Python
  // source does the same. _paginatedList handles that probing once.

  /**
   * Internal: page through `endpoint` and flatten records out of whatever
   * envelope the server returns. Honors AbortSignal between pages.
   */
  async _paginatedList(endpoint, { pageSize = 100, maxPages = 200, signal } = {}) {
    const KNOWN_KEYS = [
      'server_list', 'snmp_resource_list', 'agent_resource_list',
      'agent_resources', 'network_services', 'objects',
      'server_group_list', 'outage_list', 'data', 'results', 'items'
    ];
    const out = [];
    let offset = 0;
    let total = Infinity;
    for (let page = 0; page < maxPages; page++) {
      if (signal?.aborted) {
        const err = new Error('aborted'); err.name = 'AbortError'; throw err;
      }
      const sep = endpoint.includes('?') ? '&' : '?';
      const path = `${endpoint}${sep}limit=${pageSize}&offset=${offset}`;
      const { body } = await this._request('GET', path);
      let list = null;
      if (Array.isArray(body)) {
        list = body;
      } else if (body && typeof body === 'object') {
        for (const k of KNOWN_KEYS) {
          if (Array.isArray(body[k])) { list = body[k]; break; }
        }
        if (list === null) {
          for (const [k, v] of Object.entries(body)) {
            if (k === 'meta') continue;
            if (Array.isArray(v)) { list = v; break; }
          }
        }
      }
      if (!Array.isArray(list)) list = [];
      if (typeof body?.meta?.total_count === 'number') total = body.meta.total_count;
      for (const r of list) out.push(r);
      offset += list.length;
      if (list.length === 0) break;
      if (Number.isFinite(total) && offset >= total) break;
    }
    return out;
  }

  /**
   * Page through every monitored server. Used by the SD-WAN report to
   * crawl the full instance list.
   *
   * @returns {Promise<object[]>}
   */
  async listAllServers({ pageSize = 25, signal } = {}) {
    return this._paginatedList('/server', { pageSize, signal });
  }

  /**
   * Page through every server_group. Used as a non-fatal labelling pass
   * for the SD-WAN report - if it fails, group labels are simply blank.
   *
   * @returns {Promise<object[]>}
   */
  async listAllServerGroups({ pageSize = 100, signal } = {}) {
    return this._paginatedList('/server_group', { pageSize, signal });
  }

  /**
   * Page through SNMP resources for a server. Larger page size since the
   * server-side limit is generous and SNMP rows are small.
   */
  async listSnmpResourcesForServer(serverId, { pageSize = 200, signal } = {}) {
    if (!serverId) throw new TypeError('listSnmpResourcesForServer: serverId is required');
    return this._paginatedList(`/server/${encodeURIComponent(serverId)}/snmp_resource`, { pageSize, signal });
  }

  /**
   * Page through agent_resources for a server.
   */
  async listAllAgentResourcesForServer(serverId, { pageSize = 100, signal } = {}) {
    if (!serverId) throw new TypeError('listAllAgentResourcesForServer: serverId is required');
    return this._paginatedList(`/server/${encodeURIComponent(serverId)}/agent_resource`, { pageSize, signal });
  }

  /**
   * Page through network_service checks for a server.
   */
  async listNetworkServicesForServer(serverId, { pageSize = 100, signal } = {}) {
    if (!serverId) throw new TypeError('listNetworkServicesForServer: serverId is required');
    return this._paginatedList(`/server/${encodeURIComponent(serverId)}/network_service`, { pageSize, signal });
  }

  async listFabricConnections({ limit = 50, offset = 0 } = {}) {
    const { body } = await this._request(
      'GET',
      `/fabric_connection?limit=${limit}&offset=${offset}`
    );
    return body;
  }

  // ---- Server tag management (FMN-155 / FMN-206) -----------------------
  //
  // The v2 API exposes server `tags` as a string-array attribute on the
  // /server/{id} record. There is no dedicated /tag endpoint - mutations
  // go through PUT /server/{id} with the full server body. Caller
  // semantics:
  //   addServerTag    - merge `tags` into the server's existing tag list
  //                     (idempotent: already-present tags are no-ops).
  //   removeServerTag - drop `tags` from the server's existing tag list
  //                     (idempotent: missing tags are no-ops).
  //
  // Returns { status, tagsBefore, tagsAfter, addedTags, removedTags }
  // so callers can render a coherent prev->next diff in the preview
  // table without re-fetching.
  //
  // FMN-206 caveat: the GET response carries fields the PUT validator
  // rejects when echoed back unchanged. Known cases (collected from a
  // live tenant HAR, 2026-05-13):
  //   - geo_latitude / geo_longitude come back as strings; PUT requires
  //     numeric values ("This field is invalid: Please enter a valid
  //     integer or float").
  //   - snmp_heartbeat_enabled=true paired with snmp_scan_frequency=0
  //     yields "Can't enable SNMP heartbeat on a non-SNMP instance".
  // sanitizeServerBodyForPut() reconciles these before PUT.

  /**
   * FMN-170: move a server to a new parent group. GET-modify-PUT
   * pattern (same as addServerTag) with sanitizeServerBodyForPut to
   * avoid the FMN-206 PUT-stricter-than-GET-serializes gotcha.
   *
   * @param {string|number} serverId
   * @param {string} serverGroupUrl - full v2 URL for an existing server_group
   * @returns {Promise<{status:number, from:string|null, to:string, noop:boolean}>}
   */
  async setServerParentGroup(serverId, serverGroupUrl) {
    if (!serverId) throw new TypeError('setServerParentGroup: serverId is required');
    if (!serverGroupUrl || typeof serverGroupUrl !== 'string') {
      throw new TypeError('setServerParentGroup: serverGroupUrl is required');
    }
    const { body: server } = await this._request('GET', `/server/${encodeURIComponent(serverId)}`);
    const before = server?.server_group ?? null;
    if (before === serverGroupUrl) {
      return { status: 200, from: before, to: serverGroupUrl, noop: true };
    }
    const { res } = await this._request('PUT', `/server/${encodeURIComponent(serverId)}`, {
      body: sanitizeServerBodyForPut({ ...server, server_group: serverGroupUrl })
    });
    return { status: res.status, from: before, to: serverGroupUrl, noop: false };
  }

  async addServerTag(serverId, tags) {
    if (!serverId) throw new TypeError('addServerTag: serverId is required');
    const tagList = Array.isArray(tags)
      ? tags.filter((t) => typeof t === 'string' && t.trim())
      : (typeof tags === 'string' && tags.trim()) ? [tags.trim()] : [];
    if (tagList.length === 0) throw new TypeError('addServerTag: at least one non-empty tag is required');
    const { body: server } = await this._request('GET', `/server/${encodeURIComponent(serverId)}`);
    const before = Array.isArray(server?.tags) ? server.tags.slice() : [];
    const beforeSet = new Set(before);
    const added = tagList.filter((t) => !beforeSet.has(t));
    if (added.length === 0) {
      return { status: 200, tagsBefore: before, tagsAfter: before, addedTags: [], removedTags: [] };
    }
    const after = before.concat(added);
    const { res } = await this._request('PUT', `/server/${encodeURIComponent(serverId)}`, {
      body: sanitizeServerBodyForPut({ ...server, tags: after })
    });
    return { status: res.status, tagsBefore: before, tagsAfter: after, addedTags: added, removedTags: [] };
  }

  async removeServerTag(serverId, tags) {
    if (!serverId) throw new TypeError('removeServerTag: serverId is required');
    const tagList = Array.isArray(tags)
      ? tags.filter((t) => typeof t === 'string' && t.trim())
      : (typeof tags === 'string' && tags.trim()) ? [tags.trim()] : [];
    if (tagList.length === 0) throw new TypeError('removeServerTag: at least one non-empty tag is required');
    const { body: server } = await this._request('GET', `/server/${encodeURIComponent(serverId)}`);
    const before = Array.isArray(server?.tags) ? server.tags.slice() : [];
    const removeSet = new Set(tagList);
    const after = before.filter((t) => !removeSet.has(t));
    const removed = before.filter((t) => removeSet.has(t));
    if (removed.length === 0) {
      return { status: 200, tagsBefore: before, tagsAfter: before, addedTags: [], removedTags: [] };
    }
    const { res } = await this._request('PUT', `/server/${encodeURIComponent(serverId)}`, {
      body: sanitizeServerBodyForPut({ ...server, tags: after })
    });
    return { status: res.status, tagsBefore: before, tagsAfter: after, addedTags: [], removedTags: removed };
  }

  async acknowledgeOutage(outageId, { message = null } = {}) {
    if (!outageId) throw new TypeError('acknowledgeOutage: outageId is required');
    const payload = message ? { message } : {};
    const { res, body } = await this._request(
      'POST',
      `/outage/${encodeURIComponent(outageId)}/acknowledge`,
      { body: payload }
    );
    return { status: res.status, body };
  }

  /**
   * Detach a template from a server.
   *
   * @param {string|number} serverId
   * @param {string|number} templateId  Template id (not the mapping id)
   * @param {object} [opts]
   * @param {'dissociate'|'delete'} [opts.strategy='dissociate']
   *   'dissociate' - remove association only; metrics/attributes the
   *     template seeded stay on the server.
   *   'delete' - remove association AND wipe metrics/attributes the
   *     template added. DESTRUCTIVE, no undo. UI must gate this behind a
   *     typed confirmation (see FMN-49 plan).
   * @returns {Promise<{status:number}>}
   */
  async detachTemplate(serverId, templateId, { strategy = 'dissociate' } = {}) {
    if (!serverId) throw new TypeError('detachTemplate: serverId is required');
    if (!templateId) throw new TypeError('detachTemplate: templateId is required');
    if (strategy !== 'dissociate' && strategy !== 'delete') {
      throw new TypeError(`detachTemplate: strategy must be 'dissociate' or 'delete', got '${strategy}'`);
    }
    const path = `/server/${encodeURIComponent(serverId)}/template/${encodeURIComponent(templateId)}`;
    // Always send the body - even though dissociate is the server-side
    // default, we want the wire behavior to be deterministic and
    // inspectable, not dependent on an implicit default.
    const { res } = await this._request('DELETE', path, { body: { strategy } });
    return { status: res.status };
  }
}

/**
 * Production factory. Reads the API key from chrome.storage.local on
 * each call rather than caching, so storage updates take effect
 * immediately without a service-worker reload.
 *
 * @param {object} [overrides] - for tests; injects a different storage / fetch
 * @returns {Promise<PanoptaClient>}
 */
export async function createProductionPanoptaClient(overrides = {}) {
  const fetchFn = overrides.fetch ?? globalThis.fetch.bind(globalThis);
  const storage = overrides.storage ?? chrome.storage.local;
  const data = await storage.get('panopta.apiKey');
  const apiKey = data?.['panopta.apiKey'];
  if (!apiKey) {
    throw new PanoptaError(
      'No API key configured. Open the extension settings and paste a FortiMonitor RW API key.',
      { phase: 'auth' }
    );
  }
  return new PanoptaClient({ apiKey, fetch: fetchFn });
}
