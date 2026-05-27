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
  test('Tile is visible by default (FMN-201: beta gate removed)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    const tile = page.locator('.tool-card[data-tool="bulk-composer"]');
    await expect(tile).toBeAttached();
    await expect(tile).toBeVisible();
    await expect(tile.locator('.tool-name')).toContainText('Bulk Action Composer');
    // Beta badge is removed in FMN-201; assert it's gone.
    await expect(tile.locator('.tool-name .badge.beta')).toHaveCount(0);

    await page.close();
  });

  test('Settings panel no longer carries a Bulk Action Composer toggle (FMN-201)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();
    await expect(page.locator('#bulk-composer-toggle')).toHaveCount(0);
    await page.close();
  });

  test('Step 1 (pick) renders the Port Scope-style load UI with disabled Continue button (FMN-163)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    // Breadcrumbs render with step 1 active.
    const crumbs = page.locator('.step-breadcrumbs .step');
    await expect(crumbs).toHaveCount(4);
    await expect(crumbs.nth(0)).toHaveClass(/active/);

    // Title bar no longer shows a Beta badge (FMN-201).
    await expect(page.locator('.title-bar h1 .badge.beta')).toHaveCount(0);

    // FMN-163: drop-zone + paste textarea + format-hint replace the
    // search-led layout. No omni-search input, no chip list. Scope the
    // search-absence check to the paste pane because FMN-224 added a
    // groups-pane search input (sibling pane, hidden by default).
    await expect(page.locator('.drop-zone')).toBeVisible();
    await expect(page.locator('textarea.paste-area')).toBeVisible();
    await expect(page.locator('.format-hint')).toBeVisible();
    await expect(page.locator('.pick-pane[data-pane="paste"] input[type="search"]')).toHaveCount(0);
    await expect(page.locator('[data-test="bulk-chips-count"]')).toHaveCount(0);

    // Empty parse-result placeholder appears.
    await expect(page.locator('.parse-result.empty .headline')).toContainText('No server IDs detected');

    // Continue button disabled until something is parsed.
    const nextBtn = page.locator('[data-test="pick-next"]');
    await expect(nextBtn).toBeDisabled();
    await expect(nextBtn).toContainText('Continue to action picker');

    await page.close();
  });

  test('Pasting valid IDs populates store.targets and enables Continue (FMN-163)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    // CSV with a header so parseServerList picks up the device_name column.
    await page.locator('textarea.paste-area').fill('server_id,device_name\n42024060,FGT-Branch-001\n42024061,');

    // Parse-result shows 2 instances with a sample table.
    await expect(page.locator('.parse-result .headline')).toContainText('2 instances ready');
    await expect(page.locator('.sample-table tbody tr')).toHaveCount(2);
    await expect(page.locator('[data-test="pick-next"]')).toBeEnabled();

    // store.targets has the canonical { id, name } shape downstream steps expect.
    const targets = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.targets;
    });
    expect(targets).toEqual([
      { id: 42024060, name: 'FGT-Branch-001' },
      { id: 42024061, name: null }
    ]);

    await page.close();
  });

  test('Route guards bounce to /pick when targets is empty', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    // Try to jump straight to /commit with no targets - should land on /pick.
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/commit`);
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('1. Pick');
    expect(page.url()).toContain('#/pick');
    await page.close();
  });

  test('Action-picker shows the registered action cards once a target is in the store', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
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
    // FMN-259: nine actions render by default. The three native-duplicate
    // actions (set-parent-group, set-agent-resource-status,
    // schedule-maintenance-window) are hidden unless the
    // SHOW_FORTIMONITOR_NATIVE_BULK_ACTIONS flag is on (FMN-170/171/172).
    await expect(cards).toHaveCount(9);
    const ids = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-action-id')));
    expect(ids).toEqual(expect.arrayContaining([
      'add-tag', 'remove-tag', 'apply-template',
      'apply-stock-fabric-templates', 'profile-and-create-templates',
      'add-port-scope', 'remove-port-scope',
      'auto-tag-by-name', 'auto-set-attribute-by-name'
    ]));
    // Native-duplicate actions stay hidden by default.
    expect(ids).not.toEqual(expect.arrayContaining([
      'set-parent-group', 'set-agent-resource-status', 'schedule-maintenance-window'
    ]));
    await page.close();
  });

  test('Choosing Add Tag and entering a tag enables Preview & commit nav', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
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

  test('Duplicate IDs in paste input dedupe to a single target with a warning (FMN-163)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
    // parseServerList dedupes duplicates with a warning - assert the warning
    // surfaces in the .warn-list block and store.targets carries one entry.
    await page.locator('textarea.paste-area').fill('42024060\n42024060\n42024060');
    await expect(page.locator('.parse-result .headline')).toContainText('1 instance');
    await expect(page.locator('.warn-list li').first()).toContainText('duplicate');
    await expect(page.locator('.warn-list li')).toHaveCount(2); // line 2 + line 3 are dupes
    const targets = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.targets;
    });
    expect(targets).toEqual([{ id: 42024060, name: null }]);
    await page.close();
  });
});
