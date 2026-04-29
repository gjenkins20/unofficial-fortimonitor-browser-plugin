// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Shared projection helpers for the handwritten + hand-port tool
// implementations. Exists so claude-tools.js, bulk_operations.js, and
// composite.js can apply the same null-stripping logic.

/**
 * Drop keys whose value is null, undefined, or empty string.
 * Preserves 0, false, and empty arrays (which carry meaning).
 *
 * Why: open models read `"end": null` in a streamed JSON tool result
 * as "I'm missing data, let me re-fetch" and call get_outage on every
 * item instead of presenting the summary the user asked for. Stripping
 * nulls before the result reaches the model lets the natural-language
 * reply be the natural-language reply, not a fact-finding mission.
 *
 * Recursive: walks plain objects and arrays. Other types pass through.
 *
 * @param {*} obj
 * @returns {*}
 */
export function stripNulls(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripNulls);
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v === '') continue;
    out[k] = stripNulls(v);
  }
  return out;
}
