#!/usr/bin/env node
// FMN-158 probe: diagnose why /report/ListServers shows empty Tags cells.
//
// Connects to the operator's authenticated Chromium at :9222, navigates a
// fresh tab to /report/ListServers, waits for the DataTables fixed-header
// two-table layout to settle, then inspects:
//   - stored fm:webguiColumns.instances-list-native (is tags persisted hidden?)
//   - thead text per cell (does Tags text match where expected?)
//   - tags TH and a sampling of tags TDs: NATIVE_HIDDEN_ATTR present? inner spans?
//     computed style visibility on inner elements?
//   - whether the col[6] payload from the AJAX response is in the DOM as innerHTML
//
// Pure observation. No mutation of storage or DOM beyond document.querySelector.

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const CDP = 'http://localhost:9222';
const OUT = '/tmp/fmn-qa/fmn-158';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'))
  || (await ctx.waitForEvent('serviceworker', { timeout: 5000 }));
const extId = new URL(sw.url()).host;

const summary = { extId };

// 1. Storage state for native-column visibility
summary.storage_native_columns = await sw.evaluate(() => new Promise((r) =>
  chrome.storage.local.get('fm:webguiColumns', (d) => r(d?.['fm:webguiColumns']?.['instances-list-native'] ?? null))));

// 2. Open Instances list in a new page
const page = await ctx.newPage();
await page.goto('https://fortimonitor.forticloud.com/report/ListServers', { waitUntil: 'domcontentloaded' });

// Wait for DataTables to populate: tbody row checkboxes are the gate the
// content-script uses too (see augment.js shouldAugment check).
await page.waitForSelector('table.pa-table_outage tbody tr input.pa-table-row-checkbox', { timeout: 30_000 });
await page.waitForTimeout(2000); // let augment.js settle a couple of MO ticks

await page.screenshot({ path: `${OUT}/01-listservers.png`, fullPage: false });

// 3. Inspect thead structure (scroll-head clone is the visible thead under
// DataTables fixed-header layout).
const headInfo = await page.evaluate(() => {
  const scrollHead = document.querySelector('.dataTables_scrollHead table.pa-table_outage thead tr');
  const flatHead = document.querySelector('table.pa-table_outage thead tr');
  const head = scrollHead || flatHead;
  if (!head) return { error: 'no thead found' };
  return {
    using: scrollHead ? 'scrollHead' : 'flat',
    cellCount: head.children.length,
    cells: Array.from(head.children).map((c, i) => ({
      i,
      tag: c.tagName,
      class: c.className,
      text: (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      hidAttr: c.getAttribute('data-fmn-native-hidden'),
      hasAttrLockedClass: c.classList?.toString()
    }))
  };
});
summary.thead = headInfo;

// 4. Inspect a sample body row's column-6 (Tags) state
const tagsCellInfo = await page.evaluate(() => {
  const bodyTable = document.querySelector('.dataTables_scrollBody table.pa-table_outage')
    || document.querySelector('table.pa-table_outage');
  if (!bodyTable) return { error: 'no body table' };
  const rows = Array.from(bodyTable.querySelectorAll('tbody > tr')).slice(0, 5);
  return rows.map((row, ri) => {
    const cells = Array.from(row.children);
    const cell6 = cells[6];
    const cellByClass = row.querySelector('td.tag-column, td.tags-column');
    const cell = cell6;
    if (!cell) return { ri, error: 'no col 6' };
    const innerSpans = Array.from(cell.querySelectorAll('span.pa-badge_tag, span.pa-badge'));
    return {
      ri,
      childTagsByIndex: cells.map((c, i) => `${i}:${c.tagName}.${(c.className || '').split(' ')[0]}`),
      col6_tag: cell.tagName,
      col6_class: cell.className,
      col6_hidAttr: cell.getAttribute('data-fmn-native-hidden'),
      col6_innerHTML_len: (cell.innerHTML || '').length,
      col6_innerHTML_snippet: (cell.innerHTML || '').slice(0, 300),
      col6_text: (cell.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      col6_offsetWidth: cell.offsetWidth,
      col6_offsetHeight: cell.offsetHeight,
      col6_computed: (() => {
        const cs = window.getComputedStyle(cell);
        return { display: cs.display, visibility: cs.visibility, padding: cs.padding, width: cs.width };
      })(),
      innerSpan_count: innerSpans.length,
      innerSpan_first: innerSpans[0] ? (() => {
        const s = innerSpans[0];
        const cs = window.getComputedStyle(s);
        return {
          text: (s.textContent || '').trim().slice(0, 60),
          display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
          outerHTML_len: s.outerHTML.length
        };
      })() : null,
      // Also check the cell-by-class lookup
      cellByClass_tag: cellByClass?.tagName,
      cellByClass_class: cellByClass?.className,
      cellByClass_idx_in_row: cellByClass ? cells.indexOf(cellByClass) : -1
    };
  });
});
summary.body_rows_col6 = tagsCellInfo;

// 5. Check NATIVE_HIDDEN_ATTR distribution across the table
const hiddenAttrDist = await page.evaluate(() => {
  const cellsHidden = document.querySelectorAll('table.pa-table_outage [data-fmn-native-hidden]');
  const byCol = {};
  for (const c of cellsHidden) {
    const idx = Array.from(c.parentElement?.children || []).indexOf(c);
    const tag = c.tagName;
    const key = `${tag}@col${idx}`;
    byCol[key] = (byCol[key] || 0) + 1;
  }
  return {
    total_hidden_attr: cellsHidden.length,
    breakdown: byCol
  };
});
summary.hidden_attr_distribution = hiddenAttrDist;

// 6. Inspect the fmn-native-column-styles stylesheet (still present? what selector?)
summary.native_style_text = await page.evaluate(() => {
  const s = document.getElementById('fmn-native-column-styles');
  return s ? s.textContent.replace(/\s+/g, ' ').trim().slice(0, 600) : null;
});

// 7. Direct probe: what does augment.js's idToIndex map look like, would it match the
//    Tags TH text? Mirror its logic in-page.
const matchDebug = await page.evaluate(() => {
  const NATIVE_COLUMN_DEFS = [
    { id: 'instance',      lockedVisible: true,  matchText: 'Instance' },
    { id: 'parentGroup',   lockedVisible: false, matchText: 'Parent Group' },
    { id: 'alertTimeline', lockedVisible: false, matchText: 'Alert Timeline' },
    { id: 'tags',          lockedVisible: false, matchText: 'Tags' },
    { id: 'agentVersion',  lockedVisible: false, matchText: 'Agent Version' },
    { id: 'heartbeat',     lockedVisible: false, matchText: 'Device Heartbeat' },
  ];
  const tables = document.querySelectorAll('table.pa-table_outage');
  const out = [];
  for (const table of tables) {
    const head = table.querySelector('thead tr');
    if (!head) continue;
    const headerCells = Array.from(head.children);
    const idToIndex = new Map();
    for (const def of NATIVE_COLUMN_DEFS) {
      const match = def.matchText.toLowerCase();
      for (let i = 0; i < headerCells.length; i++) {
        const text = (headerCells[i].textContent || '').trim().toLowerCase();
        if (text === match || text.startsWith(match)) {
          if (!idToIndex.has(def.id)) idToIndex.set(def.id, i);
        }
      }
    }
    out.push({
      tableLocation: table.closest('.dataTables_scrollHead') ? 'scrollHead'
        : table.closest('.dataTables_scrollBody') ? 'scrollBody' : 'flat',
      headerCellCount: headerCells.length,
      idToIndex: Object.fromEntries(idToIndex),
      perCellText: headerCells.map((c, i) => `${i}: ${(c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)}`)
    });
  }
  return out;
});
summary.match_debug = matchDebug;

writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
await page.close();
process.exit(0);
