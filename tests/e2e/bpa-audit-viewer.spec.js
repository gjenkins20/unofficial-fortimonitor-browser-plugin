// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// BPA Audit viewer harness verification (FMN-133).
//
// Loads docs/harnesses/bpa-audit-viewer.html (a static fixture that
// imports viewer.js + bpa-analyzers and renders against a synthetic
// inventory). Asserts the 11-tab strip is wired, every tab renders
// without throwing, and CSV download buttons fire.
//
// Note: this exercises the viewer module against a fixture, not a real
// audit run. Operator QA validates against a live tenant.

import { test, expect } from './fixtures.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.resolve(__dirname, '../../docs/harnesses/bpa-audit-viewer.html');
const HARNESS_URL = `file://${HARNESS_PATH}`;

const EXPECTED_TAB_IDS = [
  'executive-summary', 'feature-utilization', 'incident-summary', 'incidents',
  'user-activity', 'instance-analysis', 'template-recommendations',
  'monitoring-policy', 'recommendations', 'recommended-labs', 'raw-counts'
];

test.describe('BPA Audit viewer harness (FMN-133)', () => {
  test('renders all 11 tabs with no console errors', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto(HARNESS_URL);
    await page.waitForLoadState('domcontentloaded');

    for (const id of EXPECTED_TAB_IDS) {
      await expect(page.locator(`button[data-tab="${id}"]`)).toBeVisible();
    }
    expect(consoleErrors).toEqual([]);
    await page.close();
  });

  test('clicking each tab renders its sections without throwing', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(HARNESS_URL);
    for (const id of EXPECTED_TAB_IDS) {
      await page.locator(`button[data-tab="${id}"]`).click();
      // Tab pane should have at least one h2 (the tab title) and either a table or "No rows" muted text.
      await expect(page.locator('[data-test="tab-pane"] h2')).toBeVisible();
    }
    expect(errors).toEqual([]);
    await page.close();
  });

  test('User Activity tab has no manual-entry inputs (FMN-143 / FMN-148 regression guard)', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);

    await page.locator('button[data-tab="user-activity"]').click();
    // FMN-143 dropped the Last Login manual <input>; FMN-148 removed
    // the entire annotation infrastructure. Guard against any future
    // re-introduction of editable cells inside the data tables (the
    // tab's filter <input type="search"> lives outside .review-table).
    const inputs = page.locator('[data-test="tab-pane"] table.review-table input');
    expect(await inputs.count()).toBe(0);
    await page.close();
  });

  test('Download CSV button on Recommendations tab triggers a CSV download', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);
    await page.locator('button[data-tab="recommendations"]').click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^acme-corp-harness_recommendations_\d{8}\.csv$/);
    await page.close();
  });

  test('User Activity tab: Last Login renders value when populated, N/A when missing (FMN-143)', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);
    await page.locator('button[data-tab="user-activity"]').click();

    await expect(page.locator('[data-test="tab-pane"] th', { hasText: 'Created On (UI)' })).toBeVisible();

    const table = page.locator('[data-test="tab-pane"] table.review-table').first();
    const aliceRow = table.locator('tr', { hasText: 'a@acme.com' });

    // Column order: 1=Name, 2=Email, 3=Created(API), 4=Created On(UI),
    // 5=Contact Methods, 6=Last Login, 7=Active Assessment. Last Login
    // is now read-only (FMN-143).
    const aliceLastLoginCell = aliceRow.locator('td:nth-child(6)');
    await expect(aliceLastLoginCell).toContainText('2026-04-30 12:34:56 UTC');
    const aliceCreatedOnCell = aliceRow.locator('td:nth-child(4)');
    await expect(aliceCreatedOnCell).toContainText('Jan 1, 2024');

    // alice2 has no frontend datum: cell renders 'N/A', no input.
    const alice2Row = table.locator('tr', { hasText: 'alice2@acme.com' });
    const alice2LastLoginCell = alice2Row.locator('td:nth-child(6)');
    await expect(alice2LastLoginCell).toHaveText('N/A');
    expect(await alice2LastLoginCell.locator('input').count()).toBe(0);

    await page.close();
  });

  test('User Activity tab: Active Assessment legend section renders all five buckets (FMN-143)', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);
    await page.locator('button[data-tab="user-activity"]').click();

    const legendHeading = page.locator('[data-test="tab-pane"] h3', { hasText: 'Active Assessment Legend' });
    await expect(legendHeading).toBeVisible();

    const tabPane = page.locator('[data-test="tab-pane"]');
    for (const status of ['Active', 'Stale', 'Inactive', 'Never', 'Unknown']) {
      await expect(tabPane.locator('td', { hasText: new RegExp(`^${status}$`) }).first()).toBeVisible();
    }
    await page.close();
  });

  test('Heartbeat ticks (no infinite render loop)', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);
    const hb = page.locator('#heartbeat');
    const initial = (await hb.textContent()) ?? '';
    await page.waitForTimeout(2200);
    const later = (await hb.textContent()) ?? '';
    expect(later).not.toBe(initial);
    await page.close();
  });

  test('Combined-report ZIP button downloads a .zip with the customer-prefixed filename', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-test="download-combined-report"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^acme-corp-harness_best-practice-assessment_\d{8}\.zip$/);
    await page.close();
  });

  test('Combined PDF button mounts an iframe and invokes print() with all 11 tabs in the document (FMN-136)', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(HARNESS_URL);
    await page.locator('[data-test="download-combined-pdf"]').click();
    // Wait for the harness to record the print invocation.
    await page.waitForFunction(() => (window.__pdfPrintCalls?.length ?? 0) > 0, null, { timeout: 5000 });

    const calls = await page.evaluate(() => window.__pdfPrintCalls);
    expect(calls.length).toBe(1);
    const html = calls[0].html;
    // Every tab id should appear as a section anchor.
    for (const id of EXPECTED_TAB_IDS) {
      expect(html).toContain(`id="tab-${id}"`);
    }
    // Customer name flows through to the printable header.
    expect(html).toContain('Acme Corp (harness)');
    // Default mode: no cover or TOC.
    expect(html).not.toContain('class="cover"');
    expect(html).not.toContain('class="toc"');
    expect(errors).toEqual([]);
    await page.close();
  });

  test('Cover/TOC checkbox: when on, PDF document includes cover + TOC anchor links (FMN-136)', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);
    await page.locator('[data-test="pdf-cover-toggle"]').check();
    await page.locator('[data-test="download-combined-pdf"]').click();
    await page.waitForFunction(() => (window.__pdfPrintCalls?.length ?? 0) > 0, null, { timeout: 5000 });

    const calls = await page.evaluate(() => window.__pdfPrintCalls);
    const html = calls[0].html;
    expect(html).toContain('class="cover"');
    expect(html).toContain('class="toc"');
    for (const id of EXPECTED_TAB_IDS) {
      expect(html).toContain(`href="#tab-${id}"`);
    }
    await page.close();
  });

  test('User Activity tab: tables wrap in horizontal-scroll container that activates when content exceeds pane (FMN-145)', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);
    await page.locator('button[data-tab="user-activity"]').click();

    // Each table is now wrapped in .review-table-wrap so wide content
    // becomes horizontally scrollable instead of clipping at the
    // .mockup-frame edge in production.
    const wraps = page.locator('[data-test="tab-pane"] .review-table-wrap');
    expect(await wraps.count()).toBeGreaterThan(0);

    // Each wrap has overflow-x: auto so a narrow viewport produces a
    // scrollable area (scrollWidth > clientWidth).
    await page.evaluate(() => { document.getElementById('harness-host').style.maxWidth = '400px'; });
    const overflows = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[data-test="tab-pane"] .review-table-wrap'));
      return els.map((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowX: getComputedStyle(el).overflowX
      }));
    });
    expect(overflows.length).toBeGreaterThan(0);
    expect(overflows.every((o) => o.overflowX === 'auto' || o.overflowX === 'scroll')).toBe(true);
    // At least one wrap (the Users table) should be wider than the
    // narrowed container, confirming scroll is engaged rather than
    // clipped.
    expect(overflows.some((o) => o.scrollWidth > o.clientWidth)).toBe(true);
    await page.close();
  });

  test('Filter input restricts visible rows in the active tab', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);
    // Recommendations always has multiple rows for the harness fixture.
    await page.locator('button[data-tab="recommendations"]').click();
    const beforeRows = await page.locator('[data-test="tab-pane"] tbody tr').count();
    expect(beforeRows).toBeGreaterThan(1);

    await page.locator('[data-test="tab-pane"] input[type="search"]').fill('SNMP');
    const afterRows = await page.locator('[data-test="tab-pane"] tbody tr').count();
    expect(afterRows).toBeGreaterThan(0);
    expect(afterRows).toBeLessThan(beforeRows);
    await page.close();
  });
});
