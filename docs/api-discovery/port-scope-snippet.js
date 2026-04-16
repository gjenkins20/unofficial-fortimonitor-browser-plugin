// Port Scope API — minimal Manifest V3 service-worker-compatible snippet.
// Captured from live UI on 2026-04-16. See ./port-scope.md for full contract.
//
// Manifest requirements:
//   "permissions": ["cookies"]
//   "host_permissions": ["https://fortimonitor.forticloud.com/*"]

const FM_ORIGIN = 'https://fortimonitor.forticloud.com';

async function getXsrfToken() {
  const cookie = await chrome.cookies.get({ url: FM_ORIGIN, name: 'XSRF-TOKEN' });
  if (!cookie) throw new Error('No XSRF-TOKEN cookie — user not logged in to FortiCloud?');
  return cookie.value;
}

async function getDevicePorts(serverId) {
  const url = `${FM_ORIGIN}/onboarding/getDevicePorts?server_id=${encodeURIComponent(serverId)}`;
  const r = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`getDevicePorts failed: HTTP ${r.status}`);
  return (await r.json()).data;
}

// portSelectionType: "all" | "none" | "manual" | "name"
// selectedIndices: array of port `index` strings/numbers from getDevicePorts (e.g., ["0", "2"])
// totalPortCount: ports.length from getDevicePorts
// searchTerm, filters: only used when portSelectionType === "name"
async function savePortSelection({
  serverId,
  portSelectionType,
  selectedIndices,
  totalPortCount,
  searchTerm = '',
  filters = []
}) {
  const params = new URLSearchParams();
  params.set('serverId', String(serverId));
  params.set('filters', JSON.stringify(filters));
  params.set('portSelectionType', portSelectionType);
  params.set('searchTerm', searchTerm);
  params.set('totalPortCount', String(totalPortCount));
  for (const idx of selectedIndices) params.append('selectedPorts[]', String(idx));

  const xsrf = await getXsrfToken();
  const url = `${FM_ORIGIN}/config/save_port_selection?${params.toString()}`;
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-XSRF-TOKEN': xsrf
    }
    // Body intentionally omitted — FortiCloud puts the form data in the query string.
  });
  if (!r.ok) throw new Error(`save_port_selection failed: HTTP ${r.status}`);
  const body = await r.json();
  if (!body.success) throw new Error(`save_port_selection rejected: ${JSON.stringify(body)}`);
  return body;
}

// Example: deselect a port by name.
// CAUTION: UI port deselection deletes the port's agent_resources and metric history.
// Always confirm with the user before calling this.
async function deselectPortByName(serverId, portName) {
  const data = await getDevicePorts(serverId);
  const keep = data.ports.filter(p => p.name !== portName).map(p => p.index);
  if (keep.length === data.ports.length) {
    throw new Error(`Port ${portName} not found on server ${serverId}`);
  }
  return savePortSelection({
    serverId,
    portSelectionType: 'manual',
    selectedIndices: keep,
    totalPortCount: data.ports.length
  });
}

export { getDevicePorts, savePortSelection, deselectPortByName, getXsrfToken };
