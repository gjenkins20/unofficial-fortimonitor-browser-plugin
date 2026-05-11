// Unofficial FortiMonitor Toolkit - Manage Templates (Bulk) live E2E (FMN-119).
// Skip-by-default. Stops at the Preview step (non-destructive). Verifies
// the plan resolves a real template + three distinctly-different servers
// from the tenant.

import { test, expect } from './fixtures.js';
import { seedApiKey } from './seed-api-key.js';
import { discoverDiverseServers, summarizePick } from './discover-tenant.js';

const PANOPTA_BASE = 'https://api2.panopta.com/v2';
const API_KEY = process.env.FORTIMONITOR_API_KEY;

test.describe('live - Manage Templates (Bulk) E2E - real tenant', () => {
  test.skip(!API_KEY,
    'FORTIMONITOR_API_KEY not set. Add it to tests/e2e/.env.local. See docs/playwright-e2e-runbook.md.'
  );

  let templateUrl = null;
  let templateName = null;
  let serverNames = [];

  test.beforeAll(async ({ extensionContext }) => {
    await seedApiKey(extensionContext, API_KEY);
    const headers = { 'Authorization': `ApiKey ${API_KEY}` };
    const tr = await fetch(`${PANOPTA_BASE}/server_template?limit=10`, { headers });
    if (!tr.ok) throw new Error(`Tenant /server_template probe failed: ${tr.status}`);
    const tb = await tr.json();
    const tlist = Array.isArray(tb?.server_template_list) ? tb.server_template_list : [];
    if (tlist.length === 0) throw new Error('Tenant has no templates; cannot run live Manage Templates suite.');
    templateUrl = tlist[0].url;
    templateName = tlist[0].name;

    const picks = await discoverDiverseServers(API_KEY, { count: 3 });
    serverNames = picks.map((s) => s.name).filter(Boolean);
    if (serverNames.length === 0) {
      throw new Error('Tenant has no named servers; cannot run live Manage Templates suite.');
    }
    console.log('[live discovery] manage-templates picks:', picks.map(summarizePick));
    console.log('[live discovery] manage-templates template:', JSON.stringify({ name: templateName }));
  });

  test('live - Preview against three diverse servers + a real template resolves cleanly', async ({ extensionContext, manageTemplatesUrl }) => {
    const page = await extensionContext.newPage();
    try {
      await page.goto(manageTemplatesUrl);
      await expect(page.locator('.step-header h2')).toContainText('Attach or detach a monitoring template');

      const tplSelect = page.locator('select.select').first();
      await page.waitForFunction(() => {
        const sel = document.querySelector('select.select');
        return sel && sel.options.length > 1;
      }, undefined, { timeout: 30_000 });
      await tplSelect.selectOption(templateUrl);

      await page.locator('textarea.paste-area').fill(serverNames.join('\n'));
      await page.getByRole('button', { name: /Continue → Preview/ }).click();
      await expect(page).toHaveURL(/#\/preview$/, { timeout: 60_000 });

      const expectedTargets = serverNames.length;
      const summary = page.locator('.summary-bar');
      const targetText = expectedTargets === 1 ? '1 target' : `${expectedTargets} targets`;
      await expect(summary).toContainText(targetText, { timeout: 60_000 });

      // Walking back leaves the tenant unchanged (no execute fired).
      await page.getByRole('button', { name: '← Back' }).click();
      await expect(page).toHaveURL(/#\/start$/, { timeout: 5_000 });
    } finally {
      await page.close();
    }
  });
});
