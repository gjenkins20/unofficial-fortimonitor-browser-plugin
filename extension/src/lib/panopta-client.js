// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FortiMonitor v2 public API client (Panopta hosted).
//
// Used by the Add Fabric Connection (Bulk) tool. Unlike FortimonitorClient
// (which rides FortiCloud session cookies for internal-UI endpoints), this
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
 * or response echoes — strip them before they reach log surfaces.
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
 * default kicks in — the sibling Python script does the same.
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
 * Normalize a v2 list response (e.g., /v2/onsight, /v2/server_group).
 * Returns an array of { id, name, resourceUrl } for dropdowns.
 */
export function parseListResponse(json, baseUrl = PANOPTA_BASE) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.objects)) {
    throw new PanoptaError('Malformed list response: missing objects array', {
      phase: 'read',
      responseBody: json
    });
  }
  const root = baseUrl.replace(/\/v2$/, '');
  return json.objects.map((o) => ({
    id: o.id,
    name: o.name ?? `#${o.id}`,
    resourceUrl: o.resource_uri ? `${root}${o.resource_uri}` : null
  }));
}

/**
 * Normalize a /v2/server list response. Differs from parseListResponse
 * in two ways:
 *   1. Wrapper is `server_list`, not `objects`.
 *   2. Items do not expose `id` or `resource_uri` directly — the numeric
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
      const message = (parsed && typeof parsed === 'object' && parsed.message)
        || `${method} ${path} failed: HTTP ${res.status}`;
      throw new PanoptaError(message, {
        status: res.status,
        phase: res.status === 401 ? 'auth' : 'write',
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
    return parseListResponse(body, this.baseUrl);
  }

  async listServerGroups({ limit = 100 } = {}) {
    const { body } = await this._request('GET', `/server_group?limit=${limit}`);
    return parseListResponse(body, this.baseUrl);
  }

  async listOnsightGroups({ limit = 100 } = {}) {
    const { body } = await this._request('GET', `/onsight_group?limit=${limit}`);
    return parseListResponse(body, this.baseUrl);
  }

  /**
   * Look up servers whose name exactly matches `name`.
   *
   * The v2 `/server?name=` filter is a substring/contains match (verified
   * live 2026-04-17 — partial prefix returned 3 hits). We pass the term
   * through unchanged for server-side prefiltering, then enforce exact
   * equality client-side. Case-sensitive — callers wanting CI must lower
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
   * This does NOT verify RW vs RO permissions — that surfaces only on
   * the actual POST.
   */
  async testConnection() {
    const { res } = await this._request('GET', '/onsight?limit=1');
    return { ok: true, status: res.status };
  }

  // ---- Server attribute management (FMN-48) -----------------------------
  //
  // Two-resource model (see docs/api-discovery/attributes.md):
  //   * server_attribute_type — the "key" (customer-global, has name/textkey)
  //   * server_attribute      — the "value" attached to one server
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
   * Pages through until total_count is exhausted — the test account has
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
   * (preferred — comes straight from listServerAttributes) or a
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
  // metrics and attributes the template seeded — destructive, no undo.

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
   * List the templates currently attached to a server. Used by the
   * preview step to decide attach-vs-skip / detach-vs-skip per row.
   *
   * Note: the mapping resource shape is NOT the full template — it's
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
   * the FortiCloud UI's default: the template keeps adding new metrics
   * to the server as data collection discovers them.
   *
   * The API does NOT deduplicate — a repeat POST creates a second
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

  async listFabricConnections({ limit = 50, offset = 0 } = {}) {
    const { body } = await this._request(
      'GET',
      `/fabric_connection?limit=${limit}&offset=${offset}`
    );
    return body;
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
   *   'dissociate' — remove association only; metrics/attributes the
   *     template seeded stay on the server.
   *   'delete' — remove association AND wipe metrics/attributes the
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
    // Always send the body — even though dissociate is the server-side
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
 * @param {object} [overrides] — for tests; injects a different storage / fetch
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
