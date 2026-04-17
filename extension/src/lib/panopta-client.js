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
  constructor(message, { status = null, phase = null, responseBody = null } = {}) {
    super(message);
    this.name = 'PanoptaError';
    this.status = status;
    this.phase = phase;
    this.responseBody = responseBody;
  }
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
        responseBody: parsed
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
