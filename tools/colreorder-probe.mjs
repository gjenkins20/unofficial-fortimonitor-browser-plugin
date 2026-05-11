// FMN-122: ColReorder availability probe (v2).
//
// Launches headed Chromium, opens FortiMonitor's /report/ListServers, waits
// for the operator to authenticate and reach that page, then runs the
// FMN-122 console snippet via page.evaluate(). Prints the JSON result.
//
// v2 changes: don't depend on a specific table class (the original
// `.pa-table_outage` selector did not match on the operator's tenant
// during FMN-122 trial run on 2026-05-11). Detect ColReorder globally
// via `jQuery.fn.dataTable.ColReorder` and also enumerate any
// DataTables-initialized tables on the page for diagnostics.
//
// Usage:
//   node tools/colreorder-probe.mjs
//
// Operator: log in normally; the probe runs as soon as the page is ready.

import { chromium } from '@playwright/test';

const TARGET = 'https://fortimonitor.forticloud.com/report/ListServers';

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext();
const page = await ctx.newPage();

console.log(`[probe] opening ${TARGET}`);
console.log('[probe] log in if prompted; the probe runs as soon as the page is ready.');

await page.goto(TARGET, { waitUntil: 'domcontentloaded' });

// Poll until jQuery loads and at least one DataTables-initialized table
// is present on the page. SSO bounces and login redirects resolve
// transparently because page.waitForFunction keeps retrying.
const result = await page.waitForFunction(
  () => {
    if (!location.pathname.endsWith('/report/ListServers')) return null;
    const $ = window.jQuery;
    if (!$ || typeof $ !== 'function') return null;
    const dataTable = $.fn && $.fn.dataTable;
    if (!dataTable) return null;

    // Enumerate every <table> on the page that DataTables knows about.
    // DataTables.tables() returns the underlying nodes; instances live
    // alongside as DT api objects keyed off the same node.
    const allTables = $('table').toArray();
    const dtInstances = [];
    for (const t of allTables) {
      try {
        if ($.fn.DataTable.isDataTable(t)) {
          const inst = $(t).DataTable();
          const settings = inst.settings()[0] || {};
          dtInstances.push({
            selector: t.className ? `table.${t.className.replace(/\s+/g, '.')}` : 'table',
            id: t.id || null,
            hasColReorderOnInstance: !!inst.colReorder,
            settingsKeys: Object.keys(settings).filter((k) => /reorder/i.test(k))
          });
        }
      } catch { /* skip non-DT tables */ }
    }

    return {
      hasDataTables: true,
      // The authoritative answer to FMN-122: does the global DataTables
      // build ship ColReorder?
      hasColReorderGlobal: !!dataTable.ColReorder,
      // Per-instance check too: even if global is present, an instance
      // might not be initialized with ColReorder.
      anyInstanceHasColReorder: dtInstances.some((d) => d.hasColReorderOnInstance),
      dtVersion: dataTable.version || null,
      colReorderVersion: dataTable.ColReorder ? dataTable.ColReorder.version : null,
      dtInstances,
      tableCount: allTables.length,
      url: location.href
    };
  },
  null,
  { timeout: 0, polling: 1500 }
);

const json = await result.jsonValue();
console.log('---probe result---');
console.log(JSON.stringify(json, null, 2));
console.log('---end---');

await browser.close();
process.exit(0);
