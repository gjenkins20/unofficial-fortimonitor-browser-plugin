// Unofficial FortiMonitor Toolkit - Send selection to handoff live E2E (FMN-115).
//
// Skip-by-default. Drives the cross-tool handoff against the operator's
// real FortiMonitor tenant: load Find Servers, run a real search by a
// real server id, click "Send to → Manage Attributes", assert the
// receiver tab opens with the id prefilled.
//
// Single round trip; no destructive write. Live coverage focuses on
// confirming the handoff plumbing survives the real chrome.tabs.create
// boundary (cross-page chrome.storage.session) outside the controlled
// stub environment.

import { test, expect } from './fixtures.js';
import { seedApiKey } from './seed-api-key.js';

const PANOPTA_BASE = 'https://api2.panopta.com/v2';
const API_KEY = process.env.FORTIMONITOR_API_KEY;

test.describe('live - Send selection to handoff (FMN-115) - real tenant', () => {
  test.skip(!API_KEY,
    'FORTIMONITOR_API_KEY not set. Add it to tests/e2e/.env.local or export it. See docs/playwright-e2e-runbook.md.'
  );

  let sampleTag = null;

  test.beforeAll(async ({ extensionContext }) => {
    await seedApiKey(extensionContext, API_KEY);
    // Find a server that has a tag; we'll use the first tag value as
    // our search criterion. Same pattern as find-servers-live.spec.js's
    // tenant discovery, simplified to one field.
    const r = await fetch(`${PANOPTA_BASE}/server?limit=200`, {
      headers: { 'Authorization': `ApiKey ${API_KEY}` }
    });
    if (!r.ok) throw new Error(`Tenant discovery failed: ${r.status}`);
    const body = await r.json();
    const servers = Array.isArray(body?.server_list) ? body.server_list : [];
    const tagged = servers.find((s) => Array.isArray(s.tags) && s.tags.length > 0);
    if (!tagged) {
      throw new Error('Tenant has no tagged servers; cannot run live handoff suite via tag-based search.');
    }
    sampleTag = tagged.tags[0];
  });

  test('Find Servers (tag = X) → Manage Attributes: prefilled with matched ids', async ({ extensionContext, extensionId, findServersUrl }) => {
    // Wipe any pre-existing pending selection.
    const cleaner = await extensionContext.newPage();
    await cleaner.goto(`chrome-extension://${extensionId}/src/ui/server-search/app.html#/start`);
    await cleaner.evaluate(() => chrome.storage.session.remove('fm:pendingSelection'));
    await cleaner.close();

    const senderPage = await extensionContext.newPage();
    await senderPage.goto(findServersUrl);
    await expect(senderPage.locator('.step-header h2')).toContainText('Find servers');

    // Tag = sampleTag, exact match. Same wiring as find-servers-live.
    const row = senderPage.locator('.criterion-row').first();
    await row.locator('select').first().selectOption('tag');
    await row.locator('input[type="text"]').last().fill(sampleTag);
    await row.locator('input[type="checkbox"]').check();

    await senderPage.getByRole('button', { name: 'Run search' }).click();
    await expect(senderPage).toHaveURL(/#\/results$/, { timeout: 60_000 });
    await senderPage.waitForSelector('.body-section table tbody tr', { state: 'attached', timeout: 30_000 });

    // At least one match expected (we discovered the tag from a real
    // tagged server). Verify count badge is non-empty.
    const count = await senderPage.locator('.body-section table tbody tr').count();
    expect(count).toBeGreaterThan(0);
    await expect(senderPage.locator('.fmn-send-to-count')).toHaveText(` (${count})`);

    // Open the menu and pick Manage Attributes (no template choice;
    // simplest receiver to assert against).
    const newPagePromise = extensionContext.waitForEvent('page', { timeout: 10_000 });
    await senderPage.locator('.fmn-send-to-btn').click();
    await senderPage.locator('.fmn-send-to-item', { hasText: 'Manage Attributes' }).click();

    const receiverPage = await newPagePromise;
    await receiverPage.waitForLoadState('domcontentloaded');
    await expect(receiverPage).toHaveURL(/attribute-management\/app\.html/);
    // Textarea should contain `count` lines, each a numeric id.
    await receiverPage.waitForSelector('textarea.paste-area', { state: 'attached' });
    await expect(async () => {
      const v = await receiverPage.locator('textarea.paste-area').inputValue();
      const lines = v.split(/\r?\n/).filter(Boolean);
      expect(lines.length).toBe(count);
      for (const line of lines) expect(line).toMatch(/^\d+$/);
    }).toPass({ timeout: 15_000 });
    await expect(receiverPage.locator('.fmn-handoff-banner')).toContainText('Find Servers');

    await receiverPage.close();
    await senderPage.close();
  });
});
