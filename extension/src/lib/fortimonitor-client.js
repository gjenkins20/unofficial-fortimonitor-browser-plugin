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

export const FM_ORIGIN = 'https://fortimonitor.forticloud.com';
const XSRF_COOKIE_NAME = 'XSRF-TOKEN';

export class FortimonitorError extends Error {
  constructor(message, { status = null, phase = null, responseBody = null } = {}) {
    super(message);
    this.name = 'FortimonitorError';
    this.status = status;
    this.phase = phase;
    this.responseBody = responseBody;
  }
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
  filters = []
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
  return `${FM_ORIGIN}/config/save_port_selection?${params.toString()}`;
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
   */
  constructor({ fetch, getCookie } = {}) {
    if (typeof fetch !== 'function') {
      throw new TypeError('FortimonitorClient requires a fetch function');
    }
    if (typeof getCookie !== 'function') {
      throw new TypeError('FortimonitorClient requires a getCookie function');
    }
    this.fetch = fetch;
    this.getCookie = getCookie;
  }

  async getDevicePorts(serverId) {
    if (serverId === undefined || serverId === null) {
      throw new TypeError('getDevicePorts: serverId is required');
    }
    const url = `${FM_ORIGIN}/onboarding/getDevicePorts?server_id=${encodeURIComponent(serverId)}`;
    const res = await this.fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) {
      throw new FortimonitorError(`getDevicePorts failed: HTTP ${res.status}`, {
        status: res.status,
        phase: 'read'
      });
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
    const xsrf = await this.getCookie(XSRF_COOKIE_NAME);
    if (!xsrf) {
      throw new FortimonitorError(
        `No ${XSRF_COOKIE_NAME} cookie — user is not logged in to FortiCloud.`,
        { phase: 'auth' }
      );
    }
    const url = buildSavePortSelectionUrl({
      serverId, portSelectionType, selectedIndices, totalPortCount, searchTerm, filters
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
        phase: 'write'
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
}

/**
 * Production factory. Wires chrome.cookies and global fetch.
 * Must only be called inside the extension runtime.
 */
export function createProductionClient() {
  return new FortimonitorClient({
    fetch: globalThis.fetch.bind(globalThis),
    getCookie: async (name) => {
      // eslint-disable-next-line no-undef
      const c = await chrome.cookies.get({ url: FM_ORIGIN, name });
      return c?.value ?? null;
    }
  });
}
