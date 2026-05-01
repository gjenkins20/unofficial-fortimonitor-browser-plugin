// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Shared helpers for the BPA analyzer modules. Pure functions; no IO.

/**
 * JS counterpart to Python's collections.Counter. Returns a Map<key, count>
 * with stable insertion order. Increment via map.set(k, (map.get(k) ?? 0) + 1).
 */
export function counter(items = [], keyOf = (x) => x) {
  const m = new Map();
  for (const item of items) {
    const k = keyOf(item);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/**
 * Top-N by count, descending. Ties broken by insertion order (which is
 * Map's natural iteration order). Returns array of {key, count}.
 */
export function mostCommon(map, n) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

/**
 * Resolve a server's display name from the various shapes the v2 API uses
 * across endpoints. Mirrors the Python source's
 *   o.get("server_name") or o.get("server", {}).get("name", "Unknown")
 */
export function serverDisplayName(record) {
  if (!record) return 'Unknown';
  if (typeof record.server_name === 'string' && record.server_name) return record.server_name;
  if (record.server && typeof record.server === 'object' && typeof record.server.name === 'string' && record.server.name) {
    return record.server.name;
  }
  return 'Unknown';
}

/**
 * Pull the trailing numeric id from a v2 resource_url / url. Same logic
 * the fetcher uses; duplicated here to keep analyzers free of fetcher
 * imports (analyzers are pure functions over the inventory).
 */
export function extractTrailingId(url) {
  if (!url || typeof url !== 'string') return null;
  const parts = url.replace(/\/+$/, '').split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    if (/^\d+$/.test(seg)) return seg;
  }
  return null;
}

/**
 * Best-effort parse of the timestamp formats FortiMonitor returns. Returns
 * a Date or null. Mirrors the Python source's _parse_dt fallbacks.
 */
export function parseTimestamp(s) {
  if (typeof s !== 'string' || !s) return null;
  // Native parser handles ISO-8601 with or without Z, and RFC-2822.
  const t = Date.parse(s);
  if (Number.isFinite(t)) return new Date(t);
  // "YYYY-MM-DD HH:MM:SS" without a T separator. Replace the space with T
  // and retry.
  const isoish = s.replace(' ', 'T');
  const t2 = Date.parse(isoish);
  if (Number.isFinite(t2)) return new Date(t2);
  return null;
}

/**
 * Get a server's name regardless of which inventory key it came from.
 * Servers can have name or fqdn populated (both, either, or neither).
 */
export function rowName(s, fallback = '') {
  if (!s) return fallback;
  if (typeof s.name === 'string' && s.name) return s.name;
  if (typeof s.fqdn === 'string' && s.fqdn) return s.fqdn;
  return fallback;
}

/**
 * Group an array by a key function, returning a Map<key, T[]>. Matches
 * Python's defaultdict(list) idiom.
 */
export function groupBy(items, keyOf) {
  const out = new Map();
  for (const item of items) {
    const k = keyOf(item);
    if (k == null) continue;
    let bucket = out.get(k);
    if (!bucket) { bucket = []; out.set(k, bucket); }
    bucket.push(item);
  }
  return out;
}
