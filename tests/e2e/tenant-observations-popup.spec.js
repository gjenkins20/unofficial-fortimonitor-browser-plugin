// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Tenant Observations popup wiring verification (FMN-133).
//
// Same shape as sdwan-report-popup.spec.js (FMN-129):
//   1. Tile is [hidden] by default in the popup.
//   2. Toggling "Show Tenant Observations" in Settings makes the tile visible.
//   3. Toggling it back off hides the tile again.
//   4. With API key seeded + flag on, clicking the tile opens the
//      tenant-observations app on the /start step (Configure).
//   5. The Configure step exposes the deep-mode and max-servers controls.
//
// Real chrome.runtime plumbing; no v2 API calls. The /start -> /collect
// transition is exercised but the actual run is allowed to fail at the
// network layer - we only assert UI scaffolding and route navigation.

import { test, expect } from './fixtures.js';
import { seedApiKey } from './seed-api-key.js';

test.describe('Tenant Observations popup wiring (FMN-133)', () => {
  test('Tile is visible by default; toggle hides and re-shows it (FMN-145)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    const tile = page.locator('.tool-card[data-tool="tenant-observations"]');
    await expect(tile).toBeAttached();
    await expect(tile).toBeVisible();

    await page.locator('#settings-toggle').click();
    const toggle = page.locator('#tenant-observations-toggle');
    await expect(toggle).toBeAttached();
    await expect(toggle).toBeChecked();

    await toggle.uncheck();
    await page.locator('#settings-back').click();
    await expect(tile).toBeHidden();

    await page.locator('#settings-toggle').click();
    await toggle.check();
    await page.locator('#settings-back').click();
    await expect(tile).toBeVisible();

    await page.close();
  });

  test('Tile name + description match the registered copy', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    const tile = page.locator('.tool-card[data-tool="tenant-observations"]');
    await expect(tile.locator('.tool-name')).toContainText('Tenant Observations');
    await expect(tile.locator('.tool-desc')).toHaveAttribute('data-default-desc', /five analyzer dimensions/);
    await expect(tile.locator('.tool-desc')).toHaveAttribute('data-default-desc', /combined report or per-tab CSVs/);
    // No "crawl" verbiage anywhere on the tile.
    const desc = await tile.locator('.tool-desc').getAttribute('data-default-desc') ?? '';
    expect(desc.toLowerCase()).not.toContain('crawl');
    await page.close();
  });

  test('Settings toggle copy is scoped to Tenant Observations only', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();
    const toggleSpan = page.locator('label.toggle-row:has(#tenant-observations-toggle) span');
    await expect(toggleSpan).toBeAttached();
    expect((await toggleSpan.textContent())?.trim()).toBe('Show Tenant Observations');
    await page.close();
  });

  test('Tenant Observations tool app loads on the Configure step with deep-mode + max-servers controls', async ({ extensionContext, extensionId }) => {
    await seedApiKey(extensionContext, 'fake-key-for-test');

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    // FMN-145: tile is visible by default now; no toggle dance needed.
    const tile = page.locator('.tool-card[data-tool="tenant-observations"]');
    await expect(tile).toBeVisible();

    // Tool cards open the app via chrome.tabs.create. Capture the new tab.
    const [appPage] = await Promise.all([
      extensionContext.waitForEvent('page'),
      tile.click()
    ]);

    await appPage.waitForLoadState('domcontentloaded');
    await expect(appPage).toHaveURL(/\/src\/ui\/tenant-observations\/app\.html(#\/start)?$/);
    // Configure copy + deep-mode toggle + max-servers input all present.
    await expect(appPage.getByRole('heading', { name: /FortiMonitor Tenant Observations/i })).toBeVisible();
    await expect(appPage.locator('input[type="checkbox"]').first()).toBeVisible();
    await expect(appPage.locator('input[type="number"]')).toBeAttached();
    await expect(appPage.getByRole('button', { name: /Run assessment/ })).toBeVisible();
    // FMN-135 follow-up (2026-05-01): the "Include FortiMonitor UI data"
    // toggle was removed - that fetch is always-on now. Confirm the
    // checkbox is no longer present.
    await expect(appPage.getByText(/Include FortiMonitor UI data/)).toHaveCount(0);

    await appPage.close();
    await page.close();
  });

  test('Configure step shows the section-selector pill row with [All] selected by default (FMN-146)', async ({ extensionContext, extensionId }) => {
    const appPage = await extensionContext.newPage();
    await appPage.goto(`chrome-extension://${extensionId}/src/ui/tenant-observations/app.html#/start`);

    const pillRow = appPage.locator('[data-test="tenant-observations-section-pills"]');
    await expect(pillRow).toBeVisible();

    // All six pills present, in order.
    const expected = [
      ['all', 'All'],
      ['incidents', 'Incidents'],
      ['user-activity', 'User Activity'],
      ['instance-analysis', 'Instances'],
      ['template-recommendations', 'Templates'],
      ['monitoring-policy', 'Monitoring Policy']
    ];
    for (const [id, label] of expected) {
      const pill = appPage.locator(`[data-test="tenant-observations-section-pill-${id}"]`);
      await expect(pill).toBeVisible();
      await expect(pill).toHaveText(label);
    }

    // Default: [All] is the only active pill.
    await expect(appPage.locator('[data-test="tenant-observations-section-pill-all"]')).toHaveAttribute('aria-pressed', 'true');
    for (const [id] of expected.slice(1)) {
      await expect(appPage.locator(`[data-test="tenant-observations-section-pill-${id}"]`)).toHaveAttribute('aria-pressed', 'false');
    }

    await appPage.close();
  });

  test('Clicking an analyzer pill selects only that section; clicking [All] resets (FMN-146)', async ({ extensionContext, extensionId }) => {
    const appPage = await extensionContext.newPage();
    await appPage.goto(`chrome-extension://${extensionId}/src/ui/tenant-observations/app.html#/start`);

    const allPill = appPage.locator('[data-test="tenant-observations-section-pill-all"]');
    const templatesPill = appPage.locator('[data-test="tenant-observations-section-pill-template-recommendations"]');
    const policyPill = appPage.locator('[data-test="tenant-observations-section-pill-monitoring-policy"]');

    await templatesPill.click();
    await expect(allPill).toHaveAttribute('aria-pressed', 'false');
    await expect(templatesPill).toHaveAttribute('aria-pressed', 'true');
    await expect(policyPill).toHaveAttribute('aria-pressed', 'false');

    // Shift-click adds Monitoring Policy.
    await policyPill.click({ modifiers: ['Shift'] });
    await expect(templatesPill).toHaveAttribute('aria-pressed', 'true');
    await expect(policyPill).toHaveAttribute('aria-pressed', 'true');

    // Shift-click on Templates removes it.
    await templatesPill.click({ modifiers: ['Shift'] });
    await expect(templatesPill).toHaveAttribute('aria-pressed', 'false');
    await expect(policyPill).toHaveAttribute('aria-pressed', 'true');

    // Shift-click on Monitoring Policy is a no-op (would empty selection).
    await policyPill.click({ modifiers: ['Shift'] });
    await expect(policyPill).toHaveAttribute('aria-pressed', 'true');

    // Clicking [All] resets.
    await allPill.click();
    await expect(allPill).toHaveAttribute('aria-pressed', 'true');
    await expect(policyPill).toHaveAttribute('aria-pressed', 'false');

    await appPage.close();
  });
});
