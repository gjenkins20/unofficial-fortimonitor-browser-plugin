// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-210: Preview-step pre-flight of attached template names.
//
// Verifies that entering the Preview (commit) step fires the
// list-template-names-batch SW handler for any target whose
// template_names is unset, patches the row's PREV/NEXT cells in place
// when the fetch resolves, and caches the result on
// store.targets[i].template_names so re-entry doesn't refetch.
//
// Stubs chrome.runtime.sendMessage (memory:
// playwright_stub_chrome_runtime_only).
//
// Run: npx playwright test tests/e2e/fmn-210-preview-template-pre-flight.spec.js

import { test, expect } from './fixtures.js';

const TEMPLATE_URL = 'https://api2.panopta.com/v2/server_template/100/';
const TEMPLATE_NAME = 'Edge FortiGate';

async function installSwStub(page) {
  await page.evaluate(({ templateUrl }) => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__FMN_210_CALLS = [];
    chrome.runtime.sendMessage = function patched(msg, cb) {
      const type = msg?.type;
      const payload = msg?.payload || {};
      const respondWith = (result) => setTimeout(() => cb({ ok: true, result }), 0);
      window.__FMN_210_CALLS.push({ type, ids: Array.isArray(payload?.serverIds) ? payload.serverIds.slice() : null });
      if (type === 'bulk-composer:list-template-names-batch') {
        const byServerId = {};
        for (const id of (payload.serverIds || [])) {
          // 10 has the target template + one other
          // 11 has only the target template (already-attached scenario)
          // 12 has nothing
          if (id === 10) byServerId[id] = ['Edge FortiGate', 'Standard SLA'];
          else if (id === 11) byServerId[id] = ['Edge FortiGate'];
          else if (id === 12) byServerId[id] = [];
          else byServerId[id] = null;
        }
        respondWith({ byServerId });
        return true;
      }
      return real(msg, cb);
    };
    void templateUrl;
  }, { templateUrl: TEMPLATE_URL });
}

async function openCommit(page, extensionId) {
  await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
  await installSwStub(page);
  await page.evaluate(async ({ templateUrl, templateName }) => {
    const mod = await import('./app.js');
    mod.store.targets = [
      { id: 10, name: 'site-A-fgt' },
      { id: 11, name: 'site-B-fgt' },
      { id: 12, name: 'site-C-fgt' }
    ];
    mod.store.actionId = 'apply-template';
    mod.store.params = { templateUrl, templateId: 100, templateName, continuous: true };
    window.location.hash = '#/commit';
  }, { templateUrl: TEMPLATE_URL, templateName: TEMPLATE_NAME });
  await expect(page.locator('[data-test="bulk-preview-table"]')).toBeVisible({ timeout: 10000 });
}

test.describe('FMN-210: Preview pre-flight template-name enrichment', () => {
  test('fires list-template-names-batch and patches rows with real PREV values', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openCommit(page, extensionId);

    // Initial render: targets have no template_names, so describe() takes
    // the "(templates unknown)" placeholder branch on every row.
    const initialRows = await page.locator('[data-test="bulk-preview-row"]').count();
    expect(initialRows).toBe(3);

    // Wait for the patched PREV cells. Row order matches target order.
    await expect(page.locator('[data-test="bulk-preview-row"]').nth(0).locator('td').nth(2))
      .toHaveText('Edge FortiGate, Standard SLA', { timeout: 5000 });
    await expect(page.locator('[data-test="bulk-preview-row"]').nth(1).locator('td').nth(2))
      .toHaveText('Edge FortiGate', { timeout: 5000 });
    await expect(page.locator('[data-test="bulk-preview-row"]').nth(2).locator('td').nth(2))
      .toHaveText('(none)', { timeout: 5000 });

    // Row 11 was already attached -> status pill flips to skip.
    await expect(page.locator('[data-test="bulk-preview-row"]').nth(1).locator('[data-test="preview-status"]'))
      .toHaveText('skip', { timeout: 5000 });

    // store.targets[i].template_names cached.
    const cached = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.targets.map((t) => Array.isArray(t.template_names) ? t.template_names : null);
    });
    expect(cached[0]).toEqual(['Edge FortiGate', 'Standard SLA']);
    expect(cached[1]).toEqual(['Edge FortiGate']);
    expect(cached[2]).toEqual([]);

    // Only one batch call fired.
    const callCount = await page.evaluate(() =>
      (window.__FMN_210_CALLS || []).filter((c) => c.type === 'bulk-composer:list-template-names-batch').length
    );
    expect(callCount).toBe(1);

    await page.close();
  });

  test('does not refetch on re-entry: navigate to /configure and back to /commit', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openCommit(page, extensionId);

    // Wait for the first fetch to land.
    await expect(page.locator('[data-test="bulk-preview-row"]').nth(0).locator('td').nth(2))
      .toHaveText('Edge FortiGate, Standard SLA', { timeout: 5000 });

    const firstCount = await page.evaluate(() =>
      (window.__FMN_210_CALLS || []).filter((c) => c.type === 'bulk-composer:list-template-names-batch').length
    );
    expect(firstCount).toBe(1);

    // Navigate away and come back.
    await page.evaluate(() => { window.location.hash = '#/configure'; });
    await page.evaluate(() => { window.location.hash = '#/commit'; });
    await expect(page.locator('[data-test="bulk-preview-table"]')).toBeVisible({ timeout: 5000 });

    // Give the (would-be) refetch a chance to fire and then assert it didn't.
    await page.waitForTimeout(200);
    const secondCount = await page.evaluate(() =>
      (window.__FMN_210_CALLS || []).filter((c) => c.type === 'bulk-composer:list-template-names-batch').length
    );
    expect(secondCount).toBe(1);

    // PREV cells still show the cached real names.
    await expect(page.locator('[data-test="bulk-preview-row"]').nth(0).locator('td').nth(2))
      .toHaveText('Edge FortiGate, Standard SLA');

    await page.close();
  });

  test('summary count and apply-button label track the post-preflight willChange count', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openCommit(page, extensionId);

    // Pre-flight outcome with the stub data: row 10 has Edge FortiGate
    // already, row 11 has Edge FortiGate already, row 12 has none. The
    // apply-template target is "Edge FortiGate" -> 1 row will change
    // (row 12), 2 rows skip (rows 10 + 11).
    await expect(page.locator('[data-test="bulk-preview-summary"]'))
      .toHaveText('1 row will change · 2 will skip · 3 total.', { timeout: 5000 });
    await expect(page.locator('[data-test="apply-btn"]'))
      .toHaveText('Apply to 1 instance');

    await page.close();
  });
});
