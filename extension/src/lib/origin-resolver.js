// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Resolve the FortiMonitor tenant origin the user is actually logged into.
//
// FortiMonitor hosts each tenant on a regional subdomain of
// fortimonitor.com (e.g. my.us01.fortimonitor.com). The forticloud.com
// URL is only a federated entry point — after sign-in the session cookie
// lives on the regional host, not the federation URL. So extension
// fetches MUST target the regional origin, not the federation one, or
// they come back as HTML login-page redirects (see FMN-47).
//
// Resolution strategy (in priority order):
//   1. Explicit override persisted in chrome.storage.local (user set it)
//   2. Any open tab under https://my.*.fortimonitor.com/*
//   3. Any open tab under https://fortimonitor.forticloud.com/* (legacy)
//   4. Fallback to the federation URL (preserves old behavior so
//      existing users don't see a new error on upgrade)
//
// All IO is injected so this module is testable in Node.

export const FEDERATION_ORIGIN = 'https://fortimonitor.forticloud.com';
export const REGIONAL_ORIGIN_RE = /^https:\/\/my\.[a-z0-9-]+\.fortimonitor\.com/i;
export const ORIGIN_OVERRIDE_KEY = 'fm:originOverride';

/**
 * @param {object} deps
 * @param {(query: {url?: string|string[]}) => Promise<Array<{url?: string}>>} deps.queryTabs
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [deps.storage]
 * @returns {Promise<string>} origin (scheme + host), no trailing slash
 */
export async function resolveFortimonitorOrigin({ queryTabs, storage } = {}) {
  if (typeof queryTabs !== 'function') {
    throw new TypeError('resolveFortimonitorOrigin requires queryTabs');
  }

  if (storage) {
    try {
      const data = await storage.get(ORIGIN_OVERRIDE_KEY);
      const override = data?.[ORIGIN_OVERRIDE_KEY];
      if (typeof override === 'string' && override.length) return normalize(override);
    } catch { /* fall through */ }
  }

  // Chrome match patterns can't wildcard mid-host, so we query the
  // broader `*.fortimonitor.com/*` and filter down to the `my.<region>`
  // shape client-side with REGIONAL_ORIGIN_RE.
  const regional = await firstMatchingTab(queryTabs, 'https://*.fortimonitor.com/*', REGIONAL_ORIGIN_RE);
  if (regional) return regional;

  const federation = await firstMatchingTab(queryTabs, `${FEDERATION_ORIGIN}/*`, /^https:\/\/fortimonitor\.forticloud\.com/i);
  if (federation) return federation;

  return FEDERATION_ORIGIN;
}

async function firstMatchingTab(queryTabs, urlPattern, originRe) {
  let tabs;
  try {
    tabs = await queryTabs({ url: urlPattern });
  } catch {
    return null;
  }
  if (!Array.isArray(tabs)) return null;
  for (const t of tabs) {
    if (typeof t?.url !== 'string') continue;
    if (!originRe.test(t.url)) continue;
    try {
      return new URL(t.url).origin;
    } catch { /* skip */ }
  }
  return null;
}

function normalize(origin) {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/$/, '');
  }
}
