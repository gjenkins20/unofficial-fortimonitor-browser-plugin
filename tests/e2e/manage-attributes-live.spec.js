// Unofficial FortiMonitor Toolkit - Manage Attributes (Bulk) live E2E (FMN-119).
// Skip-by-default. Stops at the Preview step (non-destructive). Verifies
// the plan resolves real attribute types + real server names from the
// tenant. Does not call /attr:execute-batch.

import { test, expect } from './fixtures.js';
import { seedApiKey } from './seed-api-key.js';

const PANOPTA_BASE = 'https://api2.panopta.com/v2';
const API_KEY = process.env.FORTIMONITOR_API_KEY;

test.describe('live - Manage Attributes (Bulk) E2E - real tenant', () => {
  test.skip(!API_KEY,
    'FORTIMONITOR_API_KEY not set. Add it to tests/e2e/.env.local. See docs/playwright-e2e-runbook.md.'
  );

  let serverName = null;
  let attributeTypeName = null;

  test.beforeAll(async ({ extensionContext }) => {
    await seedApiKey(extensionContext, API_KEY);
    const headers = { 'Authorization': `ApiKey ${API_KEY}` };
    // Find a server name we can address.
    const sr = await fetch(`${PANOPTA_BASE}/server?limit=10`, { headers });
    if (!sr.ok) throw new Error(`tenant /server probe failed: ${sr.status}`);
    const sb = await sr.json();
    const slist = Array.isArray(sb?.server_list) ? sb.server_list : [];
    const named = slist.find((s) => typeof s?.name === 'string' && s.name.length > 0);
    if (!named) throw new Error('Tenant has no named servers; cannot run live Manage Attributes suite.');
    serverName = named.name;

    // Find an attribute type (custom catalog only; built-in `dem.model`
    // / `server.os` aren't in /server_attribute_type).
    const tr = await fetch(`${PANOPTA_BASE}/server_attribute_type?limit=10`, { headers });
    if (tr.ok) {
      const tb = await tr.json();
      const list = Array.isArray(tb?.server_attribute_type_list) ? tb.server_attribute_type_list : [];
      attributeTypeName = list[0]?.name ?? null;
    }
  });

  test('live - Preview resolves real server name and shows a plan row', async ({ extensionContext, manageAttributesUrl }) => {
    test.skip(!attributeTypeName, 'Tenant has no custom attribute types; skipping.');
    const page = await extensionContext.newPage();
    await page.goto(manageAttributesUrl);
    await expect(page.locator('.step-header h2')).toContainText('Set or remove one or more attributes');

    // Pick the first attribute type from the live list.
    const combo = page.locator('.combobox-input').first();
    await expect(combo).toBeEnabled({ timeout: 30_000 });
    await combo.fill(attributeTypeName);
    await page.getByRole('option', { name: new RegExp(attributeTypeName, 'i') }).first().click();
    await page.locator('.attribute-row input.select[type="text"]').first().fill('e2e-test-do-not-execute');
    await page.locator('textarea.paste-area').fill(serverName);

    await page.getByRole('button', { name: /Continue → Preview/ }).click();
    await expect(page).toHaveURL(/#\/preview$/, { timeout: 60_000 });
    // Plan should produce exactly one row resolving our single server name.
    await expect(page.locator('.summary-bar')).toContainText('1 plan row', { timeout: 60_000 });
    // Walking back to /start without executing leaves the tenant unchanged.
    await page.getByRole('button', { name: '← Back' }).click();
    await expect(page).toHaveURL(/#\/start$/, { timeout: 5_000 });
    await page.close();
  });
});
