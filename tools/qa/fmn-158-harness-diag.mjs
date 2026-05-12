#!/usr/bin/env node
// FMN-158: diagnose why tests/e2e/native-column-hide-show.spec.js is
// currently timing out on `tbody tr[data-fmn-ip-row-augmented]`.
// Pre-existing failure on clean main; this probe is just for context.

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = '/Users/gregorijenkins/Projects/unofficial-fortimonitor-browser-plugin';
const harness = readFileSync(resolve(ROOT, 'docs/harnesses/instances-list-native-hide.html'), 'utf-8');
const augment = readFileSync(resolve(ROOT, 'extension/src/content/augment.js'), 'utf-8');
const html = harness.replace(
  /<script src="\.\.\/\.\.\/extension\/src\/content\/augment\.js"><\/script>/,
  `<script>\n${augment}\n</script>`
);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

await page.route('https://fortimonitor.forticloud.com/report/ListServers', async (r) => {
  await r.fulfill({ status: 200, contentType: 'text/html', body: html });
});
await page.goto('https://fortimonitor.forticloud.com/report/ListServers');
await page.waitForTimeout(3000);

const status = await page.evaluate(() => ({
  pathname: location.pathname,
  rows: document.querySelectorAll('table.pa-table_outage tbody tr').length,
  rowsWithCheckbox: document.querySelectorAll('table.pa-table_outage tbody tr input.pa-table-row-checkbox').length,
  augmented: document.querySelectorAll('tr[data-fmn-ip-row-augmented]').length,
  tables: document.querySelectorAll('table.pa-table_outage').length,
  hasChromeStub: !!window.chrome,
  hasInstanceCol: document.querySelectorAll('td.instance-column').length
}));
console.log('status:', JSON.stringify(status, null, 2));
console.log('errors:', errs);

await browser.close();
