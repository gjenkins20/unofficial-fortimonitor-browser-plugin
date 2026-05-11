// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-119 Phase 2 - shared tenant-discovery helper for live E2E specs.
//
// Operator guardrail: every live spec that exercises a write or read
// against the tenant uses three distinctly-different instances. The
// "distinct" classification is best-effort, ordered as:
//
//   1. By operating system attribute (server.os textkey or "Operating System"
//      attribute name). Three different OS buckets when available.
//   2. By device_type (fortigate, linux, windows, etc.) for servers
//      without an OS attribute.
//   3. By attribute count (high / mid / low) as fallback when neither
//      OS nor device_type are populated.
//
// All callers pass FORTIMONITOR_API_KEY; helper does not read env itself.
// All returns are arrays of length up to `count`, never fewer than 1.
// Throws if the tenant has zero servers at all.

const PANOPTA_BASE = 'https://api2.panopta.com/v2';

/**
 * Extract numeric server id from either {id} or {url: '/server/123'}.
 */
export function extractServerId(server) {
  if (server == null) return null;
  if (server.id != null) return Number(server.id);
  if (typeof server.url === 'string') {
    const m = server.url.match(/\/server\/(\d+)\/?$/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Pull the operating-system value from a server's attributes array, if any.
 * FortiMonitor stores the OS as a built-in attribute (textkey: server.os,
 * sometimes name: "Operating System"). Returns lower-case bucket or null.
 */
function osBucket(server) {
  const attrs = Array.isArray(server?.attributes) ? server.attributes : [];
  const osAttr = attrs.find(
    (a) =>
      /server\.os/i.test(a?.textkey ?? '') ||
      /operating system/i.test(a?.name ?? '')
  );
  const v = typeof osAttr?.value === 'string' ? osAttr.value : '';
  if (!v) return null;
  // Bucket by the first whitespace/slash/dash-separated token, lower-cased.
  // "Ubuntu 22.04" -> "ubuntu", "Windows Server 2019" -> "windows".
  const token = v.toLowerCase().split(/[\s/\-]/)[0];
  return token || null;
}

/**
 * Pick `count` servers from the tenant that are distinct along the
 * strongest available axis. Always returns at least 1 if the tenant has
 * any servers; may return fewer than `count` if the tenant lacks diversity.
 *
 * @param {string} apiKey  FortiMonitor v2 API key
 * @param {object} [opts]
 * @param {number} [opts.count=3]      target number of picks
 * @param {number} [opts.poolSize=200] /server limit to sample from
 * @returns {Promise<Array<object>>} server objects from /v2/server, in pick order
 */
export async function discoverDiverseServers(apiKey, opts = {}) {
  const count = opts.count ?? 3;
  const poolSize = opts.poolSize ?? 200;
  if (!apiKey) throw new Error('discoverDiverseServers: apiKey required');

  const r = await fetch(`${PANOPTA_BASE}/server?limit=${poolSize}`, {
    headers: { Authorization: `ApiKey ${apiKey}` }
  });
  if (!r.ok) throw new Error(`/v2/server probe failed: ${r.status}`);
  const body = await r.json();
  const servers = Array.isArray(body?.server_list) ? body.server_list : [];
  if (servers.length === 0) {
    throw new Error('discoverDiverseServers: tenant has zero servers');
  }

  // Only consider servers with a usable name (needed by tools that look
  // up by name). Drop unnamed servers up front.
  const named = servers.filter(
    (s) => typeof s?.name === 'string' && s.name.length > 0
  );
  if (named.length === 0) {
    throw new Error('discoverDiverseServers: tenant has no named servers');
  }

  // Axis 1: OS bucket.
  const byOs = new Map();
  for (const s of named) {
    const b = osBucket(s);
    if (!b) continue;
    if (!byOs.has(b)) byOs.set(b, []);
    byOs.get(b).push(s);
  }
  const picks = [];
  for (const [, group] of byOs) {
    if (picks.length >= count) break;
    picks.push(group[0]);
  }
  if (picks.length >= count) return picks.slice(0, count);

  // Axis 2: device_type for servers we haven't covered yet.
  const pickedIds = new Set(picks.map((s) => extractServerId(s)));
  const byDeviceType = new Map();
  for (const s of named) {
    const id = extractServerId(s);
    if (pickedIds.has(id)) continue;
    const dt = typeof s?.device_type === 'string' ? s.device_type.toLowerCase() : null;
    if (!dt) continue;
    if (!byDeviceType.has(dt)) byDeviceType.set(dt, []);
    byDeviceType.get(dt).push(s);
  }
  for (const [, group] of byDeviceType) {
    if (picks.length >= count) break;
    picks.push(group[0]);
    pickedIds.add(extractServerId(group[0]));
  }
  if (picks.length >= count) return picks.slice(0, count);

  // Axis 3: attribute-count diversity (high / mid / low among remaining).
  const remaining = named
    .filter((s) => !pickedIds.has(extractServerId(s)))
    .sort(
      (a, b) =>
        ((Array.isArray(b.attributes) ? b.attributes.length : 0)) -
        ((Array.isArray(a.attributes) ? a.attributes.length : 0))
    );
  if (remaining.length === 0) return picks.slice(0, count);

  // Take from high / mid / low ends of the sorted list.
  const slots = count - picks.length;
  const indices = pickEvenly(remaining.length, slots);
  for (const idx of indices) {
    picks.push(remaining[idx]);
  }
  return picks.slice(0, count);
}

/**
 * Evenly-spaced indices from 0..n-1 for `k` picks. n=10, k=3 -> [0, 5, 9].
 * Guarantees uniqueness and order. If k >= n returns 0..n-1.
 */
function pickEvenly(n, k) {
  if (k <= 0 || n <= 0) return [];
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  const out = [];
  for (let i = 0; i < k; i++) {
    out.push(Math.round((i * (n - 1)) / (k - 1)));
  }
  // Dedup in case rounding collides (e.g. n=2, k=3).
  return Array.from(new Set(out));
}

/**
 * Summarize a pick for [live discovery] log output. Tools log this so the
 * operator can see exactly which tenant servers exercised each scenario.
 */
export function summarizePick(server) {
  return {
    id: extractServerId(server),
    name: server?.name ?? null,
    os: osBucket(server),
    deviceType: server?.device_type ?? null,
    attrCount: Array.isArray(server?.attributes) ? server.attributes.length : 0
  };
}
