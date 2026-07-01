// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-279 LIVE spec: the Bulk Action Composer "Remove Parent Instance" action,
// driven against the persistent Dev Launcher over CDP.
//
// Removal uses the session-auth editInstance form (parent_server[] omitted). The
// SAFETY-CRITICAL property is NO CLOBBER: the full instance record must be
// unchanged except parent_server. This spec sets a parent via v2, drives the
// real composer through Apply, then asserts a full v2 before/after diff touched
// ONLY parent_server.
//
// BEHAVIOR MATRIX:
//   (a) the Remove Parent Instance action card is present in the picker;
//   (b) Configure renders the info + the pre-flight populates the current parent;
//   (c) Preview: a child WITH a parent shows "will change" (prev=parent,
//       next=(none));
//   (d) Apply clears parent_server (verified via v2) AND the full v2 diff shows
//       ONLY parent_server changed (no clobber).
//
// SKIP: no SW; launcher missing the FMN-279 wiring; no v2 API key; login screen.
//
// Run: FMN_CDP_PORT=<port> npx playwright test --config tests/e2e/playwright.config.js \
//   tests/e2e/fmn-279-remove-parent-instance-live.spec.js --grep "live -" --reporter=line

import { test as base, expect, chromium } from '@playwright/test';

const FM = 'https://fortimonitor.forticloud.com';
const V2 = 'https://api2.panopta.com/v2';
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const CDP_URL = `http://localhost:${CDP_PORT}`;
const CHILD_ID = process.env.FMN_PARENT_TEST_CHILD || '44218437';
const SEED_PARENT = process.env.FMN_SEED_PARENT || `${V2}/server/44287843`;

// v2 fields that legitimately drift between two reads; excluded from the
// no-clobber diff so they don't cause false positives.
const VOLATILE = new Set([
  'current_state', 'current_outages', 'status', 'agent_last_sync_time',
  'snmp_last_scan_time', 'agent_installed', 'agent_version'
]);

const test = base.extend({
  liveCtx: [async ({}, use) => {
    let browser;
    try { browser = await chromium.connectOverCDP(CDP_URL); }
    catch (e) { throw new Error(`Could not connect to Chromium at ${CDP_URL}. Start \`node tools/dev/launcher.mjs\`. ${e.message}`); }
    const ctx = browser.contexts()[0];
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
    let fmPage = ctx.pages().find((p) => p.url().startsWith(FM));
    if (!fmPage) { fmPage = await ctx.newPage(); await fmPage.goto(`${FM}/report/ListServers`, { waitUntil: 'domcontentloaded' }); }
    const atLogin = (await fmPage.locator('input[type="password"]').count()) > 0;
    await use({ ctx, sw, atLogin });
    await browser.close();
  }, { scope: 'worker' }]
});

test.setTimeout(120_000);

async function hasApiKey(sw) {
  return sw ? await sw.evaluate(async () => !!(await chrome.storage.local.get('panopta.apiKey'))['panopta.apiKey']) : false;
}
async function getServerV2(sw, id) {
  return await sw.evaluate(async ({ id, V2 }) => {
    const key = (await chrome.storage.local.get('panopta.apiKey'))['panopta.apiKey'];
    const r = await fetch(`${V2}/server/${id}`, { headers: { Authorization: `ApiKey ${key}` } });
    return r.ok ? await r.json() : { __error: r.status };
  }, { id, V2 });
}
async function setParentV2(sw, id, parentUrl) {
  return await sw.evaluate(async ({ id, parentUrl, V2 }) => {
    const key = (await chrome.storage.local.get('panopta.apiKey'))['panopta.apiKey'];
    const H = { Authorization: `ApiKey ${key}`, Accept: 'application/json' };
    const j = await (await fetch(`${V2}/server/${id}`, { headers: H })).json();
    const o = { ...j, parent_server: parentUrl };
    const c = (k) => { if (o[k] == null) return; if (typeof o[k] === 'number') return; const n = parseFloat(o[k]); o[k] = Number.isFinite(n) ? n : null; };
    c('geo_latitude'); c('geo_longitude');
    if (o.snmp_heartbeat_enabled === true && !o.snmp_scan_frequency) { o.snmp_heartbeat_enabled = false; o.snmp_heartbeat_notification_schedule = null; }
    if (Object.prototype.hasOwnProperty.call(o, 'device_type') && o.device_type !== 'server' && o.device_type !== 'network_device') delete o.device_type;
    return (await fetch(`${V2}/server/${id}`, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(o) })).status;
  }, { id, parentUrl, V2 });
}
function bulkAppUrl(extensionId, hash = '/pick') {
  return `chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#${hash}`;
}

test.describe('live - FMN-279 Remove Parent Instance action', () => {
  test('live - action card is present in the picker', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');
    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    await page.goto(bulkAppUrl(extensionId, '/pick'));
    await page.locator('textarea.paste-area').fill('1,placeholder');
    await page.locator('[data-test="pick-next"]').click();
    await expect(page.locator('[data-test="action-card"][data-action-id="remove-parent-instance"]')).toBeVisible();
    await page.close();
  });

  test('live - Apply clears parent_server and touches ONLY parent_server (no clobber)', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');
    test.skip(!(await hasApiKey(sw)), 'No v2 API key seeded.');

    // Seed a parent so removal is meaningful.
    const seedStatus = await setParentV2(sw, CHILD_ID, SEED_PARENT);
    expect([200, 204]).toContain(seedStatus);
    const before = await getServerV2(sw, CHILD_ID);
    test.skip(before.__error, `Could not read child #${CHILD_ID} via v2.`);
    expect(before.parent_server).toBe(SEED_PARENT);

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    // Drive pick -> action -> configure -> preview.
    await page.goto(bulkAppUrl(extensionId, '/pick'));
    await page.locator('textarea.paste-area').fill(`${CHILD_ID},child`);
    await expect(page.locator('.sample-table tbody tr')).toHaveCount(1);
    await page.locator('[data-test="pick-next"]').click();
    await page.locator('[data-test="action-card"][data-action-id="remove-parent-instance"]').click();
    await page.locator('[data-test="action-next"]').click();
    await expect(page.locator('[data-test="remove-parent-instance-info"]')).toBeVisible();
    // (b) pre-flight populates the current parent (object, not undefined).
    await expect.poll(() => page.evaluate(async () => {
      const mod = await import('./app.js');
      const t = mod.store.targets[0];
      return t && t.parentInstance !== undefined;
    }), { timeout: 20000 }).toBe(true);
    await page.locator('[data-test="configure-next"]').click();
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('Preview', { timeout: 6000 });

    // (c) Preview shows will-change: prev=parent, next=(none).
    await expect(page.locator('[data-test="bulk-preview-row"]')).toHaveCount(1);
    await expect(page.locator('[data-test="preview-status"]').first()).toContainText(/will change/i);
    await expect(page.locator('[data-test="bulk-preview-row"] td').nth(3)).toContainText('(none)');

    // (d) Apply, then verify via v2.
    await page.locator('[data-test="apply-btn"]').click();
    await expect(page.locator('[data-test="bulk-run-summary"]')).toContainText('1 committed', { timeout: 30000 });

    let after;
    await expect.poll(async () => {
      after = await getServerV2(sw, CHILD_ID);
      return after.parent_server;
    }, { timeout: 15000 }).toBe(null);

    // NO CLOBBER: the only non-volatile field that changed is parent_server.
    const changed = [];
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (VOLATILE.has(k)) continue;
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k);
    }
    expect(changed, `only parent_server should change; changed=${changed.join(',')}`).toEqual(['parent_server']);
    expect(pageErrors, pageErrors.join(' | ')).toEqual([]);
    await page.close();
  });
});
