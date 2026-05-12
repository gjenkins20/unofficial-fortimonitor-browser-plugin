#!/usr/bin/env node
// FMN-158 toggle probe: verify the show <-> hide round trip restores the
// column to its natural width when re-shown. Stores the original storage
// state, flips tags.hidden=false, measures, flips back, measures again.
//
// IMPORTANT: writes to chrome.storage.local. Restores the original value
// before exit. If the script is killed mid-run, the operator can re-toggle
// via the in-page Columns popover.

import { chromium } from '@playwright/test';

const CDP = 'http://localhost:9222';
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'))
  || (await ctx.waitForEvent('serviceworker', { timeout: 5000 }));

const page = ctx.pages().find((p) => p.url().includes('/report/ListServers'))
  || (() => { throw new Error('No ListServers tab open'); })();
await page.bringToFront();
// Ensure DataTables data row is present
await page.waitForSelector('table.pa-table_outage tbody tr input.pa-table-row-checkbox', { timeout: 15_000 });

async function readCol6Width() {
  return await page.evaluate(() => {
    const sb = document.querySelector('.dataTables_scrollBody table.pa-table_outage');
    const cg = sb?.querySelector('colgroup');
    const col6 = cg?.children[6];
    const td6 = sb?.querySelector('tbody tr')?.children[6];
    const th6 = document.querySelector('.dataTables_scrollHead table.pa-table_outage thead tr')?.children[6];
    return {
      colgroupWidth: col6?.style.width || null,
      tdOffsetWidth: td6?.offsetWidth,
      thOffsetWidth: th6?.offsetWidth,
      tdHidAttr: td6?.getAttribute('data-fmn-native-hidden'),
      thHidAttr: th6?.getAttribute('data-fmn-native-hidden')
    };
  });
}

async function readStorage() {
  return await sw.evaluate(() => new Promise((r) =>
    chrome.storage.local.get('fm:webguiColumns', (d) =>
      r(d?.['fm:webguiColumns']?.['instances-list-native']))));
}

async function writeStorage(list) {
  await sw.evaluate((listJson) => new Promise((r) =>
    chrome.storage.local.get('fm:webguiColumns', (d) => {
      const all = (d && d['fm:webguiColumns']) || {};
      all['instances-list-native'] = JSON.parse(listJson);
      chrome.storage.local.set({ 'fm:webguiColumns': all }, r);
    })), JSON.stringify(list));
}

const original = await readStorage();
console.log('ORIGINAL storage state:', JSON.stringify(original));

const initialMeasure = await readCol6Width();
console.log('INITIAL col6 measure:', JSON.stringify(initialMeasure));

try {
  // Flip tags to visible
  const shown = original.map((c) => c.id === 'tags' ? { ...c, hidden: false } : c);
  await writeStorage(shown);
  await page.waitForTimeout(500); // storage onChange + MO settle

  const shownMeasure = await readCol6Width();
  console.log('SHOWN col6 measure:', JSON.stringify(shownMeasure));

  // Flip tags back to hidden
  await writeStorage(original);
  await page.waitForTimeout(500);

  const restoredMeasure = await readCol6Width();
  console.log('RESTORED col6 measure:', JSON.stringify(restoredMeasure));

  // Quick assertion summary
  const pass = {
    initialCollapsed: initialMeasure.tdOffsetWidth === 0,
    shownExpanded: shownMeasure.tdOffsetWidth > 50,  // any non-trivial width
    shownNoHiddenAttr: shownMeasure.tdHidAttr === null,
    restoredCollapsed: restoredMeasure.tdOffsetWidth === 0,
    restoredHiddenAttr: restoredMeasure.tdHidAttr === '1'
  };
  console.log('PASS CHECKS:', JSON.stringify(pass, null, 2));
  const allPass = Object.values(pass).every(Boolean);
  console.log(allPass ? 'ALL PASS' : 'SOME FAIL');
  process.exit(allPass ? 0 : 1);
} catch (err) {
  console.error('Probe error:', err.message);
  // Best-effort restore
  await writeStorage(original).catch(() => {});
  process.exit(1);
}
