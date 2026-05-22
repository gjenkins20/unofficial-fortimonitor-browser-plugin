// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-235: "Same devices as last run" shortcut on the Bulk Action Composer
// Pick step. Seeds chrome.storage.local with a recent-picks ring buffer,
// loads the Pick step, asserts the recent-runs row renders and clicking
// a card loads the saved set into the parse-result panel.
//
// Stubs chrome.runtime.sendMessage only (memory:
// playwright_stub_chrome_runtime_only).
//
// Run: npx playwright test tests/e2e/fmn-235-recent-picks.spec.js

import { test, expect } from './fixtures.js';

async function installSwStub(page, { tagsById = {} } = {}) {
  await page.evaluate(({ tagsById }) => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function patched(msg, cb) {
      const type = msg?.type;
      const payload = msg?.payload || {};
      const respondWith = (result) => setTimeout(() => cb({ ok: true, result }), 0);
      if (type === 'bulk-composer:list-tags-batch') {
        const byServerId = {};
        for (const id of (payload.serverIds || [])) {
          byServerId[id] = Object.prototype.hasOwnProperty.call(tagsById, id) ? tagsById[id] : null;
        }
        respondWith({ byServerId });
        return true;
      }
      return real(msg, cb);
    };
  }, { tagsById });
}

async function seedRecentPicks(page, entries) {
  await page.evaluate((entries) => {
    return chrome.storage.local.set({ 'bulk-composer:recent-picks': entries });
  }, entries);
}

async function clearRecentPicks(page) {
  await page.evaluate(() => chrome.storage.local.remove('bulk-composer:recent-picks'));
}

async function openPick(page, extensionId) {
  await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
  await expect(page.locator('[data-test="pick-tab-paste"]')).toBeVisible({ timeout: 10000 });
}

test.describe('FMN-235: recent-picks row on Pick step', () => {
  test('row is hidden when no recent picks have been saved', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openPick(page, extensionId);
    await clearRecentPicks(page);
    // Reload so the async loader runs against the cleared key.
    await page.reload();
    await expect(page.locator('[data-test="pick-tab-paste"]')).toBeVisible();
    await expect(page.locator('[data-test="pick-recent-row"]')).toBeHidden();
    await page.close();
  });

  test('renders one card per saved entry, newest first', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openPick(page, extensionId);
    await seedRecentPicks(page, [
      { savedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(), targets: [
        { id: 100, name: 'FGT-684-edge-01' }, { id: 101, name: 'FGT-712-edge-02' }
      ]},
      { savedAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(), targets: [
        { id: 200, name: 'FAP-101' }, { id: 201, name: 'FAP-102' }, { id: 202, name: 'FAP-103' }
      ]},
    ]);
    await page.reload();
    await expect(page.locator('[data-test="pick-recent-row"]')).toBeVisible();
    const cards = page.locator('[data-test="recent-pick-card"]');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText('2 instances');
    await expect(cards.nth(0)).toContainText('min ago');
    await expect(cards.nth(1)).toContainText('3 instances');
    await expect(cards.nth(1)).toContainText(/yesterday|hr ago/);
    await page.close();
  });

  test('clicking a card loads targets and surfaces the parse-result', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openPick(page, extensionId);
    await installSwStub(page, { tagsById: { 100: [], 101: ['edge'] } });
    await seedRecentPicks(page, [
      { savedAt: new Date().toISOString(), targets: [
        { id: 100, name: 'FGT-684-edge-01' }, { id: 101, name: 'FGT-712-edge-02' }
      ]},
    ]);
    await page.reload();
    await installSwStub(page, { tagsById: { 100: [], 101: ['edge'] } });
    const card = page.locator('[data-test="recent-pick-card"]').first();
    await expect(card).toBeVisible();
    await card.click();

    // Loaded into the parse-result panel; no warning row since both IDs validated.
    await expect(page.locator('.parse-result .headline')).toContainText('2 instances ready');
    await expect(page.locator('.parse-result .warn-list')).toHaveCount(0);
    await expect(page.locator('[data-test="pick-next"]')).toBeEnabled();
    await page.close();
  });

  test('missing IDs surface a warning and the survivors load', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openPick(page, extensionId);
    // 100 exists; 999 returns null sentinel -> missing.
    await installSwStub(page, { tagsById: { 100: [], 999: null } });
    await seedRecentPicks(page, [
      { savedAt: new Date().toISOString(), targets: [
        { id: 100, name: 'FGT-684-edge-01' }, { id: 999, name: 'deleted-host' }
      ]},
    ]);
    await page.reload();
    await installSwStub(page, { tagsById: { 100: [], 999: null } });
    await page.locator('[data-test="recent-pick-card"]').first().click();

    await expect(page.locator('.parse-result .headline')).toContainText('1 instance ready');
    await expect(page.locator('.parse-result .warn-list')).toContainText(/1 of 2 instances? from this run no longer exist/);
    await expect(page.locator('[data-test="pick-next"]')).toBeEnabled();
    await page.close();
  });

  test('all-missing case shows empty headline and disables Continue', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openPick(page, extensionId);
    await installSwStub(page, { tagsById: { 998: null, 999: null } });
    await seedRecentPicks(page, [
      { savedAt: new Date().toISOString(), targets: [
        { id: 998, name: 'gone-1' }, { id: 999, name: 'gone-2' }
      ]},
    ]);
    await page.reload();
    await installSwStub(page, { tagsById: { 998: null, 999: null } });
    await page.locator('[data-test="recent-pick-card"]').first().click();

    await expect(page.locator('.parse-result .headline')).toContainText('no longer available');
    await expect(page.locator('[data-test="pick-next"]')).toBeDisabled();
    await page.close();
  });
});
