// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
//
// FMN-157: lightweight in-extension update check against the GitHub repo.
//
// The toolkit ships via `git clone + Load unpacked` (no Chrome Web Store,
// no .crx) so operators have no native notification surface for new
// versions. This module fetches the raw manifest from `main`, semver-
// compares to the installed version, and persists the result. A popup
// banner reads the persisted result on next open.
//
// Design choices:
//   - Source of truth: raw.githubusercontent.com/.../main/extension/manifest.json
//     (GitHub Releases API is out of scope for v1).
//   - Rate-limited to one fetch per hour regardless of triggers. The
//     service worker can wake repeatedly; a 12h alarm + popup-open also
//     trigger this, and we never want to hammer GitHub.
//   - Silent failures: network errors, malformed JSON, HTTP 5xx all
//     leave the prior result untouched. The banner is best-effort.
//   - No telemetry: we don't ping back anywhere, we don't log identifying
//     info. The fetch URL is static.

import { UPDATE_CHECK_ENABLED_KEY } from '../lib/settings.js';

// Public storage key: the popup reads this to decide whether to render
// the banner. Schema:
//   { checkedAt: number(ms-epoch),
//     localVersion: string,
//     remoteVersion: string,
//     isNewer: boolean }
// All fields present and well-formed when the check succeeded at least
// once; absent / partial when the check has never succeeded.
export const UPDATE_CHECK_RESULT_KEY = 'fm:updateCheck';

// Snooze key: when set to a future ms-epoch timestamp, the popup
// suppresses the banner. "Snooze 7 days" and "Dismiss (24h)" buttons
// write this.
export const UPDATE_CHECK_SNOOZE_KEY = 'fm:updateSnoozeUntil';

// Raw manifest on main. This is the only network endpoint this module
// touches. Verified against the repo path documented in FMN-157.
export const REMOTE_MANIFEST_URL =
  'https://raw.githubusercontent.com/gjenkins20/unofficial-fortimonitor-browser-plugin/main/extension/manifest.json';

// Rate-limit window: at most one successful fetch per hour.
export const MIN_INTERVAL_MS = 60 * 60 * 1000;

// Network timeout for the manifest fetch. Short so a hanging GitHub
// connection doesn't keep the service worker alive forever.
const FETCH_TIMEOUT_MS = 8_000;

// Strict semver regex (major.minor.patch, digits only). This is what
// our manifests use; we don't try to be more permissive than that.
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Compare two strict semver strings. Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 * Both arguments must match SEMVER_RE; callers validate upstream.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareSemver(a, b) {
  const aa = a.split('.').map((n) => Number(n));
  const bb = b.split('.').map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    if (aa[i] > bb[i]) return 1;
    if (aa[i] < bb[i]) return -1;
  }
  return 0;
}

/**
 * Test whether a remote-version string represents a newer release than
 * the local-version string. Both must be strict semver; anything else
 * returns false (we err toward not surfacing the banner on parse
 * weirdness).
 *
 * @param {string} localVersion
 * @param {string} remoteVersion
 * @returns {boolean}
 */
export function isRemoteNewer(localVersion, remoteVersion) {
  if (!SEMVER_RE.test(localVersion) || !SEMVER_RE.test(remoteVersion)) return false;
  return compareSemver(remoteVersion, localVersion) > 0;
}

/**
 * Read whether the update-check flag is enabled. Defaults to true.
 * Mirrors isUpdateCheckEnabled from settings.js, but inlined here so
 * this module can be unit-tested without dragging in the settings
 * surface (which imports from chrome.* at module-load time).
 *
 * @param {{ get: (k: string) => Promise<Record<string, any>> }} storage
 * @returns {Promise<boolean>}
 */
async function readEnabledFlag(storage) {
  try {
    const data = await storage.get(UPDATE_CHECK_ENABLED_KEY);
    const v = data?.[UPDATE_CHECK_ENABLED_KEY];
    return v === undefined ? true : Boolean(v);
  } catch {
    return true;
  }
}

/**
 * Read the prior check result from storage. Returns the raw stored
 * object (possibly partial), or null if nothing is stored yet.
 *
 * @param {{ get: (k: string) => Promise<Record<string, any>> }} storage
 * @returns {Promise<null | { checkedAt?: number, localVersion?: string, remoteVersion?: string, isNewer?: boolean }>}
 */
export async function getLastResult(storage) {
  try {
    const data = await storage.get(UPDATE_CHECK_RESULT_KEY);
    const v = data?.[UPDATE_CHECK_RESULT_KEY];
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Run the update check. Designed to be called from service-worker
 * startup, a chrome.alarms handler, and (rate-limited) on popup open.
 *
 * Behavior:
 *   - If the flag is disabled, the check is skipped (no fetch, no
 *     write). The prior stored result is preserved.
 *   - If a successful check happened less than MIN_INTERVAL_MS ago,
 *     the fetch is skipped (unless force=true). The prior stored
 *     result is preserved.
 *   - When force=true (FMN-165: operator-initiated "Check for updates
 *     now" button), the hour rate-limit is bypassed. The flag gate is
 *     still honored - manual triggers do not override an operator-set
 *     "don't check" preference.
 *   - On fetch success + valid JSON + valid semver, the result is
 *     written.
 *   - On any failure (network, HTTP non-2xx, JSON parse, bad semver)
 *     no state change. Errors are swallowed; never thrown to the caller.
 *
 * Returns the outcome so the service worker can log it during dev. The
 * popup doesn't call this directly; it reads getLastResult.
 *
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {{ get, set }} [deps.storage]
 * @param {string} [deps.localVersion] - typically chrome.runtime.getManifest().version
 * @param {() => number} [deps.now] - injection for time-travel tests
 * @param {boolean} [deps.force] - FMN-165: bypass the hour rate-limit; flag gate still applies
 * @returns {Promise<{ ran: boolean, reason?: string, result?: { checkedAt: number, localVersion: string, remoteVersion: string, isNewer: boolean } }>}
 */
export async function checkForUpdate(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const storage = deps.storage ?? (typeof chrome !== 'undefined' && chrome?.storage?.local);
  if (!storage) {
    return { ran: false, reason: 'no-storage' };
  }
  const localVersion = deps.localVersion ?? safeManifestVersion();
  const now = deps.now ?? Date.now;
  const force = deps.force === true;

  // 1. Flag gate: off = no fetch, no write. Applies even to forced
  //    manual triggers - the flag is an explicit opt-out.
  const enabled = await readEnabledFlag(storage);
  if (!enabled) return { ran: false, reason: 'disabled' };

  // 2. Rate limit: bail if a successful check ran within MIN_INTERVAL_MS.
  //    force=true skips this gate (operator-initiated by definition).
  const prior = await getLastResult(storage);
  const nowMs = now();
  if (!force && prior && typeof prior.checkedAt === 'number' && (nowMs - prior.checkedAt) < MIN_INTERVAL_MS) {
    return { ran: false, reason: 'rate-limited' };
  }

  // 3. Validate the local version. If it's bad we still fetch (gives
  //    the operator something to see in storage), but skip the
  //    isNewer comparison.
  if (!SEMVER_RE.test(localVersion)) {
    return { ran: false, reason: 'bad-local-version' };
  }

  // 4. Fetch the remote manifest. Short timeout via AbortController so
  //    a hanging connection doesn't keep the SW alive forever.
  let remoteText;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(REMOTE_MANIFEST_URL, {
        method: 'GET',
        cache: 'no-store',
        signal: ctrl.signal
      });
      if (!res || !res.ok) {
        return { ran: false, reason: `http-${res?.status ?? 'no-response'}` };
      }
      remoteText = await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ran: false, reason: `fetch-error: ${err?.message ?? err}` };
  }

  // 5. Parse + validate.
  let remoteVersion;
  try {
    const parsed = JSON.parse(remoteText);
    if (!parsed || typeof parsed !== 'object') {
      return { ran: false, reason: 'malformed-json' };
    }
    if (typeof parsed.version !== 'string' || !SEMVER_RE.test(parsed.version)) {
      return { ran: false, reason: 'bad-remote-version' };
    }
    remoteVersion = parsed.version;
  } catch (err) {
    return { ran: false, reason: `parse-error: ${err?.message ?? err}` };
  }

  // 6. Compute + persist.
  const result = {
    checkedAt: nowMs,
    localVersion,
    remoteVersion,
    isNewer: isRemoteNewer(localVersion, remoteVersion)
  };
  try {
    await storage.set({ [UPDATE_CHECK_RESULT_KEY]: result });
  } catch {
    // Storage write failed; not much we can do. Don't report success.
    return { ran: false, reason: 'storage-write-failed' };
  }
  return { ran: true, result };
}

/**
 * Read chrome.runtime.getManifest().version without throwing if the
 * runtime API isn't available (e.g. during unit tests).
 *
 * @returns {string}
 */
function safeManifestVersion() {
  try {
    // eslint-disable-next-line no-undef
    if (typeof chrome !== 'undefined' && chrome?.runtime?.getManifest) {
      return chrome.runtime.getManifest().version || '';
    }
  } catch { /* fall through */ }
  return '';
}
