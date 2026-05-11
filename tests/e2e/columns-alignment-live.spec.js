// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-151: live reproduction of column-misalignment on /report/ListServers.
//
// The harness-based spec (columns-alignment.spec.js) passes all 9 hide /
// scroll scenarios with a faithful DataTables model, which proved the
// display:none mechanism itself is sound. The real bug lives in real
// FortiMonitor behaviour our harness does not simulate. This spec drives
// a real, logged-in browser to characterize it.
//
// This spec does NOT launch Chromium. It connects via CDP to a long-
// lived browser started by tools/dev/fmn-151-browser.mjs. That separation
// keeps the authenticated session alive across edit / re-run cycles -
// the operator signs in once when they start the launcher script, and
// every subsequent test run reuses the same tab (per memory rule
// keep_authenticated_chromium_alive_during_ticket).
//
// Run order:
//   1. node tools/dev/fmn-151-browser.mjs   (in another terminal, kept open)
//   2. (one-time) sign into FortiMonitor in the launched Chromium window
//   3. npx playwright test tests/e2e/columns-alignment-live.spec.js
//      (rerun this step as many times as needed - Chromium stays up)

import { test as base, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.resolve(__dirname, '__artifacts__/fmn-151');

const FORTIMONITOR_ORIGIN = 'https://fortimonitor.forticloud.com';
const ALL_INSTANCES_URL = `${FORTIMONITOR_ORIGIN}/report/ListServers`;
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const CDP_URL = `http://localhost:${CDP_PORT}`;

const test = base.extend({
  livePage: [async ({}, use) => {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
    } catch (e) {
      throw new Error(
        `Could not connect to Chromium at ${CDP_URL}. ` +
        `Start the dev browser first: \`node tools/dev/fmn-151-browser.mjs\`. ` +
        `Underlying error: ${e.message}`
      );
    }
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error('CDP browser has no contexts - launcher may not be ready');
    }
    const context = contexts[0];
    // Prefer an existing All Instances tab; otherwise the first page.
    let page = context.pages().find((p) => p.url().startsWith(FORTIMONITOR_ORIGIN));
    if (!page) page = context.pages()[0] || await context.newPage();

    await use(page);

    // Intentionally do NOT close the context or the browser. The launcher
    // owns the browser lifecycle. Disconnecting the CDP client leaves the
    // Chromium process running for the next iteration.
    await browser.close();
  }, { scope: 'worker' }],
});

test.setTimeout(120_000);

async function ensureOnAllInstances(page) {
  // Always navigate fresh so we observe initial-mount state on each run,
  // not whatever the previous iteration's mutations left behind.
  await page.goto(ALL_INSTANCES_URL, { waitUntil: 'domcontentloaded' });
  const hasLoginInput = await page.locator('input[type="password"]').count();
  if (hasLoginInput > 0) {
    throw new Error(
      'FortiMonitor is at a login screen. ' +
      'Sign into the dev-browser Chromium window (started by ' +
      'tools/dev/fmn-151-browser.mjs), then re-run this spec.'
    );
  }
  await page.waitForLoadState('networkidle').catch(() => {});
}

// Identify the scroll container and the two stacked tables (FMN-78
// duplicate-header layout: a scroll-head clone + the scroll-body table).
async function discoverTables(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table.pa-table_outage'));
    const info = tables.map((t, i) => {
      const headerCells = Array.from(t.querySelectorAll('thead tr th'));
      return {
        index: i,
        rect: t.getBoundingClientRect().toJSON(),
        headerLabels: headerCells.map((th) => (th.textContent || '').trim()).slice(0, 12),
        bodyRowCount: t.querySelectorAll('tbody tr').length,
        widthStyle: t.style.width,
        tableLayout: t.style.tableLayout,
      };
    });
    const scrollHeadInner = document.querySelector('.dataTables_scrollHeadInner');
    const scrollBody = document.querySelector('.dataTables_scrollBody');
    return {
      tableCount: tables.length,
      tables: info,
      scrollHeadInnerWidth: scrollHeadInner ? scrollHeadInner.getBoundingClientRect().width : null,
      scrollBodyWidth: scrollBody ? scrollBody.getBoundingClientRect().width : null,
      scrollBodyScrollLeft: scrollBody ? scrollBody.scrollLeft : null,
    };
  });
}

// Measure per-column alignment between the scroll-head table's TH row
// and the scroll-body table's first body-row TDs. Designed for the
// FortiMonitor DataTables fixed-header layout.
async function measureLive(page) {
  return page.evaluate(() => {
    const TOLERANCE = 1.5;
    const scrollHead = document.querySelector('.dataTables_scrollHead table.pa-table_outage');
    const scrollBody = document.querySelector('.dataTables_scrollBody table.pa-table_outage');
    if (!scrollHead || !scrollBody) {
      return { error: 'fixed-header layout not detected (no .dataTables_scrollHead/.dataTables_scrollBody table)' };
    }
    const headRow = scrollHead.querySelector('thead tr');
    const bodyFirstRow = scrollBody.querySelector('tbody tr');
    if (!headRow || !bodyFirstRow) {
      return { error: 'head row or body first row missing' };
    }
    const headCells = Array.from(headRow.children);
    const bodyCells = Array.from(bodyFirstRow.children);
    if (headCells.length !== bodyCells.length) {
      return { error: `cell-count mismatch: head=${headCells.length} body=${bodyCells.length}` };
    }
    const perColumn = [];
    let anyMisaligned = false;
    for (let i = 0; i < headCells.length; i++) {
      const hc = headCells[i];
      const bc = bodyCells[i];
      const hStyle = window.getComputedStyle(hc);
      const bStyle = window.getComputedStyle(bc);
      const headHidden = hStyle.display === 'none';
      const bodyHidden = bStyle.display === 'none';
      const label = (hc.textContent || '').trim() || `col${i}`;
      if (headHidden && bodyHidden) {
        perColumn.push({ i, label, hidden: true });
        continue;
      }
      if (headHidden !== bodyHidden) {
        perColumn.push({ i, label, hidden: 'asymmetric', headHidden, bodyHidden });
        anyMisaligned = true;
        continue;
      }
      const hRect = hc.getBoundingClientRect();
      const bRect = bc.getBoundingClientRect();
      const deltaLeft = Math.round((bRect.left - hRect.left) * 100) / 100;
      const deltaWidth = Math.round((bRect.width - hRect.width) * 100) / 100;
      const aligned = Math.abs(deltaLeft) <= TOLERANCE && Math.abs(deltaWidth) <= TOLERANCE;
      perColumn.push({
        i, label,
        hLeft: Math.round(hRect.left * 100) / 100,
        bLeft: Math.round(bRect.left * 100) / 100,
        hWidth: Math.round(hRect.width * 100) / 100,
        bWidth: Math.round(bRect.width * 100) / 100,
        deltaLeft,
        deltaWidth,
        aligned,
      });
      if (!aligned) anyMisaligned = true;
    }
    return { tolerance: TOLERANCE, anyMisaligned, perColumn };
  });
}

async function snapshot(page, label) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const p = path.join(ARTIFACTS_DIR, `${label}.png`);
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

function writeReport(name, data) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, `${name}.json`),
    JSON.stringify(data, null, 2)
  );
}

// Find a visible "Columns" trigger - the toolkit-added one (FMN-150,
// id=fmn-columns-button) is the primary surface. Returns the
// ElementHandle or null.
async function findColumnsTrigger(page) {
  const toolkitBtn = page.locator('#fmn-columns-button');
  if (await toolkitBtn.count()) return toolkitBtn.first();
  return null;
}

async function openColumnsMenu(page) {
  const trigger = await findColumnsTrigger(page);
  if (!trigger) return false;
  await trigger.click();
  // Wait for the popover to appear.
  await page.locator('#fmn-columns-popover').waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  return true;
}

async function toggleColumnInPopover(page, label) {
  const popover = page.locator('#fmn-columns-popover');
  const row = popover.locator('.fmn-columns-popover-row').filter({ hasText: label });
  if (!(await row.count())) return false;
  await row.first().locator('.fmn-col-toggle').click();
  return true;
}

async function scrollBodyHorizontally(page, x) {
  await page.evaluate((x) => {
    const body = document.querySelector('.dataTables_scrollBody');
    if (body) body.scrollLeft = x;
  }, x);
  await page.waitForTimeout(120);
}

test('live - reproduce column misalignment on /report/ListServers (FMN-151)', async ({ livePage }) => {
  const page = livePage;
  await ensureOnAllInstances(page);

  // Wait until rows are present (DataTables init complete).
  await page.waitForSelector('table.pa-table_outage tbody tr input.pa-table-row-checkbox', { timeout: 60_000 });

  const discovery = await discoverTables(page);
  writeReport('00-discovery', discovery);
  await snapshot(page, '00-baseline');

  const baselineAlign = await measureLive(page);
  writeReport('01-baseline-align', baselineAlign);
  if (baselineAlign.anyMisaligned) await snapshot(page, '01-baseline-MISALIGNED');
  expect(baselineAlign.anyMisaligned, 'baseline alignment').toBe(false);

  // Try opening the toolkit's Columns menu.
  const opened = await openColumnsMenu(page);
  if (!opened) {
    console.warn('Toolkit Columns button (#fmn-columns-button) not found - extension may not have augmented this page yet or surface differs');
    await snapshot(page, '02-no-columns-button');
  } else {
    await snapshot(page, '02-columns-menu-open');
  }

  // Hide Tags via the toolkit Columns popover and assert alignment holds.
  if (!opened) {
    throw new Error('Toolkit Columns button (#fmn-columns-button) not found - extension augmentation has not mounted on this page yet');
  }
  const toggled = await toggleColumnInPopover(page, 'Tags');
  expect(toggled, 'Tags toggle row found in popover').toBe(true);
  await page.waitForTimeout(300);
  await snapshot(page, '03-after-hide-tags');
  const afterHide = await measureLive(page);
  writeReport('03-after-hide-tags-align', afterHide);
  if (afterHide.anyMisaligned) await snapshot(page, '03-after-hide-tags-MISALIGNED');
  expect(afterHide.anyMisaligned, 'alignment after hide Tags').toBe(false);

  // Scroll body horizontally (operator: "notice as you scroll side-to-side")
  // and re-measure.
  await scrollBodyHorizontally(page, 250);
  await snapshot(page, '04-after-hide-and-scroll');
  const afterScroll = await measureLive(page);
  writeReport('04-after-hide-and-scroll-align', afterScroll);
  if (afterScroll.anyMisaligned) await snapshot(page, '04-after-hide-and-scroll-MISALIGNED');
  expect(afterScroll.anyMisaligned, 'alignment after hide+scroll').toBe(false);
  await scrollBodyHorizontally(page, 0);

  // Restore Tags so subsequent runs start with the same baseline state.
  await openColumnsMenu(page);
  await toggleColumnInPopover(page, 'Tags');
  await page.waitForTimeout(300);
});
