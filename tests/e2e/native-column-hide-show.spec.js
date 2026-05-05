// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-123: native column hide/show on /report/ListServers.
//
// Drives docs/harnesses/instances-list-native-hide.html. The harness
// reproduces the DataTables fixed-header two-table layout, stubs
// chrome.*, and pulls in augment.js directly. To get augment.js's
// `location.pathname === '/report/ListServers'` guard to fire under
// headless Chromium, the spec routes the live FortiMonitor URL to
// serve the harness HTML with augment.js inlined (the relative
// <script src="..."> wouldn't resolve over an https origin). The
// page never actually talks to the network beyond this synthetic
// fulfill.
//
// This spec runs in true headless Chromium - no extension load needed.
// Per memory playwright_offscreen_window.md Rule 2, harness-only specs
// get headless:true; only specs that exercise the loaded MV3
// extension use the offscreen-headed fixture.

import { test as base, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.resolve(
  __dirname, '../../docs/harnesses/instances-list-native-hide.html'
);
const AUGMENT_JS_PATH = path.resolve(
  __dirname, '../../extension/src/content/augment.js'
);
const FORTIMONITOR_URL = 'https://fortimonitor.forticloud.com/report/ListServers';

// Worker-scoped headless browser. headless:true guarantees no chrome
// window ever paints on the operator's display.
const test = base.extend({
  ctx: [async ({}, use) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await use(context);
    await context.close();
    await browser.close();
  }, { scope: 'worker' }]
});

let cachedHtml = null;
function buildHarnessHtml() {
  if (cachedHtml) return cachedHtml;
  const harness = fs.readFileSync(HARNESS_PATH, 'utf-8');
  const augmentJs = fs.readFileSync(AUGMENT_JS_PATH, 'utf-8');
  // Replace the relative <script src="...augment.js"></script> with an
  // inline <script> so the routed origin doesn't need to also serve the
  // sibling extension/ tree.
  cachedHtml = harness.replace(
    /<script src="\.\.\/\.\.\/extension\/src\/content\/augment\.js"><\/script>/,
    `<script>\n${augmentJs}\n</script>`
  );
  return cachedHtml;
}

async function gotoHarness(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  await page.route(FORTIMONITOR_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: buildHarnessHtml()
    });
  });
  await page.goto(FORTIMONITOR_URL);
  await page.waitForSelector('tbody tr[data-fmn-ip-row-augmented]');
  return { page, errors };
}

// Indexes match the harness markup. instance is locked-visible.
const ID_TO_INDEX = {
  instance: 2,
  parentGroup: 3,
  alertTimeline: 4,
  tags: 5,
  agentVersion: 6,
  heartbeat: 7,
};


test.describe('Native column hide/show on /report/ListServers (FMN-123)', () => {
  test('default state: every native column is visible', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    const result = await page.evaluate(() => window.__verifyNativeHideShow());
    for (const id of Object.keys(ID_TO_INDEX)) {
      expect(result.perColumn[id].headerHidden).toBe(false);
      expect(result.perColumn[id].bodyAllShown).toBe(true);
    }
    expect(errors).toEqual([]);
    await page.close();
  });

  test('hiding Tags + Device Heartbeat marks both theads + every TD at those indexes', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await page.click('#hide-tags-heartbeat-btn');
    // Subscribe handler is async; wait for the verify-on-click to land.
    await page.waitForFunction(() => {
      const el = document.getElementById('verdict');
      return el && el.textContent.includes('PASS');
    }, { timeout: 2000 });
    const result = await page.evaluate(() => window.__verifyNativeHideShow());

    expect(result.perColumn.tags.headerHidden).toBe(true);
    expect(result.perColumn.tags.bodyAllHidden).toBe(true);
    expect(result.perColumn.heartbeat.headerHidden).toBe(true);
    expect(result.perColumn.heartbeat.bodyAllHidden).toBe(true);

    // Other columns must be untouched.
    for (const id of ['parentGroup', 'alertTimeline', 'agentVersion']) {
      expect(result.perColumn[id].headerHidden).toBe(false);
      expect(result.perColumn[id].bodyAllShown).toBe(true);
    }

    // Cross-check: both the scroll-head TH and the body-table TH at
    // index 5 (Tags) carry data-fmn-native-hidden. This is the FMN-78
    // duplicate-header layout - both must be marked.
    const headerCount = await page.locator(
      'table.pa-table_outage thead tr > th:nth-child(6)[data-fmn-native-hidden]'
    ).count();
    expect(headerCount).toBe(2);

    expect(errors).toEqual([]);
    await page.close();
  });

  test('hiding all hideable columns leaves only checkbox + Status + Instance visible', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await page.click('#hide-all-btn');
    await page.waitForFunction(() => {
      const el = document.getElementById('verdict');
      return el && el.textContent.includes('PASS');
    }, { timeout: 2000 });

    const result = await page.evaluate(() => window.__verifyNativeHideShow());
    for (const id of ['parentGroup', 'alertTimeline', 'tags', 'agentVersion', 'heartbeat']) {
      expect(result.perColumn[id].headerHidden).toBe(true);
      expect(result.perColumn[id].bodyAllHidden).toBe(true);
    }
    // Instance is locked-visible - the registry / normalize layer
    // should never let it flip to hidden, even if storage said so.
    expect(result.perColumn.instance.headerHidden).toBe(false);
    expect(result.perColumn.instance.bodyAllShown).toBe(true);

    // Status (idx 1) and the checkbox (idx 0) are not in the registry
    // at all - they should never gain the attribute.
    const checkboxHidden = await page.locator(
      'table.pa-table_outage tbody tr > td:nth-child(1)[data-fmn-native-hidden]'
    ).count();
    expect(checkboxHidden).toBe(0);
    const statusHidden = await page.locator(
      'table.pa-table_outage tbody tr > td:nth-child(2)[data-fmn-native-hidden]'
    ).count();
    expect(statusHidden).toBe(0);

    await page.close();
  });

  test('attempting to hide the locked-visible Instance column is silently rejected', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await page.click('#try-hide-instance-btn');
    // The verify helper compares the WANT-state against the actual DOM.
    // Because the storage state lies (hidden=true for instance), but the
    // augment-side normalizer forces it back to hidden=false, the Instance
    // entry in the verify output reads wantHidden=true / headerHidden=false
    // / bodyAllShown=true / ok=false. That is the expected post-condition:
    // the assertion is on the actual DOM, not on the verify ok flag.
    await page.waitForTimeout(200);
    const headerHidden = await page.locator(
      'table.pa-table_outage thead tr > th:nth-child(3)[data-fmn-native-hidden]'
    ).count();
    expect(headerHidden).toBe(0);
    const bodyHidden = await page.locator(
      'table.pa-table_outage tbody tr > td:nth-child(3)[data-fmn-native-hidden]'
    ).count();
    expect(bodyHidden).toBe(0);
    await page.close();
  });

  test('toggling visibility back on removes the attribute', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);

    await page.click('#hide-all-btn');
    await page.waitForFunction(() => {
      const el = document.getElementById('verdict');
      return el && el.textContent.includes('PASS');
    }, { timeout: 2000 });
    let hiddenAfterHide = await page.locator(
      'table.pa-table_outage [data-fmn-native-hidden]'
    ).count();
    expect(hiddenAfterHide).toBeGreaterThan(0);

    await page.click('#show-all-btn');
    await page.waitForFunction(() => {
      const el = document.getElementById('verdict');
      return el && el.textContent.includes('PASS');
    }, { timeout: 2000 });
    const hiddenAfterShow = await page.locator(
      'table.pa-table_outage [data-fmn-native-hidden]'
    ).count();
    expect(hiddenAfterShow).toBe(0);

    await page.close();
  });

  test('newly injected rows are hidden if the column is hidden when they appear', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);

    await page.click('#hide-tags-heartbeat-btn');
    await page.waitForFunction(() => {
      const el = document.getElementById('verdict');
      return el && el.textContent.includes('PASS');
    }, { timeout: 2000 });
    const beforeRows = await page.locator('table#scroll-body-table tbody tr').count();

    await page.click('#add-row-btn');
    // Wait for the new row to be augmented by the IP/DNS path; once that
    // happens the MutationObserver pass has run, and the native
    // hide-show augmentation has touched the new row's TDs too.
    await page.waitForFunction((n) => {
      const rows = document.querySelectorAll('table#scroll-body-table tbody tr');
      return rows.length > n;
    }, beforeRows, { timeout: 2000 });

    // After injection, every Tags TD (idx 5) and every Heartbeat TD
    // (idx 7) across all rows must carry the hidden attribute -
    // including the new one.
    const tagsHidden = await page.locator(
      'table#scroll-body-table tbody tr > td:nth-child(6)[data-fmn-native-hidden]'
    ).count();
    const tagsTotal = await page.locator(
      'table#scroll-body-table tbody tr > td:nth-child(6)'
    ).count();
    expect(tagsHidden).toBe(tagsTotal);

    const heartbeatHidden = await page.locator(
      'table#scroll-body-table tbody tr > td:nth-child(8)[data-fmn-native-hidden]'
    ).count();
    const heartbeatTotal = await page.locator(
      'table#scroll-body-table tbody tr > td:nth-child(8)'
    ).count();
    expect(heartbeatHidden).toBe(heartbeatTotal);

    await page.close();
  });
});
