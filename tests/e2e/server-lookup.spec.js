// Unofficial FortiMonitor Toolkit - Server Lookup E2E (FMN-119).
// Drives the Server Lookup tool against canned tenant data injected via
// addInitScript. Pattern mirrors find-servers.spec.js.

import { test, expect } from './fixtures.js';
import { serverLookupStubScript } from './server-lookup-stubs.js';

async function openTool(extensionContext, url) {
  const page = await extensionContext.newPage();
  await page.addInitScript(serverLookupStubScript);
  await page.goto(url);
  await expect(page.locator('.step-header h2')).toContainText('Look up server IDs in bulk');
  return page;
}

async function runLookup(page, input) {
  await page.locator('textarea.paste-area').fill(input);
  await page.getByRole('button', { name: 'Run lookup' }).click();
  await expect(page).toHaveURL(/#\/results$/, { timeout: 10_000 });
  await page.waitForSelector('.body-section table tbody tr', { state: 'attached', timeout: 5_000 });
}

async function readRows(page) {
  const tbody = page.locator('.body-section table tbody');
  const rows = await tbody.locator('tr').all();
  const out = [];
  for (const r of rows) {
    const cells = await r.locator('td').allTextContents();
    out.push(cells.map((c) => c.trim()));
  }
  return out;
}

test.describe('Server Lookup E2E - stubbed tenant', () => {
  test('Mixed input (name + url + id) round-trips with correct status per kind', async ({ extensionContext, serverLookupUrl }) => {
    const page = await openTool(extensionContext, serverLookupUrl);
    try {
      await runLookup(page,
        'edge-win-01\nhttps://fortimonitor.forticloud.com/instance/1002/details\n9999\nedge-win\nnope-server'
      );
      const rows = await readRows(page);
      // Columns: # / Input / Source / Status / Server ID / Candidates
      const byInput = Object.fromEntries(rows.map((r) => [r[1], r]));
      expect(byInput['edge-win-01'][3]).toContain('found');
      expect(byInput['edge-win-01'][4]).toBe('1001');
      // URL input: stored row keys by raw URL.
      const urlRow = rows.find((r) => /\/instance\/1002\//.test(r[1]));
      expect(urlRow[3]).toContain('found');
      expect(urlRow[4]).toBe('1002');
      const idRow = rows.find((r) => r[1] === '9999');
      expect(idRow[3]).toContain('not_found');
      const ambiguous = byInput['edge-win'];
      expect(ambiguous[3]).toContain('ambiguous');
      expect(ambiguous[5]).toContain('1001');
      expect(ambiguous[5]).toContain('1002');
      const missing = byInput['nope-server'];
      expect(missing[3]).toContain('not_found');
    } finally {
      await page.close();
    }
  });
});
