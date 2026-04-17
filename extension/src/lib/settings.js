// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Shared settings read/write. Currently exposes the developer-mode flag
// used to surface diagnostic fields in error UIs. Settings live in
// chrome.storage.local so all extension pages see the same value.

export const DEV_MODE_KEY = 'fm:devMode';

/**
 * Read the developer-mode flag. Returns false on any storage error so
 * diagnostic surfaces stay hidden by default — we never want to leak
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

function defaultStorage() {
  // eslint-disable-next-line no-undef
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) return chrome.storage.local;
  throw new Error('settings: chrome.storage.local is not available and no storage adapter was provided');
}
