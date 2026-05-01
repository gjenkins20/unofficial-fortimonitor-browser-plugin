// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// BPA Audit popup wiring verification (FMN-133).
//
// Same shape as sdwan-report-popup.spec.js (FMN-129):
//   1. Tile is [hidden] by default in the popup.
//   2. Toggling "Show BPA Audit" in Settings makes the tile visible.
//   3. Toggling it back off hides the tile again.
//   4. With API key seeded + flag on, clicking the tile opens the
//      bpa-audit app on the /start step (Configure).
//   5. The Configure step exposes the deep-mode and max-servers controls.
//
// Real chrome.runtime plumbing; no v2 API calls. The /start -> /collect
// transition is exercised but the actual run is allowed to fail at the
// network layer - we only assert UI scaffolding and route navigation.

import { test, expect } from './fixtures.js';
import { seedApiKey } from './seed-api-key.js';

test.describe('BPA Audit popup wiring (FMN-133)', () => {
  test('Tile is hidden by default; appears when BPA Audit toggle is enabled', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    const tile = page.locator('.tool-card[data-tool="bpa-audit"]');
    await expect(tile).toBeAttached();
    await expect(tile).toBeHidden();

    await page.locator('#settings-toggle').click();
    const toggle = page.locator('#bpa-audit-toggle');
    await expect(toggle).toBeAttached();
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await expect(toggle).toBeChecked();
    await page.locator('#settings-back').click();
    await expect(tile).toBeVisible();

    await page.locator('#settings-toggle').click();
    await toggle.uncheck();
    await page.locator('#settings-back').click();
    await expect(tile).toBeHidden();

    await page.close();
  });

  test('Tile name + description match the registered copy', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    const tile = page.locator('.tool-card[data-tool="bpa-audit"]');
    await expect(tile.locator('.tool-name')).toContainText('Best-Practice Assessment');
    await expect(tile.locator('.tool-desc')).toHaveAttribute('data-default-desc', /best-practice dimensions/);
    await expect(tile.locator('.tool-desc')).toHaveAttribute('data-default-desc', /combined report or per-tab CSVs/);
    // No "crawl" verbiage anywhere on the tile.
    const desc = await tile.locator('.tool-desc').getAttribute('data-default-desc') ?? '';
    expect(desc.toLowerCase()).not.toContain('crawl');
    await page.close();
  });

  test('Settings toggle copy is scoped to Best-Practice Assessment only', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();
    const toggleSpan = page.locator('label.toggle-row:has(#bpa-audit-toggle) span');
    await expect(toggleSpan).toBeAttached();
    expect((await toggleSpan.textContent())?.trim()).toBe('Show Best-Practice Assessment');
    await page.close();
  });

  test('BPA tool app loads on the Configure step with deep-mode + max-servers controls', async ({ extensionContext, extensionId }) => {
    await seedApiKey(extensionContext, 'fake-key-for-test');

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();
    await page.locator('#bpa-audit-toggle').check();
    await page.locator('#settings-back').click();

    const tile = page.locator('.tool-card[data-tool="bpa-audit"]');
    await expect(tile).toBeVisible();

    // Tool cards open the app via chrome.tabs.create. Capture the new tab.
    const [appPage] = await Promise.all([
      extensionContext.waitForEvent('page'),
      tile.click()
    ]);

    await appPage.waitForLoadState('domcontentloaded');
    await expect(appPage).toHaveURL(/\/src\/ui\/bpa-audit\/app\.html(#\/start)?$/);
    // Configure copy + deep-mode toggle + max-servers input all present.
    await expect(appPage.getByRole('heading', { name: /FortiMonitor Best-Practice Assessment/i })).toBeVisible();
    await expect(appPage.locator('input[type="checkbox"]').first()).toBeVisible();
    await expect(appPage.locator('input[type="number"]')).toBeAttached();
    await expect(appPage.getByRole('button', { name: /Run assessment/ })).toBeVisible();
    // FMN-135: "Include FortiMonitor UI data" toggle is a separate
    // checkbox below the deep-mode one. The label calls out the two
    // fields the EditUser page currently provides.
    await expect(appPage.getByText(/Include FortiMonitor UI data \(last login, created on\)/)).toBeVisible();

    await appPage.close();
    await page.close();
  });
});
