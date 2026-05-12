// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-157: in-extension update check banner.
//
// Uses the offscreen `extensionContext` fixture so we can pre-seed
// chrome.storage.local with stub fm:updateCheck results and observe
// the popup's banner rendering deterministically. The real network
// fetch is exercised in extension/tests/update-check.test.js with
// mocked fetch; this spec covers the popup-side state plumbing.
//
// Run: npx playwright test tests/e2e/fmn-157-update-check-live.spec.js

import { test, expect } from './fixtures.js';

// Storage keys mirrored from extension/src/background/update-check.js
// and extension/src/lib/settings.js. Keep in sync if those change.
const RESULT_KEY = 'fm:updateCheck';
const SNOOZE_KEY = 'fm:updateSnoozeUntil';
const ENABLED_KEY = 'fm:updateCheckEnabled';

const newerResult = {
  checkedAt: Date.now(),
  localVersion: '1.4.0',
  remoteVersion: '99.0.0',
  isNewer: true
};

const olderResult = {
  checkedAt: Date.now(),
  localVersion: '1.4.0',
  remoteVersion: '1.3.0',
  isNewer: false
};

async function getSW(extensionContext) {
  let sw = extensionContext.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
  if (!sw) sw = await extensionContext.waitForEvent('serviceworker', { timeout: 10_000 });
  return sw;
}

async function setStorage(extensionContext, entries) {
  const sw = await getSW(extensionContext);
  await sw.evaluate(async (e) => {
    await chrome.storage.local.set(e);
  }, entries);
}

async function clearStorage(extensionContext, keys) {
  const sw = await getSW(extensionContext);
  await sw.evaluate(async (ks) => {
    await chrome.storage.local.remove(ks);
  }, keys);
}

test.describe('FMN-157: update-available banner in popup', () => {
  test.beforeEach(async ({ extensionContext }) => {
    // Reset state across runs - extensionContext is worker-scoped
    // (shared across tests). Clear our keys so a stale state from a
    // prior test doesn't leak in.
    await clearStorage(extensionContext, [RESULT_KEY, SNOOZE_KEY, ENABLED_KEY]);
  });

  test('renders when isNewer=true and no snooze active', async ({ extensionContext, extensionId }) => {
    await setStorage(extensionContext, { [RESULT_KEY]: newerResult });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    const banner = page.locator('#update-banner');
    await expect(banner).toBeVisible();

    // Body text references both versions.
    await expect(banner).toContainText('Update available:');
    await expect(banner).toContainText('99.0.0');
    await expect(banner).toContainText('1.4.0');
    // Operator instructions reference `git pull`.
    await expect(banner).toContainText('git pull');

    // Both action buttons present.
    await expect(page.locator('#update-snooze')).toBeVisible();
    await expect(page.locator('#update-dismiss')).toBeVisible();

    await page.close();
  });

  test('hidden when isNewer=false', async ({ extensionContext, extensionId }) => {
    await setStorage(extensionContext, { [RESULT_KEY]: olderResult });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    await expect(page.locator('#update-banner')).toBeHidden();
    await page.close();
  });

  test('hidden when no update-check result has ever been stored', async ({ extensionContext, extensionId }) => {
    // No RESULT_KEY in storage.
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    await expect(page.locator('#update-banner')).toBeHidden();
    await page.close();
  });

  test('hidden when fm:updateSnoozeUntil is in the future', async ({ extensionContext, extensionId }) => {
    await setStorage(extensionContext, {
      [RESULT_KEY]: newerResult,
      [SNOOZE_KEY]: Date.now() + (24 * 60 * 60 * 1000)
    });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    await expect(page.locator('#update-banner')).toBeHidden();
    await page.close();
  });

  test('visible again once fm:updateSnoozeUntil is in the past', async ({ extensionContext, extensionId }) => {
    await setStorage(extensionContext, {
      [RESULT_KEY]: newerResult,
      [SNOOZE_KEY]: Date.now() - 1000
    });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    await expect(page.locator('#update-banner')).toBeVisible();
    await page.close();
  });

  test('hidden when fm:updateCheckEnabled is explicitly false', async ({ extensionContext, extensionId }) => {
    await setStorage(extensionContext, {
      [RESULT_KEY]: newerResult,
      [ENABLED_KEY]: false
    });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    await expect(page.locator('#update-banner')).toBeHidden();
    await page.close();
  });

  test('Snooze 7 days button stores snoozeUntil ~7d ahead and hides the banner', async ({ extensionContext, extensionId }) => {
    await setStorage(extensionContext, { [RESULT_KEY]: newerResult });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    const banner = page.locator('#update-banner');
    await expect(banner).toBeVisible();

    const before = Date.now();
    await page.locator('#update-snooze').click();
    await expect(banner).toBeHidden();

    // Verify the storage write.
    const sw = await getSW(extensionContext);
    const stored = await sw.evaluate(async (k) => {
      const d = await chrome.storage.local.get(k);
      return d?.[k];
    }, SNOOZE_KEY);
    const after = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(stored).toBeGreaterThanOrEqual(before + sevenDaysMs - 5_000);
    expect(stored).toBeLessThanOrEqual(after + sevenDaysMs + 5_000);

    await page.close();
  });

  test('Dismiss button stores snoozeUntil ~24h ahead and hides the banner', async ({ extensionContext, extensionId }) => {
    await setStorage(extensionContext, { [RESULT_KEY]: newerResult });

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    const banner = page.locator('#update-banner');
    await expect(banner).toBeVisible();

    const before = Date.now();
    await page.locator('#update-dismiss').click();
    await expect(banner).toBeHidden();

    const sw = await getSW(extensionContext);
    const stored = await sw.evaluate(async (k) => {
      const d = await chrome.storage.local.get(k);
      return d?.[k];
    }, SNOOZE_KEY);
    const after = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(stored).toBeGreaterThanOrEqual(before + oneDayMs - 5_000);
    expect(stored).toBeLessThanOrEqual(after + oneDayMs + 5_000);

    await page.close();
  });

  test('Settings toggle "Check the GitHub repo for newer versions" reflects + persists the flag', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    await page.locator('#settings-toggle').click();
    const toggle = page.locator('#update-check-toggle');
    await expect(toggle).toBeAttached();
    // Default is ON.
    await expect(toggle).toBeChecked();

    // Toggle off, verify storage.
    await toggle.uncheck();
    const sw = await getSW(extensionContext);
    const off = await sw.evaluate(async (k) => {
      const d = await chrome.storage.local.get(k);
      return d?.[k];
    }, ENABLED_KEY);
    expect(off).toBe(false);

    // Toggle back on.
    await toggle.check();
    const on = await sw.evaluate(async (k) => {
      const d = await chrome.storage.local.get(k);
      return d?.[k];
    }, ENABLED_KEY);
    expect(on).toBe(true);

    await page.close();
  });
});
