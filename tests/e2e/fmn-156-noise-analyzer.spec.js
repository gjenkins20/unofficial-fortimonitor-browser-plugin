// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-156 Playwright spec - post-operator-QA rework.
//
// Operator QA on the v1 standalone Noise Analysis tab found it
// duplicative with the existing Incident Summary tab's Noisy Metrics
// section. The rework folds the analyzer's content into Incident
// Summary as new sections (Noise Summary, Top Noisy Instances, Top
// Noisy Metrics per outage description) and removes the standalone
// tab + per-tool flag entirely. The analyzer runs as an ancillary
// analyzer to 'incidents' (see SECTION_ANCILLARY_ANALYZER_KEYS).
//
// This spec asserts the new structure: noise sections live inside
// the Incident Summary tab pane, render real fixture rows, and carry
// non-empty recommendations.

import { test, expect } from './fixtures.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.resolve(__dirname, '../../docs/harnesses/bpa-audit-viewer.html');
const HARNESS_URL = `file://${HARNESS_PATH}`;

test.describe('FMN-156 Noise sections inside Incident Summary tab', () => {
  test('Incident Summary tab includes the Noise Summary + Top Noisy Instances + Top Noisy Metrics sections', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Harness default sections selection is ["all"] which now pulls noise
    // as ancillary alongside incidents - no flag needed anymore.
    await page.goto(HARNESS_URL);
    await page.waitForLoadState('domcontentloaded');

    // The standalone Noise Analysis tab should NOT exist anymore.
    await expect(page.locator('button[data-tab="noise-analysis"]')).toHaveCount(0);

    // Open Incident Summary tab and verify the noise sections are
    // present alongside the pre-existing sections.
    await page.locator('button[data-tab="incident-summary"]').click();
    const tabPane = page.locator('[data-test="tab-pane"]');

    await expect(tabPane.getByRole('heading', { name: 'Top by Instance', exact: true })).toBeVisible();
    await expect(tabPane.getByRole('heading', { name: 'Noisy Metrics', exact: true })).toBeVisible();
    await expect(tabPane.locator('h3', { hasText: 'Noise Summary' })).toBeVisible();
    await expect(tabPane.getByRole('heading', { name: 'Top Noisy Instances', exact: true })).toBeVisible();
    await expect(tabPane.locator('h3', { hasText: 'Top Noisy Metrics (per outage description)' })).toBeVisible();

    expect(errors).toEqual([]);
    await page.close();
  });

  test('Top Noisy Instances ranks the fixture instances correctly', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);
    await page.locator('button[data-tab="incident-summary"]').click();

    // Find the Top Noisy Instances section by its header and pick the
    // adjacent table. Indexing by .review-section position is brittle
    // because the section count grew with the rework.
    const noisySection = page.locator('.review-section').filter({ has: page.locator('h3', { hasText: 'Top Noisy Instances' }) });
    const instancesTable = noisySection.locator('table.review-table');
    await expect(instancesTable).toBeVisible();

    const rows = instancesTable.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);

    // Top row should be fgvm-prod-01 (4 outages in 30d in the fixture).
    await expect(rows.first()).toContainText('fgvm-prod-01');
  });

  test('every Top Noisy Instances row has a non-empty Recommendation', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);
    await page.locator('button[data-tab="incident-summary"]').click();

    const noisySection = page.locator('.review-section').filter({ has: page.locator('h3', { hasText: 'Top Noisy Instances' }) });
    const rows = noisySection.locator('table.review-table tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    for (let i = 0; i < rowCount; i++) {
      // Recommendation is the last column (ID, Server, Outages, Duration, MTTR, Flap, Rec).
      const recCell = rows.nth(i).locator('td').last();
      const text = (await recCell.textContent() || '').trim();
      expect(text.length).toBeGreaterThan(5);
      expect(text).not.toBe('-');
    }
  });

  test('instance Server cells in the Noise sections render as tenant-origin links', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);
    await page.locator('button[data-tab="incident-summary"]').click();

    const noisySection = page.locator('.review-section').filter({ has: page.locator('h3', { hasText: 'Top Noisy Instances' }) });
    const links = noisySection.locator('a[href*="/report/Instance/"]');
    expect(await links.count()).toBeGreaterThan(0);
    const href = await links.first().getAttribute('href');
    expect(href).toMatch(/^https:\/\/my\.us02\.fortimonitor\.com\/report\/Instance\/\d+\/details$/);
    expect(await links.first().getAttribute('target')).toBe('_blank');
  });

  test('PDF includes the Incident Summary tab and the new Noise sections inline', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);
    await page.locator('[data-test="download-combined-pdf"]').click();
    await page.waitForFunction(() => (window.__pdfPrintCalls?.length ?? 0) > 0, null, { timeout: 5000 });

    const calls = await page.evaluate(() => window.__pdfPrintCalls);
    const html = calls[0].html;
    // No standalone noise-analysis tab.
    expect(html).not.toContain('id="tab-noise-analysis"');
    // Incident Summary section IS present and carries Top Noisy Instances.
    expect(html).toContain('id="tab-incident-summary"');
    expect(html).toContain('Top Noisy Instances');
  });
});
