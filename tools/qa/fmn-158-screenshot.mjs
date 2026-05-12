#!/usr/bin/env node
// FMN-158: capture before/after screenshots from the live tenant.
// Walks: (a) hide Tags + screenshot, (b) show Tags + screenshot, (c) hide
// again + screenshot. The operator's pre-existing storage state has tags
// hidden, so (a) and (c) reflect their on-page experience; (b) shows what
// Tags content looks like for visual reference.
//
// Restores the operator's original storage on exit.

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const CDP = 'http://localhost:9222';
const OUT = '/tmp/fmn-qa/fmn-158';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));

const page = ctx.pages().find((p) => p.url().includes('/report/ListServers'));
if (!page) { console.error('No /report/ListServers tab'); process.exit(1); }
await page.bringToFront();
await page.waitForSelector('table.pa-table_outage tbody tr input.pa-table-row-checkbox', { timeout: 15_000 });

async function readStorage() {
  return await sw.evaluate(() => new Promise((r) =>
    chrome.storage.local.get('fm:webguiColumns', (d) => r(d?.['fm:webguiColumns']?.['instances-list-native']))));
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
const tagsHidden = original.map((c) => c.id === 'tags' ? { ...c, hidden: true } : c);
const tagsShown  = original.map((c) => c.id === 'tags' ? { ...c, hidden: false } : c);

await writeStorage(tagsHidden);
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/03-tags-hidden-collapsed.png`, fullPage: false });

await writeStorage(tagsShown);
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/04-tags-shown.png`, fullPage: false });

await writeStorage(original);
await page.waitForTimeout(500);

console.log('Wrote', `${OUT}/03-tags-hidden-collapsed.png`, 'and', `${OUT}/04-tags-shown.png`);
console.log('Storage restored to original:', JSON.stringify(original));
