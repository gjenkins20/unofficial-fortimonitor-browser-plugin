// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-234: Similarity-driven regex recommendation chips on the Auto-tag
// Configure step.
//
// Stubs chrome.runtime.sendMessage only (memory:
// playwright_stub_chrome_runtime_only).
//
// Run: npx playwright test tests/e2e/fmn-234-regex-recommendations.spec.js

import { test, expect } from './fixtures.js';

async function installSwStub(page) {
  await page.evaluate(() => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function patched(msg, cb) {
      const type = msg?.type;
      const payload = msg?.payload || {};
      const respondWith = (result) => setTimeout(() => cb({ ok: true, result }), 0);
      if (type === 'bulk-composer:list-tags-batch') {
        const byServerId = {};
        for (const id of (payload.serverIds || [])) byServerId[id] = [];
        respondWith({ byServerId });
        return true;
      }
      if (type === 'bulk-composer:list-template-names-batch') {
        const byServerId = {};
        for (const id of (payload.serverIds || [])) byServerId[id] = [];
        respondWith({ byServerId });
        return true;
      }
      return real(msg, cb);
    };
  });
}

async function openConfigureWithTargets(page, extensionId, targets) {
  await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
  await installSwStub(page);
  await page.evaluate(async ({ targets }) => {
    const mod = await import('./app.js');
    mod.store.targets = targets;
    mod.store.actionId = 'auto-tag-by-name';
    mod.store.params = {};
    window.location.hash = '#/configure';
  }, { targets });
  await expect(page.locator('[data-test="auto-tag-regex-input"]')).toBeVisible({ timeout: 10000 });
}

test.describe('FMN-234: Auto-tag regex suggestion chips', () => {
  test('renders 1+ chips when picked targets share a digit-run pattern', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigureWithTargets(page, extensionId, [
      { id: 100, name: 'FGT-684-edge-01' },
      { id: 101, name: 'FGT-712-edge-02' },
      { id: 102, name: 'FGT-301-edge-03' },
    ]);

    const container = page.locator('[data-test="auto-tag-suggestions"]');
    await expect(container).toBeVisible();
    const chips = page.locator('[data-test="auto-tag-suggestion-chip"]');
    await expect.poll(() => chips.count()).toBeGreaterThan(0);

    const labels = await chips.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-regex'))
    );
    expect(labels.some((r) => r && r.includes('FGT') && r.includes('\\d{3}'))).toBe(true);

    await page.close();
  });

  test('clicking a chip populates regex + template inputs and refreshes preview', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigureWithTargets(page, extensionId, [
      { id: 100, name: 'FGT-684-edge-01' },
      { id: 101, name: 'FGT-712-edge-02' },
      { id: 102, name: 'FGT-301-edge-03' },
    ]);

    const regexInput = page.locator('[data-test="auto-tag-regex-input"]');
    const tplInput = page.locator('[data-test="auto-tag-template-input"]');
    await expect(regexInput).toHaveValue('');
    await expect(tplInput).toHaveValue('');

    const digitRunChip = page.locator('[data-test="auto-tag-suggestion-chip"][data-source="digit-run-exact-prefix"]').first();
    await expect(digitRunChip).toBeVisible();
    await digitRunChip.click();

    await expect(regexInput).toHaveValue('^FGT-(\\d{3})');
    await expect(tplInput).toHaveValue('sitecode=$1');
    await expect(page.locator('[data-test="auto-tag-preview-summary"]'))
      .toHaveText('3 matches · 0 no-matches');

    await page.close();
  });

  test('no suggestion container when picked names share no detectable pattern', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigureWithTargets(page, extensionId, [
      { id: 200, name: 'whollyrandom' },
      { id: 201, name: 'lonelyhost' },
      { id: 202, name: 'isolatedname' },
    ]);

    const container = page.locator('[data-test="auto-tag-suggestions"]');
    await expect(container).toBeHidden();

    await page.close();
  });

  test('Next button enables after chip click without further typing', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigureWithTargets(page, extensionId, [
      { id: 100, name: 'FGT-684-edge-01' },
      { id: 101, name: 'FGT-712-edge-02' },
      { id: 102, name: 'FGT-301-edge-03' },
    ]);

    const next = page.locator('[data-test="configure-next"]');
    await expect(next).toBeDisabled();

    await page.locator('[data-test="auto-tag-suggestion-chip"]').first().click();
    await expect(next).toBeEnabled();

    await page.close();
  });
});
