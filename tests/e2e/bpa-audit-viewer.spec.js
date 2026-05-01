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

  test('User Activity tab exposes annotation inputs that persist values into the store', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(HARNESS_URL);

    await page.locator('button[data-tab="user-activity"]').click();
    const inputs = page.locator('[data-test="tab-pane"] input.annotation-input');
    await expect(inputs.first()).toBeAttached();
    await inputs.first().fill('2026-04-15');
    await expect(inputs.first()).toHaveValue('2026-04-15');

    // Switch tabs + back. The harness rebuilds the section on tab change,
    // so input values come from the store, not the DOM. Round-trip.
    await page.locator('button[data-tab="raw-counts"]').click();
    await page.locator('button[data-tab="user-activity"]').click();
    await expect(page.locator('[data-test="tab-pane"] input.annotation-input').first())
      .toHaveValue('2026-04-15');
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
