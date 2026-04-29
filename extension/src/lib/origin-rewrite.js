// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-120: rewrite the Origin header on outbound fetches to local AI
// providers (Ollama, LM Studio) so they don't trip on browser-extension
// origins.
//
// The problem: Chrome attaches `Origin: chrome-extension://<extid>` to
// every fetch from a service worker / extension page. Ollama's default
// OLLAMA_ORIGINS allowlist covers localhost, 127.x.x.x, 0.0.0.0,
// app://, file://, tauri:// etc. but does NOT cover chrome-extension://.
// The result is a 403 on every chat turn until the operator reconfigures
// Ollama with OLLAMA_ORIGINS=chrome-extension://*. That's friction for
// the operator (especially on Windows-hosted Ollama-as-a-service installs)
// and provides no real security benefit - the operator already chose to
// expose Ollama to this network and explicitly granted host permission
// to this extension.
//
// The fix: register a declarativeNetRequest dynamic rule that sets
// Origin: http://localhost on requests to the configured local-provider
// URL. Localhost is in Ollama's default allowlist; the request is
// allowed; the response comes back. The extension already has
// host_permissions for the URL (granted during Save), so Chrome's CORS
// validation is bypassed regardless of the spoofed origin.
//
// Scope: only the active local-provider URL. Anthropic
// (api.anthropic.com) is never touched - Anthropic explicitly requires
// the chrome-extension origin via the
// anthropic-dangerous-direct-browser-access header and modifying its
// Origin would break direct-from-browser access.

const RULE_ID_OLLAMA = 1001;
const RULE_ID_LMSTUDIO = 1002;

const STORAGE_KEYS = {
  provider: 'fm:askClaudeProvider',
  ollamaUrl: 'fm:askClaudeOllamaUrl',
  lmstudioUrl: 'fm:askClaudeLmStudioUrl'
};

// The Origin we present to local Ollama / LM Studio. Both servers
// accept `http://localhost` by default. Using http://localhost (no port)
// is the broadest match against Ollama's default allowlist patterns
// (`http://localhost`, `http://localhost:*`, etc.).
export const SPOOFED_ORIGIN = 'http://localhost';

function ruleIdFor(provider) {
  if (provider === 'ollama') return RULE_ID_OLLAMA;
  if (provider === 'lmstudio') return RULE_ID_LMSTUDIO;
  return null;
}

function getDefaultDnr() {
  // eslint-disable-next-line no-undef
  if (typeof chrome === 'undefined') return undefined;
  // eslint-disable-next-line no-undef
  return chrome?.declarativeNetRequest;
}

function getDefaultStorage() {
  // eslint-disable-next-line no-undef
  if (typeof chrome === 'undefined') return undefined;
  // eslint-disable-next-line no-undef
  return chrome?.storage?.local;
}

/**
 * Convert a base URL (e.g. http://192.168.1.125:11434/v1) to a DNR
 * urlFilter string that matches all paths under the URL's host:port.
 * Returns null for invalid input. Exported for tests.
 */
export function urlFilterForBase(urlStr) {
  if (!urlStr) return null;
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  if (!u.protocol || !u.host) return null;
  // The pipe prefix anchors the match to the start of the URL. The
  // trailing slash means we match everything under host:port/, which
  // is what we want (path is /v1/chat/completions, /v1/models, etc.).
  return `|${u.protocol}//${u.host}/`;
}

/**
 * Register or update the dynamic rule that rewrites Origin for the
 * given provider's URL. If `url` is empty/invalid, removes the rule.
 *
 * Failure logs a warning but does not throw - the chat still works
 * if the operator manually configured OLLAMA_ORIGINS, and falling
 * back to that path is acceptable.
 */
export async function setProviderOriginRule({ provider, url, dnr = getDefaultDnr() } = {}) {
  const ruleId = ruleIdFor(provider);
  if (!ruleId) {
    throw new Error(`origin-rewrite: unsupported provider "${provider}"`);
  }
  if (!dnr || typeof dnr.updateDynamicRules !== 'function') {
    // Browser doesn't support DNR (or we're in a test without a stub).
    // Caller can detect this by checking the return value if needed.
    return { ok: false, reason: 'declarativeNetRequest not available' };
  }
  const urlFilter = urlFilterForBase(url);
  if (!urlFilter) {
    // Invalid / empty URL → just clear any existing rule.
    try {
      await dnr.updateDynamicRules({ removeRuleIds: [ruleId] });
      return { ok: true, cleared: true };
    } catch (err) {
      console.warn('[fm-toolkit] origin-rewrite: failed to clear rule:', err?.message ?? err);
      return { ok: false, reason: err?.message ?? String(err) };
    }
  }
  try {
    await dnr.updateDynamicRules({
      removeRuleIds: [ruleId],
      addRules: [{
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'origin', operation: 'set', value: SPOOFED_ORIGIN }]
        },
        condition: {
          urlFilter,
          resourceTypes: ['xmlhttprequest']
        }
      }]
    });
    return { ok: true, urlFilter };
  } catch (err) {
    console.warn('[fm-toolkit] origin-rewrite: failed to register rule for', provider, err?.message ?? err);
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

/**
 * Remove the dynamic rule for a provider. Used when the operator
 * clears the URL or switches away from local providers entirely.
 */
export async function clearProviderOriginRule(provider, dnr = getDefaultDnr()) {
  const ruleId = ruleIdFor(provider);
  if (!ruleId) return;
  if (!dnr || typeof dnr.updateDynamicRules !== 'function') return;
  try {
    await dnr.updateDynamicRules({ removeRuleIds: [ruleId] });
  } catch (err) {
    console.warn('[fm-toolkit] origin-rewrite: failed to clear rule for', provider, err?.message ?? err);
  }
}

/**
 * Re-apply Origin-rewrite rules from saved settings. Called on
 * service worker startup and whenever a provider URL changes in
 * chrome.storage.local. Both Ollama and LM Studio rules are kept in
 * sync independently - their urlFilters never overlap, so leaving an
 * inactive provider's rule in place is harmless.
 */
export async function applyAllProviderRules({ storage = getDefaultStorage(), dnr = getDefaultDnr() } = {}) {
  if (!storage || typeof storage.get !== 'function') return;
  const data = await storage.get([
    STORAGE_KEYS.ollamaUrl,
    STORAGE_KEYS.lmstudioUrl
  ]);
  await setProviderOriginRule({ provider: 'ollama', url: data[STORAGE_KEYS.ollamaUrl], dnr });
  await setProviderOriginRule({ provider: 'lmstudio', url: data[STORAGE_KEYS.lmstudioUrl], dnr });
}

/**
 * Storage keys that should trigger a re-application of Origin-rewrite
 * rules when they change. Exposed so service-worker.js can wire a
 * single onChanged listener.
 */
export const WATCHED_STORAGE_KEYS = [
  STORAGE_KEYS.ollamaUrl,
  STORAGE_KEYS.lmstudioUrl
];
