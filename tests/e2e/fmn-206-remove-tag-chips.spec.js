// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-206: Bulk Composer Remove Tag chip flow.
//
// Verifies the Configure step's live tag-fetch + chip-render flow when
// the chosen action is remove-tag. The fix wires bulk-composer:list-
// tags-batch into renderTagForm; the SW handler does a GET /server/{id}
// per picked target so the chip list (and the downstream Preview's PREV
// column) reflects the tenant's current state. The cache-first path
// was tried and abandoned because the omni-search cache went stale
// between bulk operations, painting PREV columns that didn't match
// reality.
//
// The handler is stubbed via chrome.runtime.sendMessage so the spec
// runs without a live FortiMonitor session. Per memory
// playwright_stub_chrome_runtime_only: stub sendMessage only, leave
// chrome.tabs / chrome.storage real.
//
// Run: npx playwright test tests/e2e/fmn-206-remove-tag-chips.spec.js

import { test, expect } from './fixtures.js';

async function seedTargetsAndStub({ page, targets, batchReply }) {
  await page.evaluate(({ batchReply }) => {
    window.__fmn206TestReplies = { batchReply };

    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function (msg, cb) {
      const type = msg && msg.type;
      if (type === 'bulk-composer:list-tags-batch') {
        const result = window.__fmn206TestReplies.batchReply;
        const envelope = result === null
          ? { ok: false, error: 'stub-error' }
          : { ok: true, result };
        if (typeof cb === 'function') cb(envelope);
        return undefined;
      }
      return originalSendMessage(msg, cb);
    };
  }, { batchReply });

  await page.evaluate(async ({ targets }) => {
    const mod = await import('./app.js');
    mod.store.targets = targets;
    mod.store.actionId = 'remove-tag';
    mod.store.params = {};
    window.location.hash = '#/configure';
  }, { targets });
}

test.describe('FMN-206: Bulk Composer Remove Tag chip list', () => {
  test('Chips render from the live tag-batch response with per-tag counts', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    await seedTargetsAndStub({
      page,
      targets: [
        { id: 100, name: 's100' },
        { id: 101, name: 's101' },
        { id: 102, name: 's102' }
      ],
      batchReply: {
        byServerId: {
          100: ['prod', 'firewall'],
          101: ['prod'],
          102: []
        }
      }
    });

    const chipRow = page.locator('[data-test="configure-existing-tags"]');
    await expect(chipRow).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-test="configure-tags-loading"]')).toHaveCount(0);

    const chips = page.locator('[data-test="existing-tag-chip"]');
    await expect(chips).toHaveCount(2);
    // 'prod' first (count 2), 'firewall' second (count 1).
    await expect(chips.nth(0)).toContainText('prod');
    await expect(chips.nth(0)).toContainText('×2');
    await expect(chips.nth(1)).toContainText('firewall');
    await expect(chips.nth(1)).toContainText('×1');

    await page.close();
  });

  test('Clicking a chip fills the tag input and enables Next', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    await seedTargetsAndStub({
      page,
      targets: [{ id: 100, name: 's100' }],
      batchReply: { byServerId: { 100: ['prod'] } }
    });

    await expect(page.locator('[data-test="configure-existing-tags"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();

    await page.locator('[data-test="existing-tag-chip"]').first().click();
    await expect(page.locator('[data-test="configure-tag-input"]')).toHaveValue('prod');
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    await page.close();
  });

  test('Failed GETs (null in the response) skip that target without breaking the chip render', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    await seedTargetsAndStub({
      page,
      targets: [
        { id: 200, name: 's200' },
        { id: 999, name: null } // bogus ID; SW handler maps failures to null tags
      ],
      batchReply: {
        byServerId: {
          200: ['legacy', 'edge'],
          999: null
        }
      }
    });

    await expect(page.locator('[data-test="configure-existing-tags"]')).toBeVisible({ timeout: 5000 });
    const chips = page.locator('[data-test="existing-tag-chip"]');
    await expect(chips).toHaveCount(2);
    // Equal counts (each tag appears once); secondary sort is alphabetical.
    await expect(chips.nth(0)).toContainText('edge');
    await expect(chips.nth(1)).toContainText('legacy');

    await page.close();
  });

  test('Empty-state copy when every target has no tags', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    await seedTargetsAndStub({
      page,
      targets: [{ id: 300, name: 's300' }],
      batchReply: { byServerId: { 300: [] } }
    });

    await expect(page.locator('[data-test="configure-tags-loading"]')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('[data-test="configure-chip-mount"]')).toContainText(
      'No tags found on the selected instances'
    );
    await expect(page.locator('[data-test="existing-tag-chip"]')).toHaveCount(0);
    await expect(page.locator('[data-test="configure-tag-input"]')).toBeVisible();

    await page.close();
  });

  test('Live fetch failure leaves the form usable (manual input only)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    await seedTargetsAndStub({
      page,
      targets: [{ id: 400, name: 's400' }],
      batchReply: null // forces the call() to throw
    });

    await expect(page.locator('[data-test="configure-tags-loading"]')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('[data-test="configure-chip-mount"]')).toContainText(
      'No tags found on the selected instances'
    );
    await page.locator('[data-test="configure-tag-input"]').fill('manual-tag');
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    await page.close();
  });
});
