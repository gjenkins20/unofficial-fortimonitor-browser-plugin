// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Live-tenant E2E helper: seed the FortiMonitor v2 API key into the
// launched extension's chrome.storage.local. Reusable across per-tool
// live suites (FMN-117, FMN-119).
//
// Strategy: the extension's service worker has chrome.* APIs available
// in its evaluation context. Playwright exposes the worker via
// context.serviceWorkers() and lets us run JS inside it via
// worker.evaluate(). One call, no UI interaction needed.
//
// Storage key is 'panopta.apiKey' (see extension/src/popup/popup.js
// API_KEY_STORAGE_KEY and lib/panopta-client.js's createProductionPanoptaClient).

/**
 * Seed the API key into chrome.storage.local for the launched extension.
 * Idempotent: writing the same key twice is fine.
 *
 * @param {import('@playwright/test').BrowserContext} extensionContext
 * @param {string} apiKey
 */
export async function seedApiKey(extensionContext, apiKey) {
  if (!apiKey) throw new Error('seedApiKey: apiKey is required');
  let sw = extensionContext.serviceWorkers()[0];
  if (!sw) {
    sw = await extensionContext.waitForEvent('serviceworker', { timeout: 10_000 });
  }
  await sw.evaluate(async (key) => {
    await chrome.storage.local.set({ 'panopta.apiKey': key });
  }, apiKey);
}

/**
 * Verify the seeded key is present (defensive check; the seed itself is
 * usually enough but flake tolerance is cheap).
 *
 * @param {import('@playwright/test').BrowserContext} extensionContext
 * @returns {Promise<string|null>} the stored key, or null if not set
 */
export async function readSeededApiKey(extensionContext) {
  let sw = extensionContext.serviceWorkers()[0];
  if (!sw) {
    sw = await extensionContext.waitForEvent('serviceworker', { timeout: 10_000 });
  }
  return await sw.evaluate(async () => {
    const data = await chrome.storage.local.get('panopta.apiKey');
    return data?.['panopta.apiKey'] ?? null;
  });
}
