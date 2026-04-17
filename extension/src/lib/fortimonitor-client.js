// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FortiMonitor session-riding client.
//
// Wraps the two internal FortiCloud WebGUI operations the plugin needs:
//   - GET /onboarding/getDevicePorts   (read port scope)
//   - POST /config/save_port_selection (write port scope)
//
// Auth is the user's existing FortiCloud session cookie, plus the
// X-XSRF-TOKEN header derived from the XSRF-TOKEN cookie value.
//
// All IO is injectable (fetch, getCookie) so this module is testable in
// Node without any Chrome APIs. See createProductionClient() at the bottom
// for the production factory that wires chrome.cookies + global fetch.

// Default origin kept for tests and back-compat. In production the
// service worker resolves the tenant origin at runtime and injects it
// into the client — see origin-resolver.js.
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
 * secrets — redacting both keeps diagnostics useful without leaking
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
 * Normalize the device-ports response shape. The FortiCloud WebGUI wraps
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
    // FortiCloud redirects unauthenticated requests to a login HTML page
    // with HTTP 200, so res.ok doesn't catch it. Sniff content-type and
    // surface a clean auth error instead of a JSON parse failure.
    if (contentType && !contentType.toLowerCase().includes('json')) {
      let bodyPreview = null;
      try {
        const text = await res.text();
        bodyPreview = redactSensitive(text.slice(0, 200));
      } catch { /* best effort */ }
      throw new FortimonitorError(
        'FortiCloud returned a non-JSON response (likely a login page). Your browser session is not being recognized by the extension — confirm you are logged into fortimonitor.forticloud.com in this Chrome profile and that the server ID belongs to that tenant.',
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
        `No ${XSRF_COOKIE_NAME} cookie — user is not logged in to FortiCloud.`,
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
      // body intentionally empty: FortiCloud puts the form data in the query string
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
   * Cheap diagnostic probe used by the developer-mode "Check session"
   * button. Does not throw — returns a shape the UI can render directly.
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
