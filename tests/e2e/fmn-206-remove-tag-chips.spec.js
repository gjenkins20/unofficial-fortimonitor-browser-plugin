// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-206: Bulk Composer Remove Tag chip flow.
//
// Verifies the Configure step's async tag-fetch + chip-render flow when
// the chosen action is remove-tag. The fix wires two SW handlers into
// renderTagForm: cache-first omni-search:lookup-by-ids, then live
// bulk-composer:list-tags-batch for IDs the cache didn't cover. Both
// handlers are stubbed via chrome.runtime.sendMessage so the spec runs
// without a live FortiMonitor session.
//
// Per memory playwright_stub_chrome_runtime_only: stub sendMessage only,
// leave chrome.tabs / chrome.storage real. The stub forwards anything
// not explicitly intercepted to the real sendMessage so other UI calls
// keep working.
//
// Run: npx playwright test tests/e2e/fmn-206-remove-tag-chips.spec.js

import { test, expect } from './fixtures.js';

async function seedTargetsAndStub({ page, targets, lookupReply, batchReply }) {
  await page.evaluate(({ targets, lookupReply, batchReply }) => {
    // Stash the canned replies where the patched sendMessage can find them.
    window.__fmn206TestReplies = { lookupReply, batchReply };

    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function (msg, cb) {
      const type = msg && msg.type;
      if (type === 'omni-search:lookup-by-ids') {
        const result = window.__fmn206TestReplies.lookupReply;
        const envelope = result === null
          ? { ok: false, error: 'stub-error' }
          : { ok: true, result };
        if (typeof cb === 'function') cb(envelope);
        return undefined;
      }
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
  }, { targets, lookupReply, batchReply });

  // Seed store.targets via the app's exported store.
  await page.evaluate(async ({ targets }) => {
    const mod = await import('./app.js');
    mod.store.targets = targets;
    mod.store.actionId = 'remove-tag';
    mod.store.params = {};
    window.location.hash = '#/configure';
  }, { targets });
}

test.describe('FMN-206: Bulk Composer Remove Tag chip list', () => {
  test('Chips render from omni-search cache hits (common path)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    await seedTargetsAndStub({
      page,
      targets: [
        { id: 100, name: 's100' },
        { id: 101, name: 's101' },
        { id: 102, name: 's102' }
      ],
      lookupReply: {
        byServerId: {
          100: { name: 's100', tags: ['prod', 'firewall'] },
          101: { name: 's101', tags: ['prod'] },
          102: { name: 's102', tags: [] }
        }
      },
      batchReply: { byServerId: {} } // should not be consulted
    });

    // The chip mount should populate; loading placeholder should disappear.
    const chipRow = page.locator('[data-test="configure-existing-tags"]');
    await expect(chipRow).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-test="configure-tags-loading"]')).toHaveCount(0);

    const chips = page.locator('[data-test="existing-tag-chip"]');
    await expect(chips).toHaveCount(2);
    // 'prod' should be first (count 2), 'firewall' second (count 1).
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
      lookupReply: {
        byServerId: {
          100: { name: 's100', tags: ['prod'] }
        }
      },
      batchReply: { byServerId: {} }
    });

    await expect(page.locator('[data-test="configure-existing-tags"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();

    await page.locator('[data-test="existing-tag-chip"]').first().click();
    await expect(page.locator('[data-test="configure-tag-input"]')).toHaveValue('prod');
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    await page.close();
  });

  test('Cache miss falls back to live batch fetch (IDs absent from cacheMap)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    await seedTargetsAndStub({
      page,
      targets: [
        { id: 200, name: 's200' },
        { id: 201, name: 's201' }
      ],
      // Cache has nothing for these IDs.
      lookupReply: { byServerId: {} },
      // Live fetch fills the gap.
      batchReply: {
        byServerId: {
          200: ['legacy'],
          201: ['legacy', 'edge']
        }
      }
    });

    await expect(page.locator('[data-test="configure-existing-tags"]')).toBeVisible({ timeout: 5000 });
    const chips = page.locator('[data-test="existing-tag-chip"]');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toContainText('legacy');
    await expect(chips.nth(0)).toContainText('×2');
    await expect(chips.nth(1)).toContainText('edge');
    await expect(chips.nth(1)).toContainText('×1');

    await page.close();
  });

  test('Empty-state copy when neither fetch yields tags', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    await seedTargetsAndStub({
      page,
      targets: [{ id: 300, name: 's300' }],
      lookupReply: { byServerId: {} },
      batchReply: { byServerId: { 300: [] } }
    });

    // Loading state disappears, replaced by the empty copy.
    await expect(page.locator('[data-test="configure-tags-loading"]')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('[data-test="configure-chip-mount"]')).toContainText(
      'No tags found on the selected instances'
    );
    await expect(page.locator('[data-test="existing-tag-chip"]')).toHaveCount(0);

    // Manual input is still available.
    await expect(page.locator('[data-test="configure-tag-input"]')).toBeVisible();

    await page.close();
  });

  test('Live fallback failure leaves the form usable (manual input only)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    await seedTargetsAndStub({
      page,
      targets: [{ id: 400, name: 's400' }],
      lookupReply: { byServerId: {} },
      batchReply: null // forces the live fetch path to throw
    });

    await expect(page.locator('[data-test="configure-tags-loading"]')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('[data-test="configure-chip-mount"]')).toContainText(
      'No tags found on the selected instances'
    );
    // Operator can still type a tag and proceed.
    await page.locator('[data-test="configure-tag-input"]').fill('manual-tag');
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    await page.close();
  });
});
