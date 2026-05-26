#!/usr/bin/env node
// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-253 live verification: reproduce the silent-no-op bug and confirm the
// fix. Steps:
//   1. Load /config/ListCustomMetrics with a healthy bridge; drop a sentinel
//      on the page window.
//   2. Reload the EXTENSION ONLY (not the tab) -> orphans the tab's
//      content-script bridge, exactly like an extension update with a tab
//      already open. The page (and sentinel) survive; the bridge does not.
//   3. From a fresh popup, dispatch the Custom Metrics tour.
//   4. Expect: the dispatcher sees zero deliveries, reloads the FM tab
//      (sentinel disappears), redispatches, and the tour renders.
// Pass = sentinel gone (tab was reloaded) AND tour card present.

import { chromium } from '@playwright/test';

const CDP = 'http://localhost:9222';
const EXT = 'jbiflieljppofckpjmpgdcmchibojfbe';
const FM_CM = 'https://fortimonitor.forticloud.com/config/ListCustomMetrics';
const out = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];

// 1. healthy FM tab + sentinel
let fm = ctx.pages().find((p) => p.url().includes('fortimonitor')) || await ctx.newPage();
await fm.goto(FM_CM, { waitUntil: 'domcontentloaded' }).catch(() => {});
await fm.waitForFunction(() => !/caching, please wait/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
await fm.waitForTimeout(1000);
await fm.evaluate(() => { window.__fmn253 = 'before-reload'; });
const sentinelSet = await fm.evaluate(() => window.__fmn253);
out({ stage: 'setup', url: fm.url(), sentinelSet });

// 2. reload extension ONLY (orphans the tab's bridge)
const sw = ctx.serviceWorkers().find((s) => s.url().includes(EXT));
out({ stage: 'reload-extension', swFound: !!sw });
try { await sw.evaluate(() => chrome.runtime.reload()); } catch { /* SW context torn down by reload - expected */ }
await sleep(3500); // let the new SW register

// sentinel should still be present here (extension reload does NOT reload the page)
const sentinelAfterExtReload = await fm.evaluate(() => window.__fmn253).catch(() => 'PAGE-GONE');
out({ stage: 'post-ext-reload', sentinelStillThere: sentinelAfterExtReload });

// 3. fresh popup -> enable flag -> dispatch
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${EXT}/src/popup/popup.html`, { waitUntil: 'domcontentloaded' });
await popup.evaluate(() => new Promise((r) => chrome.storage.local.set({ 'fm:customMetricsTourEnabled': true }, r)));
await popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'fm:custom-metrics-tour:start' }, () => r())));

// 4. wait for the fallback: tab reload + load + redispatch + tour render
await sleep(6000);
const result = await fm.evaluate(() => ({
  sentinel: window.__fmn253 ?? null,             // null => the tab was reloaded by the fix
  hasTourCopy: /custom metric is, when to reach for one/i.test(document.body.innerText),
  url: location.href,
})).catch((e) => ({ err: String(e).slice(0, 80) }));
out({ stage: 'result', ...result,
  PASS: result.sentinel === null && result.hasTourCopy === true });

await fm.screenshot({ path: '/tmp/fmn-253-recovered-tour.png' }).catch(() => {});
await browser.close();
