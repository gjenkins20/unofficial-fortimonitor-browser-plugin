// Unofficial FortiMonitor Toolkit - Server Lookup live E2E (FMN-119).
// Skip-by-default. Drives the tool against the operator's real tenant
// using three distinctly-different instances from the tenant pool
// (discover-tenant.js); name + id round-trip per instance.

import { test, expect } from './fixtures.js';
import { seedApiKey } from './seed-api-key.js';
import { discoverDiverseServers, extractServerId, summarizePick } from './discover-tenant.js';

const API_KEY = process.env.FORTIMONITOR_API_KEY;

test.describe('live - Server Lookup E2E - real tenant', () => {
  test.skip(!API_KEY,
    'FORTIMONITOR_API_KEY not set. Add it to tests/e2e/.env.local. See docs/playwright-e2e-runbook.md.'
  );

  let testInstances = [];

  test.beforeAll(async ({ extensionContext }) => {
    await seedApiKey(extensionContext, API_KEY);
    const picks = await discoverDiverseServers(API_KEY, { count: 3 });
    testInstances = picks.map((s) => ({
      id: extractServerId(s),
      name: s.name
    })).filter((x) => x.id != null && x.name);
    if (testInstances.length === 0) {
      throw new Error('Tenant has no usable id+name pair; cannot run live Server Lookup suite.');
    }
    console.log('[live discovery] server-lookup picks:', picks.map(summarizePick));
  });

  test('live - Lookup by name resolves the correct id for each diverse instance', async ({ extensionContext, serverLookupUrl }) => {
    const page = await extensionContext.newPage();
    try {
      await page.goto(serverLookupUrl);
      await expect(page.locator('.step-header h2')).toContainText('Look up server IDs in bulk');
      // Paste all 3 names in one go; tool batches them.
      await page.locator('textarea.paste-area').fill(testInstances.map((i) => i.name).join('\n'));
      await page.getByRole('button', { name: 'Run lookup' }).click();
      await expect(page).toHaveURL(/#\/results$/, { timeout: 60_000 });
      await page.waitForSelector('.body-section table tbody tr', { state: 'attached', timeout: 30_000 });
      const rows = await page.locator('.body-section table tbody tr').all();
      // Columns (FMN-115 added a row-select checkbox as col 0):
      //   0=checkbox / 1=# / 2=Input / 3=Source / 4=Status / 5=Server ID / 6=Candidates
      const byInput = new Map();
      for (const r of rows) {
        const cells = await r.locator('td').allTextContents();
        byInput.set(cells[2].trim(), cells.map((c) => c.trim()));
      }
      for (const inst of testInstances) {
        const row = byInput.get(inst.name);
        expect(row, `Expected a result row for "${inst.name}"`).toBeTruthy();
        expect(row[4]).toContain('found');
        expect(row[5]).toBe(String(inst.id));
      }
    } finally {
      await page.close();
    }
  });

  test('live - Lookup by numeric id verifies each diverse instance id exists', async ({ extensionContext, serverLookupUrl }) => {
    const page = await extensionContext.newPage();
    try {
      await page.goto(serverLookupUrl);
      await page.locator('textarea.paste-area').fill(testInstances.map((i) => String(i.id)).join('\n'));
      await page.getByRole('button', { name: 'Run lookup' }).click();
      await expect(page).toHaveURL(/#\/results$/, { timeout: 60_000 });
      await page.waitForSelector('.body-section table tbody tr', { state: 'attached', timeout: 30_000 });
      const rows = await page.locator('.body-section table tbody tr').all();
      const byInput = new Map();
      for (const r of rows) {
        const cells = await r.locator('td').allTextContents();
        byInput.set(cells[2].trim(), cells.map((c) => c.trim()));
      }
      for (const inst of testInstances) {
        const row = byInput.get(String(inst.id));
        expect(row, `Expected a result row for id ${inst.id}`).toBeTruthy();
        expect(row[4]).toContain('found');
        expect(row[5]).toBe(String(inst.id));
      }
    } finally {
      await page.close();
    }
  });
});
