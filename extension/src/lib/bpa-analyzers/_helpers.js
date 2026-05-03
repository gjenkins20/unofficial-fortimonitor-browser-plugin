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
 * Derive a stable, string-typed key for a v2 user record. The v2 API
 * returns users with `url` (e.g. /v2/user/308609) but no `id` field;
 * tests and some legacy callers attach `id` directly. Accept either.
 * Returns null if nothing usable is present. Used as the join key
 * between the v2 user list and the frontend fetcher's per-user data.
 */
export function userKeyOf(user) {
  if (!user) return null;
  if (user.id != null && user.id !== '') return String(user.id);
  return extractTrailingId(user.url ?? user.resource_url);
}

/**
 * Derive the FortiMonitor `contact_id` URL parameter that
 * /users/users/EditUser expects. v2 users carry their contact id only
 * inside contact_info[].url (the path segment after /v2/contact/). The
 * contact_id namespace is distinct from the user id namespace; EditUser
 * will not return useful data for a user id (FMN-135 QA, 2026-05-01).
 *
 * Returns the contact id as a string, or null if no contact_info entry
 * yields one (the caller should record a per-user error and skip).
 */
export function contactIdOf(user) {
  if (!user || !Array.isArray(user.contact_info)) return null;
  for (const ci of user.contact_info) {
    if (!ci || typeof ci.url !== 'string') continue;
    const m = /\/contact\/(\d+)(?:\/|$)/.exec(ci.url);
    if (m) return m[1];
  }
  return null;
}

/**
 * Bucket a user's `last_login` text into an activity classification.
 * Day-precision parsing: we accept the leading YYYY-MM-DD and ignore
 * timezone abbreviations (JS Date does not reliably handle named TZs
 * like PDT across engines).
 *
 * Buckets:
 *   'Active'   - logged in within last 90 days
 *   'Stale'    - last login 91..365 days ago
 *   'Inactive' - last login > 365 days ago
 *   'Never'    - null/empty value (no login on record, or no frontend data)
 *   'Unknown'  - non-empty value that does not contain a parseable date
 */
export function deriveActiveAssessment(lastLogin, now = Date.now()) {
  if (lastLogin == null || lastLogin === '') return 'Never';
  if (typeof lastLogin !== 'string') return 'Unknown';
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(lastLogin);
  if (!m) return 'Unknown';
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(t)) return 'Unknown';
  const ageDays = Math.floor((now - t) / 86400000);
  if (ageDays < 0) return 'Active';            // future / clock skew
  if (ageDays <= 90) return 'Active';
  if (ageDays <= 365) return 'Stale';
  return 'Inactive';
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
