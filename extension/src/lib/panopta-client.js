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
 * because the server endpoint wraps results in `server_list` rather than
 * `objects`. Confirmed live 2026-04-17.
 */
export function parseServerListResponse(json, baseUrl = PANOPTA_BASE) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.server_list)) {
    throw new PanoptaError('Malformed /server list response: missing server_list array', {
      phase: 'read',
      responseBody: json
    });
  }
  const root = baseUrl.replace(/\/v2$/, '');
  return json.server_list.map((o) => ({
    id: o.id,
    name: o.name ?? `#${o.id}`,
    resourceUrl: o.resource_uri ? `${root}${o.resource_uri}` : null
  }));
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
