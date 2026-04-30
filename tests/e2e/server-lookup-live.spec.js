// Unofficial FortiMonitor Toolkit - Server Lookup live E2E (FMN-119).
// Skip-by-default. Drives the tool against the operator's real tenant
// using a small handful of known-good identifiers discovered from
// /v2/server.

import { test, expect } from './fixtures.js';
import { seedApiKey } from './seed-api-key.js';

const PANOPTA_BASE = 'https://api2.panopta.com/v2';
const API_KEY = process.env.FORTIMONITOR_API_KEY;

test.describe('live - Server Lookup E2E - real tenant', () => {
  test.skip(!API_KEY,
    'FORTIMONITOR_API_KEY not set. Add it to tests/e2e/.env.local. See docs/playwright-e2e-runbook.md.'
  );

  let sampleServer = null;

  test.beforeAll(async ({ extensionContext }) => {
    await seedApiKey(extensionContext, API_KEY);
    const r = await fetch(`${PANOPTA_BASE}/server?limit=10`, {
      headers: { 'Authorization': `ApiKey ${API_KEY}` }
    });
    if (!r.ok) throw new Error(`Tenant discovery failed: ${r.status}`);
    const body = await r.json();
    const list = Array.isArray(body?.server_list) ? body.server_list : [];
    function extractId(s) {
      if (s?.id != null) return Number(s.id);
      if (typeof s?.url === 'string') {
        const m = s.url.match(/\/server\/(\d+)\/?$/);
        if (m) return Number(m[1]);
      }
      return null;
    }
    let found = null;
    for (const s of list) {
      const id = extractId(s);
      if (id != null && typeof s?.name === 'string' && s.name.length > 0) { found = { id, name: s.name }; break; }
    }
    if (!found) throw new Error('Tenant has no usable id+name pair; cannot run live Server Lookup suite.');
    sampleServer = found;
  });

  test('live - Lookup by name returns the matching server id', async ({ extensionContext, serverLookupUrl }) => {
    const page = await extensionContext.newPage();
    await page.goto(serverLookupUrl);
    await expect(page.locator('.step-header h2')).toContainText('Look up server IDs in bulk');
    await page.locator('textarea.paste-area').fill(sampleServer.name);
    await page.getByRole('button', { name: 'Run lookup' }).click();
    await expect(page).toHaveURL(/#\/results$/, { timeout: 60_000 });
    await page.waitForSelector('.body-section table tbody tr', { state: 'attached', timeout: 30_000 });
    const cells = await page.locator('.body-section table tbody tr').first().locator('td').allTextContents();
    // Columns: # / Input / Source / Status / Server ID / Candidates
    expect(cells[1].trim()).toBe(sampleServer.name);
    expect(cells[3]).toContain('found');
    expect(cells[4].trim()).toBe(String(sampleServer.id));
    await page.close();
  });

  test('live - Lookup by numeric id verifies the id exists', async ({ extensionContext, serverLookupUrl }) => {
    const page = await extensionContext.newPage();
    await page.goto(serverLookupUrl);
    await page.locator('textarea.paste-area').fill(String(sampleServer.id));
    await page.getByRole('button', { name: 'Run lookup' }).click();
    await expect(page).toHaveURL(/#\/results$/, { timeout: 60_000 });
    await page.waitForSelector('.body-section table tbody tr', { state: 'attached', timeout: 30_000 });
    const cells = await page.locator('.body-section table tbody tr').first().locator('td').allTextContents();
    expect(cells[3]).toContain('found');
    expect(cells[4].trim()).toBe(String(sampleServer.id));
    await page.close();
  });
});
