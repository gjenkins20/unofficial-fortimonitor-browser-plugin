#!/usr/bin/env node
// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Live verification (CDP :9222):
//   FMN-246 - Training drill-in no longer renders on top of #main-view
//             (the duplicate "Training" bug); launcher/back navigation works.
//   FMN-244 - Custom Metrics tour launches on /config/ListCustomMetrics and
//             renders the rewritten, live-accurate copy.

import { chromium } from '@playwright/test';

const CDP = 'http://localhost:9222';
const EXT = 'jbiflieljppofckpjmpgdcmchibojfbe';
const POPUP = `chrome-extension://${EXT}/src/popup/popup.html`;
const FM_CM = 'https://fortimonitor.forticloud.com/config/ListCustomMetrics';
const out = (o) => console.log(JSON.stringify(o));

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];

// ---------- FMN-246: popup drill-in ----------
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 420, height: 640 }); // memory: popup_tests_need_small_viewport
await popup.goto(POPUP, { waitUntil: 'domcontentloaded' });
await popup.waitForTimeout(900);

const onLoad = await popup.evaluate(() => {
  const disp = (id) => {
    const el = document.getElementById(id);
    return el ? getComputedStyle(el).display : 'MISSING';
  };
  const visibleTrainingText = Array.from(document.querySelectorAll('#training-launcher-tile, #training-view .subview-title'))
    .filter((el) => el.offsetParent !== null)
    .map((el) => el.id || el.className);
  return { mainView: disp('main-view'), trainingView: disp('training-view'), visibleTraining: visibleTrainingText };
});
out({ stage: 'FMN-246 first-paint', ...onLoad,
  PASS: onLoad.trainingView === 'none' && onLoad.mainView !== 'none' && onLoad.visibleTraining.length === 1 });

await popup.locator('#training-launcher-tile').click().catch(() => {});
await popup.waitForTimeout(500);
const afterDrill = await popup.evaluate(() => ({
  mainView: getComputedStyle(document.getElementById('main-view')).display,
  trainingView: getComputedStyle(document.getElementById('training-view')).display,
  introTileVisible: !!document.getElementById('training-intro-tour-tile')?.offsetParent,
}));
out({ stage: 'FMN-246 after drill-in', ...afterDrill,
  PASS: afterDrill.trainingView !== 'none' && afterDrill.mainView === 'none' });

await popup.locator('#training-back').click().catch(() => {});
await popup.waitForTimeout(400);
const afterBack = await popup.evaluate(() => ({
  mainView: getComputedStyle(document.getElementById('main-view')).display,
  trainingView: getComputedStyle(document.getElementById('training-view')).display,
}));
out({ stage: 'FMN-246 after back', ...afterBack,
  PASS: afterBack.trainingView === 'none' && afterBack.mainView !== 'none' });
await popup.screenshot({ path: '/tmp/fmn-246-popup.png' }).catch(() => {});

// ---------- FMN-244: tour launches with rewritten copy ----------
const fm = ctx.pages().find((p) => p.url().includes('fortimonitor')) || await ctx.newPage();
await fm.goto(FM_CM, { waitUntil: 'domcontentloaded' }).catch(() => {});
await fm.waitForFunction(() => !/caching, please wait/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
await fm.waitForTimeout(1200);

// enable the flag then dispatch start via the extension runtime (same path the popup tile uses)
await popup.evaluate(() => new Promise((r) => chrome.storage.local.set({ 'fm:customMetricsTourEnabled': true }, r)));
await popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'fm:custom-metrics-tour:start' }, () => r())));
await fm.waitForTimeout(2500);

const tour = await fm.evaluate(() => {
  const card = document.querySelector('[class*="tour"], [class*="intro-tour"], [id*="tour"], [class*="spotlight"]');
  const text = document.body.innerText;
  return {
    tourCardPresent: !!card,
    hasWelcomeCopy: /custom metric is, when to reach for one/i.test(text),
    cardSnippet: card ? card.innerText.replace(/\s+/g, ' ').slice(0, 220) : null,
  };
});
out({ stage: 'FMN-244 tour launch', url: fm.url(), ...tour });
await fm.screenshot({ path: '/tmp/fmn-244-tour-step1.png' }).catch(() => {});

out({ stage: 'done' });
await browser.close();
