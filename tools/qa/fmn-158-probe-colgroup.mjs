#!/usr/bin/env node
// FMN-158 follow-on probe: inspect colgroup state and TH structure to
// understand why a column flagged native-hidden still occupies 190px.

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const CDP = 'http://localhost:9222';
const OUT = '/tmp/fmn-qa/fmn-158';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];

// Use the existing tab if it's already on ListServers, otherwise navigate
let page = ctx.pages().find((p) => p.url().includes('/report/ListServers'));
if (!page) {
  page = await ctx.newPage();
  await page.goto('https://fortimonitor.forticloud.com/report/ListServers', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table.pa-table_outage tbody tr input.pa-table-row-checkbox', { timeout: 30_000 });
  await page.waitForTimeout(2000);
}

const info = await page.evaluate(() => {
  const out = {};
  const scrollHead = document.querySelector('.dataTables_scrollHead table.pa-table_outage');
  const scrollBody = document.querySelector('.dataTables_scrollBody table.pa-table_outage');

  function snapshotTable(table, label) {
    if (!table) return { error: `no ${label}` };
    const cg = table.querySelector('colgroup');
    const cols = cg ? Array.from(cg.children).map((c, i) => ({
      i, tag: c.tagName, width: c.style.width || c.getAttribute('width'), class: c.className
    })) : null;
    const head = table.querySelector('thead tr');
    const headCells = head ? Array.from(head.children).map((c, i) => ({
      i,
      tag: c.tagName,
      text: (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
      hidAttr: c.getAttribute('data-fmn-native-hidden'),
      childTagsKinds: Array.from(c.childNodes).map((n) =>
        n.nodeType === 1 ? `el.${n.tagName.toLowerCase()}` : n.nodeType === 3 ? `text:"${(n.textContent || '').trim().slice(0,20)}"` : `n${n.nodeType}`
      ),
      offsetWidth: c.offsetWidth,
      tableLayoutForCol: c.style.width
    })) : null;
    const tableStyle = {
      tableLayout: table.style.tableLayout,
      width: table.style.width
    };
    return { tableStyle, colgroup: cols, headCells };
  }

  out.scrollHead = snapshotTable(scrollHead, 'scrollHead');
  out.scrollBody = snapshotTable(scrollBody, 'scrollBody');

  // Also peek at the TH at col6 in detail
  const headTh6 = scrollHead?.querySelector('thead tr')?.children?.[6];
  if (headTh6) {
    out.th6_outerHTML = headTh6.outerHTML.slice(0, 600);
    out.th6_innerHTML = headTh6.innerHTML.slice(0, 600);
    out.th6_computed = (() => {
      const cs = window.getComputedStyle(headTh6);
      return { display: cs.display, visibility: cs.visibility, padding: cs.padding, color: cs.color, fontSize: cs.fontSize };
    })();
  }

  return out;
});

writeFileSync(`${OUT}/colgroup.json`, JSON.stringify(info, null, 2));
console.log(JSON.stringify(info, null, 2));
process.exit(0);
