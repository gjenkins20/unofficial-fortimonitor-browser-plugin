// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-225: Auto-tag instances by name regex.
//
// Configure step covers regex / template input, live preview against the
// picked targets, and Next-button gating on regex validity. Commit
// describes() are validated by the unit suite; this spec focuses on the
// configure-form UX and Preview-step round-trip.
//
// Stubs chrome.runtime.sendMessage (memory:
// playwright_stub_chrome_runtime_only).
//
// Run: npx playwright test tests/e2e/fmn-225-auto-tag-by-name.spec.js

import { test, expect } from './fixtures.js';

const TAGS_BY_ID = {
  100: ['prod'],
  101: [],
  102: ['edge', 'sitecode=712']
};

async function installSwStub(page) {
  await page.evaluate(({ tagsById }) => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__FMN_225_CALLS = [];
    chrome.runtime.sendMessage = function patched(msg, cb) {
      const type = msg?.type;
      const payload = msg?.payload || {};
      const respondWith = (result) => setTimeout(() => cb({ ok: true, result }), 0);
      window.__FMN_225_CALLS.push({ type, ids: Array.isArray(payload?.serverIds) ? payload.serverIds.slice() : null });
      if (type === 'bulk-composer:list-tags-batch') {
        const byServerId = {};
        for (const id of (payload.serverIds || [])) byServerId[id] = tagsById[id] ?? null;
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
  }, { tagsById: TAGS_BY_ID });
}

async function openConfigure(page, extensionId) {
  await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
  await installSwStub(page);
  await page.evaluate(async () => {
    const mod = await import('./app.js');
    mod.store.targets = [
      { id: 100, name: 'FGT-684-edge-01' },
      { id: 101, name: 'FGT-684-edge-02' },
      { id: 102, name: 'FGT-712-edge-01' },
      { id: 103, name: 'unrelated-host' }
    ];
    mod.store.actionId = 'auto-tag-by-name';
    mod.store.params = {};
    window.location.hash = '#/configure';
  });
  await expect(page.locator('[data-test="auto-tag-regex-input"]')).toBeVisible({ timeout: 10000 });
}

test.describe('FMN-225: Auto-tag by name pattern', () => {
  test('preview renders matches with highlighted captures and resulting tags', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);

    await page.locator('[data-test="auto-tag-regex-input"]').fill('^FGT-(\\d{3})-');
    await page.locator('[data-test="auto-tag-template-input"]').fill('sitecode=$1');

    // 3 matches (100, 101, 102) + 1 no-match (103)
    await expect(page.locator('[data-test="auto-tag-preview-summary"]'))
      .toHaveText('3 matches · 1 no-match');

    const rows = page.locator('[data-test="auto-tag-preview-row"]');
    await expect(rows).toHaveCount(3);
    const tagCells = await page.locator('[data-test="auto-tag-preview-tag"]').allTextContents();
    expect(tagCells).toEqual(['sitecode=684', 'sitecode=684', 'sitecode=712']);

    await page.close();
  });

  test('Next button stays disabled until both inputs + valid regex are present', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);

    const next = page.locator('[data-test="configure-next"]');
    await expect(next).toBeDisabled();

    // Regex only -> still disabled
    await page.locator('[data-test="auto-tag-regex-input"]').fill('^FGT-(\\d{3})-');
    await expect(next).toBeDisabled();

    // Add template -> enabled
    await page.locator('[data-test="auto-tag-template-input"]').fill('sitecode=$1');
    await expect(next).toBeEnabled();

    // Break the regex -> disabled again, error surfaces
    await page.locator('[data-test="auto-tag-regex-input"]').fill('[unclosed');
    await expect(next).toBeDisabled();
    await expect(page.locator('[data-test="auto-tag-regex-error"]')).toBeVisible();

    await page.close();
  });

  test('tag enrichment fires for store.targets so Preview describe() is accurate', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);

    // Allow the live tag fetch to land. We trigger it on form render.
    await expect.poll(() => page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.targets.map((t) => Array.isArray(t.tags) ? t.tags.slice() : t.tags);
    })).toEqual([
      ['prod'],
      [],
      ['edge', 'sitecode=712'],
      null  // 103 has no entry in TAGS_BY_ID -> null sentinel
    ]);

    await page.close();
  });
});
