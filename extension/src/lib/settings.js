// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Shared settings read/write. Currently exposes the developer-mode flag
// used to surface diagnostic fields in error UIs. Settings live in
// chrome.storage.local so all extension pages see the same value.

export const DEV_MODE_KEY = 'fm:devMode';
export const ASK_CLAUDE_ENABLED_KEY = 'fm:askClaudeEnabled';
export const SERVER_SEARCH_ENABLED_KEY = 'fm:serverSearchEnabled';

/**
 * Read the developer-mode flag. Returns false on any storage error so
 * diagnostic surfaces stay hidden by default - we never want to leak
 * URLs or body previews to normal operators.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function isDevModeEnabled(storage = defaultStorage()) {
  try {
    const data = await storage.get(DEV_MODE_KEY);
    return Boolean(data?.[DEV_MODE_KEY]);
  } catch {
    return false;
  }
}

/**
 * Persist the developer-mode flag.
 *
 * @param {boolean} enabled
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setDevModeEnabled(enabled, storage = defaultStorage()) {
  await storage.set({ [DEV_MODE_KEY]: Boolean(enabled) });
}

/**
 * Read the Ask-Claude-enabled flag. Shown by default now that the tool
 * has graduated from prototype: returns true when the setting is absent,
 * only false when the operator has explicitly toggled it off. Storage
 * errors fail open (return true) so a transient storage blip never hides
 * a tool the operator expects to see.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function isAskClaudeEnabled(storage = defaultStorage()) {
  try {
    const data = await storage.get(ASK_CLAUDE_ENABLED_KEY);
    const value = data?.[ASK_CLAUDE_ENABLED_KEY];
    return value === undefined ? true : Boolean(value);
  } catch {
    return true;
  }
}

/**
 * Persist the Ask-Claude-enabled flag.
 *
 * @param {boolean} enabled
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setAskClaudeEnabled(enabled, storage = defaultStorage()) {
  await storage.set({ [ASK_CLAUDE_ENABLED_KEY]: Boolean(enabled) });
}

/**
 * Read the Search-Servers-enabled flag. Returns false by default so the
 * tool stays hidden until the operator opts in via Settings.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function isServerSearchEnabled(storage = defaultStorage()) {
  try {
    const data = await storage.get(SERVER_SEARCH_ENABLED_KEY);
    return Boolean(data?.[SERVER_SEARCH_ENABLED_KEY]);
  } catch {
    return false;
  }
}

/**
 * Persist the Search-Servers-enabled flag.
 *
 * @param {boolean} enabled
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setServerSearchEnabled(enabled, storage = defaultStorage()) {
  await storage.set({ [SERVER_SEARCH_ENABLED_KEY]: Boolean(enabled) });
}

function defaultStorage() {
  // eslint-disable-next-line no-undef
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) return chrome.storage.local;
  throw new Error('settings: chrome.storage.local is not available and no storage adapter was provided');
}
