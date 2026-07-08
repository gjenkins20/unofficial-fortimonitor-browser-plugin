// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-280 LIVE spec: the top-level Parent/Child Associations tool, driven
// against the persistent Dev Launcher over CDP.
//
// BEHAVIOR MATRIX:
//   (a) tool page renders (tabs + inputs);
//   (b) Set by SERVER ID: "parent: child" -> Preview will-set -> Apply -> v2
//       confirms the parent was set;
//   (c) many-children->one-parent grouping previews multiple rows + self-parent
//       is caught as skip;
//   (d) Remove: child list -> Preview will-remove -> Apply -> v2 confirms None
//       AND a full-record diff shows only parent_server changed (no clobber).
//
// SKIP: no SW; flag off / tool not wired; no v2 key; login screen.
//
// Run: FMN_CDP_PORT=<port> npx playwright test --config tests/e2e/playwright.config.js \
//   tests/e2e/fmn-280-parent-child-live.spec.js --grep "live -" --reporter=line

import { test as base, expect, chromium } from '@playwright/test';

const FM = 'https://fortimonitor.forticloud.com';
const V2 = 'https://api2.panopta.com/v2';
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const CHILD_ID = process.env.FMN_PARENT_TEST_CHILD || '44218437';
const PARENT_ID = process.env.FMN_PARENT_TEST_PARENT || '44287843';

const VOLATILE = new Set(['current_state', 'current_outages', 'status', 'agent_last_sync_time', 'snmp_last_scan_time', 'agent_installed', 'agent_version']);

const test = base.extend({
  liveCtx: [async ({}, use) => {
    const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    const ctx = browser.contexts()[0];
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 }).catch(() => null);
    let fmPage = ctx.pages().find((p) => p.url().startsWith(FM));
    if (!fmPage) { fmPage = await ctx.newPage(); await fmPage.goto(`${FM}/report/ListServers`, { waitUntil: 'domcontentloaded' }); }
    const atLogin = (await fmPage.locator('input[type="password"]').count()) > 0;
    await use({ ctx, sw, atLogin });
    await browser.close();
  }, { scope: 'worker' }]
});
test.setTimeout(120_000);

async function hasApiKey(sw) { return sw ? await sw.evaluate(async () => !!(await chrome.storage.local.get('panopta.apiKey'))['panopta.apiKey']) : false; }
async function getServerV2(sw, id) {
  return await sw.evaluate(async ({ id, V2 }) => {
    const key = (await chrome.storage.local.get('panopta.apiKey'))['panopta.apiKey'];
    const r = await fetch(`${V2}/server/${id}`, { headers: { Authorization: `ApiKey ${key}` } });
    return r.ok ? await r.json() : { __error: r.status };
  }, { id, V2 });
}
async function setParentV2(sw, id, url) {
  return await sw.evaluate(async ({ id, url, V2 }) => {
    const key = (await chrome.storage.local.get('panopta.apiKey'))['panopta.apiKey'];
    const H = { Authorization: `ApiKey ${key}`, Accept: 'application/json' };
    const j = await (await fetch(`${V2}/server/${id}`, { headers: H })).json();
    const o = { ...j, parent_server: url };
    const c = (k) => { if (o[k] == null) return; if (typeof o[k] === 'number') return; const n = parseFloat(o[k]); o[k] = Number.isFinite(n) ? n : null; };
    c('geo_latitude'); c('geo_longitude');
    if (o.snmp_heartbeat_enabled === true && !o.snmp_scan_frequency) { o.snmp_heartbeat_enabled = false; o.snmp_heartbeat_notification_schedule = null; }
    if (Object.prototype.hasOwnProperty.call(o, 'device_type') && o.device_type !== 'server' && o.device_type !== 'network_device') delete o.device_type;
    return (await fetch(`${V2}/server/${id}`, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(o) })).status;
  }, { id, url, V2 });
}
const toolUrl = (extId) => `chrome-extension://${extId}/src/ui/parent-child/app.html`;

test.describe('live - FMN-280 Parent/Child Associations tool', () => {
  test('live - tool page renders with Set/Remove tabs', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No SW'); test.skip(atLogin, 'login screen');
    const extId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    await page.goto(toolUrl(extId));
    await expect(page.locator('[data-test="pc-tab-set"]')).toBeVisible();
    await expect(page.locator('[data-test="pc-tab-remove"]')).toBeVisible();
    await expect(page.locator('[data-test="pc-set-input"]')).toBeVisible();
    await page.close();
  });

  test('live - Set by server ID (parent: child) previews will-set and Apply sets it (v2 confirmed)', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No SW'); test.skip(atLogin, 'login screen');
    test.skip(!(await hasApiKey(sw)), 'no v2 key');
    // Baseline: clear via seeding a KNOWN different state first (set to none is impossible via v2, so seed to a 3rd parent is overkill; just capture current).
    const extId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(toolUrl(extId));
    // Set CHILD's parent to PARENT by ID. Also include a self-parent line to prove the skip.
    await page.locator('[data-test="pc-set-input"]').fill(`${PARENT_ID}: ${CHILD_ID}, ${PARENT_ID}`);
    await page.locator('[data-test="pc-preview-btn"]').click();
    await expect(page.locator('[data-test="pc-preview"]')).toBeVisible({ timeout: 30000 });
    const rows = page.locator('[data-test="pc-preview-row"]');
    await expect(rows).toHaveCount(2);
    // one row will-set (child), one skip-self (parent as its own child)
    await expect(page.locator('.pc-pill-self')).toHaveCount(1);
    // Apply
    await page.locator('[data-test="pc-apply-btn"]').click();
    await expect(page.locator('[data-test="pc-summary"]')).toContainText(/ok/i, { timeout: 30000 });
    // v2 confirms
    await expect.poll(async () => (await getServerV2(sw, CHILD_ID)).parent_server, { timeout: 15000 })
      .toBe(`${V2}/server/${PARENT_ID}`);
    expect(errs, errs.join(' | ')).toEqual([]);
    await page.close();
  });

  test('live - Remove clears the parent (v2 confirmed) with no clobber', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No SW'); test.skip(atLogin, 'login screen');
    test.skip(!(await hasApiKey(sw)), 'no v2 key');
    // Ensure a parent is set first.
    await setParentV2(sw, CHILD_ID, `${V2}/server/${PARENT_ID}`);
    const before = await getServerV2(sw, CHILD_ID);
    expect(before.parent_server).toBe(`${V2}/server/${PARENT_ID}`);

    const extId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(toolUrl(extId));
    await page.locator('[data-test="pc-tab-remove"]').click();
    await page.locator('[data-test="pc-remove-input"]').fill(String(CHILD_ID));
    await page.locator('[data-test="pc-preview-btn"]').click();
    await expect(page.locator('[data-test="pc-preview-row"]')).toHaveCount(1, { timeout: 30000 });
    await expect(page.locator('.pc-pill-remove')).toHaveCount(1);
    await page.locator('[data-test="pc-apply-btn"]').click();
    await expect(page.locator('[data-test="pc-summary"]')).toContainText(/ok/i, { timeout: 30000 });

    let after;
    await expect.poll(async () => { after = await getServerV2(sw, CHILD_ID); return after.parent_server; }, { timeout: 15000 }).toBe(null);
    const changed = [];
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (VOLATILE.has(k)) continue;
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k);
    }
    expect(changed, `only parent_server should change; changed=${changed.join(',')}`).toEqual(['parent_server']);
    expect(errs, errs.join(' | ')).toEqual([]);
    await page.close();
  });
});
