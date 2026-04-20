// Server Metadata API — minimal Manifest V3 service-worker-compatible snippet.
// Captured from live UI on 2026-04-20. See ./server-metadata.md for full contract.
//
// Manifest requirements (already present for port-scope tools):
//   "host_permissions": ["https://fortimonitor.forticloud.com/*"]

const FM_ORIGIN = 'https://fortimonitor.forticloud.com';

/**
 * Resolve a single server id to its human-readable name.
 *
 * Returns `null` on any failure (invalid id, session expired, HTML
 * shell response, JSON parse error). Callers should treat null as
 * "name not resolvable" and fall back to the id.
 *
 * @param {number|string} serverId
 * @returns {Promise<string | null>}
 */
async function resolveServerName(serverId) {
  const url = `${FM_ORIGIN}/report/get_idp_data?server_id=${encodeURIComponent(String(serverId))}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  // The endpoint returns 200 + HTML shell on any bad input (missing
  // server_id, non-existent id, session expired). Detect via content-type.
  const ct = (res.headers.get('content-type') || '').toLowerCase();
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
 * Resolve many server ids to names in parallel, concurrency-capped.
 *
 * Unresolved ids (failure/invalid/missing) map to the original id as a
 * string so the caller can always look up a value — the display is
 * degraded but never empty.
 *
 * @param {Array<number|string>} serverIds
 * @param {{ concurrency?: number }} [options]
 * @returns {Promise<Record<string,string>>} map: String(serverId) -> name or String(serverId)
 */
async function resolveServerNames(serverIds, { concurrency = 3 } = {}) {
  const ids = [...serverIds];
  const out = {};
  async function worker() {
    while (ids.length) {
      const id = ids.shift();
      if (id == null) return;
      const name = await resolveServerName(id);
      out[String(id)] = name ?? String(id);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, serverIds.length) }, worker);
  await Promise.all(workers);
  return out;
}

export { resolveServerName, resolveServerNames };
