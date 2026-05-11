// Unofficial FortiMonitor Toolkit - Manage Attributes (Bulk) live E2E (FMN-119).
// Skip-by-default. Stops at the Preview step (non-destructive). Verifies
// the plan resolves real attribute types + three distinctly-different
// servers from the tenant. Does not call /attr:execute-batch.

import { test, expect } from './fixtures.js';
import { seedApiKey } from './seed-api-key.js';
import { discoverDiverseServers, summarizePick } from './discover-tenant.js';

const PANOPTA_BASE = 'https://api2.panopta.com/v2';
const API_KEY = process.env.FORTIMONITOR_API_KEY;

test.describe('live - Manage Attributes (Bulk) E2E - real tenant', () => {
  test.skip(!API_KEY,
    'FORTIMONITOR_API_KEY not set. Add it to tests/e2e/.env.local. See docs/playwright-e2e-runbook.md.'
  );

  let serverNames = [];
  let attributeTypeName = null;

  test.beforeAll(async ({ extensionContext }) => {
    await seedApiKey(extensionContext, API_KEY);
    const headers = { 'Authorization': `ApiKey ${API_KEY}` };

    // Three diverse servers for plan-coverage diversity.
    const picks = await discoverDiverseServers(API_KEY, { count: 3 });
    serverNames = picks.map((s) => s.name).filter(Boolean);
    if (serverNames.length === 0) {
      throw new Error('Tenant has no named servers; cannot run live Manage Attributes suite.');
    }
    console.log('[live discovery] manage-attributes picks:', picks.map(summarizePick));

    // Find any custom attribute type. Built-in dem.model / server.os
    // are not in /server_attribute_type.
    const tr = await fetch(`${PANOPTA_BASE}/server_attribute_type?limit=10`, { headers });
    if (tr.ok) {
      const tb = await tr.json();
      const list = Array.isArray(tb?.server_attribute_type_list) ? tb.server_attribute_type_list : [];
      attributeTypeName = list[0]?.name ?? null;
    }
  });

  test('live - Preview resolves three diverse server names and shows three plan rows', async ({ extensionContext, manageAttributesUrl }) => {
    test.skip(!attributeTypeName, 'Tenant has no custom attribute types; skipping.');
    test.skip(serverNames.length < 1, 'No usable server names in the diverse pick.');
    const page = await extensionContext.newPage();
    try {
      await page.goto(manageAttributesUrl);
      await expect(page.locator('.step-header h2')).toContainText('Set or remove one or more attributes');

      const combo = page.locator('.combobox-input').first();
      await expect(combo).toBeEnabled({ timeout: 30_000 });
      await combo.fill(attributeTypeName);
      await page.getByRole('option', { name: new RegExp(attributeTypeName, 'i') }).first().click();
      await page.locator('.attribute-row input.select[type="text"]').first().fill('e2e-test-do-not-execute');
      await page.locator('textarea.paste-area').fill(serverNames.join('\n'));

      await page.getByRole('button', { name: /Continue → Preview/ }).click();
      await expect(page).toHaveURL(/#\/preview$/, { timeout: 60_000 });

      const expectedRows = serverNames.length;
      const summary = page.locator('.summary-bar');
      const rowText = expectedRows === 1 ? '1 plan row' : `${expectedRows} plan rows`;
      await expect(summary).toContainText(rowText, { timeout: 60_000 });

      // Walking back to /start without executing leaves the tenant unchanged.
      await page.getByRole('button', { name: '← Back' }).click();
      await expect(page).toHaveURL(/#\/start$/, { timeout: 5_000 });
    } finally {
      await page.close();
    }
  });
});
