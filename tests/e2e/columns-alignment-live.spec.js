// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-151: live reproduction of column-misalignment on /report/ListServers.
//
// The harness-based spec (columns-alignment.spec.js) passes all 9 hide /
// scroll scenarios with a faithful DataTables model. That tells us the
// display:none mechanism itself is sound, so the bug must live in real
// FortiMonitor behaviour our harness does not simulate. This spec drives
// a real, logged-in browser to characterize it.
//
// Workflow on first run:
//   1. A visible Chromium window opens with the toolkit extension loaded.
//   2. If the operator's profile is not signed into FortiMonitor, the spec
//      pauses for up to 10 minutes while the operator logs in. The profile
//      is persisted under tests/e2e/.profile-fmn-live/ so subsequent runs
//      skip the login.
//   3. Once on /report/ListServers, the spec runs the misalignment matrix
//      and writes a structured report under
//      tests/e2e/__artifacts__/fmn-151/, including per-scenario alignment
//      measurements and full-page screenshots on every misalignment.
//
// The window is INTENTIONALLY visible: the operator must be able to
// interact for the login step. Per memory playwright_offscreen_window
// the offscreen flags only apply when no operator interaction is needed;
// live login is an explicit exception.

import { test as base, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');
const PROFILE_DIR = path.resolve(__dirname, '.profile-fmn-live');
const ARTIFACTS_DIR = path.resolve(__dirname, '__artifacts__/fmn-151');

const FORTIMONITOR_ORIGIN = 'https://fortimonitor.forticloud.com';
const ALL_INSTANCES_URL = `${FORTIMONITOR_ORIGIN}/report/ListServers`;

// Login takes operator time; reproduction itself is sub-second.
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

const test = base.extend({
  liveContext: [async ({}, use) => {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1400, height: 900 },
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
    await use(context);
    await context.close();
  }, { scope: 'worker' }],
});

test.setTimeout(LOGIN_TIMEOUT_MS + 60_000);

async function ensureLoggedIn(page) {
  await page.goto(ALL_INSTANCES_URL, { waitUntil: 'domcontentloaded' });
  // If the SPA redirects to /login or shows the login form, prompt the
  // operator and wait. Detect by URL or by visible login input.
  const isAtAllInstances = async () => {
    const url = page.url();
    if (!url.startsWith(FORTIMONITOR_ORIGIN)) return false;
    if (!url.includes('/report/ListServers')) return false;
    // The login screen sometimes lives at the same path but with a form.
    const hasLoginInput = await page.locator('input[type="password"]').count();
    return hasLoginInput === 0;
  };
  if (await isAtAllInstances()) return;

  console.log('\n=================================================================');
  console.log('FMN-151 live reproduction needs you signed into FortiMonitor.');
  console.log('A Chromium window has opened. Please sign in there.');
  console.log(`Waiting up to ${LOGIN_TIMEOUT_MS / 60000} minutes...`);
  console.log('=================================================================\n');

  await page.waitForURL(/\/report\/ListServers/, { timeout: LOGIN_TIMEOUT_MS });
  // Allow SPA hydration after the URL settles.
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
  const row = popover.locator(`label:has-text("${label}")`);
  if (!(await row.count())) return false;
  await row.first().click();
  return true;
}

async function scrollBodyHorizontally(page, x) {
  await page.evaluate((x) => {
    const body = document.querySelector('.dataTables_scrollBody');
    if (body) body.scrollLeft = x;
  }, x);
  await page.waitForTimeout(120);
}

test('live - reproduce column misalignment on /report/ListServers (FMN-151)', async ({ liveContext }) => {
  const page = await liveContext.newPage();
  await ensureLoggedIn(page);

  // Wait until rows are present (DataTables init complete).
  await page.waitForSelector('table.pa-table_outage tbody tr input.pa-table-row-checkbox', { timeout: 60_000 });

  const discovery = await discoverTables(page);
  console.log('Table discovery:', JSON.stringify(discovery, null, 2));
  writeReport('00-discovery', discovery);
  await snapshot(page, '00-baseline');

  const baselineAlign = await measureLive(page);
  console.log('Baseline alignment:', JSON.stringify(baselineAlign, null, 2));
  writeReport('01-baseline-align', baselineAlign);
  if (baselineAlign.anyMisaligned) await snapshot(page, '01-baseline-MISALIGNED');

  // Try opening the toolkit's Columns menu.
  const opened = await openColumnsMenu(page);
  if (!opened) {
    console.warn('Toolkit Columns button (#fmn-columns-button) not found - extension may not have augmented this page yet or surface differs');
    await snapshot(page, '02-no-columns-button');
  } else {
    await snapshot(page, '02-columns-menu-open');
  }

  // Hide Tags (if a Columns popover is present).
  if (opened) {
    const toggled = await toggleColumnInPopover(page, 'Tags');
    console.log('Toggled Tags:', toggled);
    await page.waitForTimeout(300);
    await snapshot(page, '03-after-hide-tags');
    const afterHide = await measureLive(page);
    console.log('After hide Tags alignment:', JSON.stringify(afterHide, null, 2));
    writeReport('03-after-hide-tags-align', afterHide);
    if (afterHide.anyMisaligned) await snapshot(page, '03-after-hide-tags-MISALIGNED');

    // Scroll body horizontally and re-measure (operator: "notice as you scroll").
    await scrollBodyHorizontally(page, 250);
    await snapshot(page, '04-after-hide-and-scroll');
    const afterScroll = await measureLive(page);
    console.log('After hide+scroll alignment:', JSON.stringify(afterScroll, null, 2));
    writeReport('04-after-hide-and-scroll-align', afterScroll);
    if (afterScroll.anyMisaligned) await snapshot(page, '04-after-hide-and-scroll-MISALIGNED');

    // Scroll back to start.
    await scrollBodyHorizontally(page, 0);

    // Hide another column too.
    const opened2 = await openColumnsMenu(page);
    if (opened2) {
      await toggleColumnInPopover(page, 'Device Heartbeat');
      await page.waitForTimeout(300);
      await snapshot(page, '05-after-hide-tags-and-heartbeat');
      const afterTwo = await measureLive(page);
      console.log('After hide tags+heartbeat alignment:', JSON.stringify(afterTwo, null, 2));
      writeReport('05-after-hide-two-align', afterTwo);
      if (afterTwo.anyMisaligned) await snapshot(page, '05-after-hide-two-MISALIGNED');

      await scrollBodyHorizontally(page, 250);
      await snapshot(page, '06-after-hide-two-and-scroll');
      const afterTwoScroll = await measureLive(page);
      console.log('After hide two + scroll alignment:', JSON.stringify(afterTwoScroll, null, 2));
      writeReport('06-after-hide-two-and-scroll-align', afterTwoScroll);
      if (afterTwoScroll.anyMisaligned) await snapshot(page, '06-after-hide-two-and-scroll-MISALIGNED');

      // Restore all columns.
      await openColumnsMenu(page);
      await toggleColumnInPopover(page, 'Tags');
      await openColumnsMenu(page);
      await toggleColumnInPopover(page, 'Device Heartbeat');
      await page.waitForTimeout(300);
    }
  }

  // Final no-fail assertion: leave the verdict in the artifacts. The
  // operator will inspect __artifacts__/fmn-151/ for screenshots and
  // JSON reports. Spec passes regardless - we are characterizing, not
  // gating.
  console.log('\n=================================================================');
  console.log('FMN-151 live reproduction complete.');
  console.log(`Artifacts: ${ARTIFACTS_DIR}`);
  console.log('=================================================================\n');
});
