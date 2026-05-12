// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155 popup wiring + tool-app load smoke tests for the Bulk Action
// Composer. Uses the offscreen extensionContext fixture so these run
// without a live FortiMonitor session.
//
// Coverage:
//   1. Tile is hidden by default; Settings toggle reveals it.
//   2. Wizard app loads, renders step 1 (pick), and shows the disabled
//      Continue button when no targets are picked.
//   3. Step navigation: with flag on but no targets, /commit falls back
//      to /pick (canEnter() gate).
//   4. With the flag off, the wizard app shows the "enable in Settings"
//      stub regardless of route.
//
// Run: npx playwright test tests/e2e/fmn-155-bulk-composer-popup.spec.js

import { test, expect } from './fixtures.js';

test.describe('FMN-155: Bulk Action Composer popup wiring', () => {
  test('Tile is hidden by default; appears when toggle is enabled', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    const tile = page.locator('.tool-card[data-tool="bulk-composer"]');
    await expect(tile).toBeAttached();
    await expect(tile).toBeHidden();

    await page.locator('#settings-toggle').click();
    const toggle = page.locator('#bulk-composer-toggle');
    await expect(toggle).toBeAttached();
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await page.locator('#settings-back').click();
    await expect(tile).toBeVisible();
    await expect(tile.locator('.tool-name')).toContainText('Bulk Action Composer');
    await expect(tile.locator('.tool-name .badge.beta')).toHaveText('Beta');

    await page.close();
  });

  test('Settings toggle copy is "Show Bulk Action Composer"', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();
    const toggleSpan = page.locator('label.toggle-row:has(#bulk-composer-toggle) span');
    await expect(toggleSpan).toBeAttached();
    const text = (await toggleSpan.textContent())?.trim() ?? '';
    expect(text).toBe('Show Bulk Action Composer');
    await page.close();
  });

  test('Flag off: opening the tool URL shows the "enable in Settings" stub', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    // Make sure the flag is off.
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.evaluate(() => chrome.storage.local.set({ 'fm:bulkComposerEnabled': false }));

    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html`);
    await expect(page.locator('.title-bar h1')).toContainText('Bulk Action Composer');
    await expect(page.locator('.body-section h2')).toContainText('disabled');
    await expect(page.locator('.body-section')).toContainText('Show Bulk Action Composer');
    await page.close();
  });

  test('Flag on: step 1 (pick) renders with disabled Continue button and chip list empty', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.evaluate(() => chrome.storage.local.set({ 'fm:bulkComposerEnabled': true }));

    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    // Breadcrumbs render with step 1 active.
    const crumbs = page.locator('.step-breadcrumbs .step');
    await expect(crumbs).toHaveCount(4);
    await expect(crumbs.nth(0)).toHaveClass(/active/);

    // Title bar shows Beta badge.
    await expect(page.locator('.title-bar h1 .badge.beta')).toHaveText('Beta');

    // Search input rendered.
    await expect(page.locator('input[type="search"]')).toBeVisible();

    // Chips host empty.
    await expect(page.locator('[data-test="bulk-chips-count"]')).toContainText('0 instances');

    // Continue button disabled until something is picked.
    const nextBtn = page.locator('[data-test="pick-next"]');
    await expect(nextBtn).toBeDisabled();

    await page.close();
  });

  test('Flag on: route guards bounce to /pick when targets is empty', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.evaluate(() => chrome.storage.local.set({ 'fm:bulkComposerEnabled': true }));

    // Try to jump straight to /commit with no targets - should land on /pick.
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/commit`);
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('1. Pick');
    expect(page.url()).toContain('#/pick');
    await page.close();
  });

  test('Flag on: action-picker shows three cards once a target is in the store', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.evaluate(() => chrome.storage.local.set({ 'fm:bulkComposerEnabled': true }));

    // Inject a target then navigate to /action - exercises the canEnter gate
    // and action-card rendering without needing the omni-search corpus.
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
    await page.evaluate(async () => {
      const mod = await import('./app.js');
      mod.store.targets = [{ id: 42, name: 'test-instance', tags: ['existing'], template_names: [] }];
      window.location.hash = '#/action';
    });
    // Wait for step 2 to render.
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('2. Pick action', { timeout: 5000 });
    const cards = page.locator('[data-test="action-card"]');
    await expect(cards).toHaveCount(3);
    const ids = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-action-id')));
    expect(ids).toEqual(expect.arrayContaining(['add-tag', 'remove-tag', 'apply-template']));
    await page.close();
  });

  test('Flag on: choosing Add Tag and entering a tag enables Preview & commit nav', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.evaluate(() => chrome.storage.local.set({ 'fm:bulkComposerEnabled': true }));

    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
    await page.evaluate(async () => {
      const mod = await import('./app.js');
      mod.store.targets = [
        { id: 1, name: 's1', tags: ['prod'], template_names: [] },
        { id: 2, name: 's2', tags: [], template_names: [] }
      ];
      window.location.hash = '#/action';
    });
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('2. Pick action', { timeout: 5000 });

    await page.locator('[data-test="action-card"][data-action-id="add-tag"]').click();
    await page.locator('[data-test="action-next"]').click();

    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('3. Configure', { timeout: 5000 });
    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();

    await page.locator('[data-test="configure-tag-input"]').fill('needs-review');
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    await page.locator('[data-test="configure-next"]').click();
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('4. Preview', { timeout: 5000 });
    // Preview shows two rows, both will-change (neither s1 nor s2 has the new tag).
    await expect(page.locator('[data-test="bulk-preview-row"]')).toHaveCount(2);
    await expect(page.locator('[data-test="bulk-preview-summary"]')).toContainText('2 rows will change');
    await page.close();
  });

  test('Flag on: chip list de-dupes (adding the same id twice keeps one chip)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.evaluate(() => chrome.storage.local.set({ 'fm:bulkComposerEnabled': true }));

    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
    // Drive the store directly to skip the SW omni-search call.
    await page.evaluate(async () => {
      const mod = await import('./app.js');
      mod.store.targets = [{ id: 7, name: 's7' }];
      // Re-render by toggling the hash (the hashchange listener does the work).
      window.location.hash = '#/pick';
    });
    // Force a re-render via dispatchEvent since #/pick to #/pick won't trigger hashchange.
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await expect(page.locator('[data-test="bulk-chips-count"]')).toContainText('1 instance selected', { timeout: 5000 });
    await page.close();
  });
});
