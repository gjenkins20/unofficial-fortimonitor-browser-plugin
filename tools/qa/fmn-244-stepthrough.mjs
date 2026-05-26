#!/usr/bin/env node
// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-244 step-through: dispatch the Custom Metrics tour, click Next through
// every step, capture each step card's text, and confirm it reaches the quiz.
// Verifies the rewritten hands-on content matches the live UI.

import { chromium } from '@playwright/test';

const CDP = 'http://localhost:9222';
const FM_CM = 'https://fortimonitor.forticloud.com/config/ListCustomMetrics';
const out = (o) => console.log(JSON.stringify(o));

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const EXT = 'jbiflieljppofckpjmpgdcmchibojfbe';

const fm = ctx.pages().find((p) => p.url().includes('fortimonitor')) || await ctx.newPage();
await fm.goto(FM_CM, { waitUntil: 'domcontentloaded' }).catch(() => {});
await fm.waitForFunction(() => !/caching, please wait/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
await fm.waitForTimeout(1000);

// dispatch via a popup page's runtime (flag already enabled from prior probe)
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${EXT}/src/popup/popup.html`, { waitUntil: 'domcontentloaded' });
await popup.evaluate(() => new Promise((r) => chrome.storage.local.set({ 'fm:customMetricsTourEnabled': true }, r)));
await popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'fm:custom-metrics-tour:start' }, () => r())));
await fm.waitForTimeout(2000);

// step-card text reader: find the visible element that holds the caption + a Next/Done button
function readCard() {
  const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent && /next|done|finish|start quiz|got it/i.test(b.textContent));
  if (!btns.length) return null;
  // climb to a container that has substantial caption text
  let el = btns[0];
  for (let i = 0; i < 6 && el.parentElement; i++) {
    el = el.parentElement;
    if (el.innerText && el.innerText.replace(/\s+/g, ' ').length > 60) break;
  }
  return el.innerText.replace(/\s+/g, ' ').trim().slice(0, 320);
}

const seen = [];
for (let i = 0; i < 12; i++) {
  const text = await fm.evaluate(readCard);
  const onQuiz = await fm.evaluate(() => /which|\bA custom metric is the right tool\b|Metric Configuration\) is where|configured:/i.test(document.body.innerText) && !!document.querySelector('input[type="radio"]'));
  seen.push({ step: i, text, quizVisible: onQuiz });
  if (onQuiz) break;
  // click Next
  const clicked = await fm.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.offsetParent && /^\s*(next|done|finish|start quiz)\s*$/i.test(x.textContent));
    if (b) { b.click(); return b.textContent.trim(); }
    return null;
  });
  if (!clicked) { seen.push({ step: i, note: 'no Next button found - stopping' }); break; }
  await fm.waitForTimeout(900);
}
for (const s of seen) out(s);
await fm.screenshot({ path: '/tmp/fmn-244-final-step.png' }).catch(() => {});

// content assertions across the whole run
const joined = seen.map((s) => s.text || '').join(' || ');
out({
  stage: 'assertions',
  mentionsAdvancedMetrics: /Advanced Metrics/i.test(joined),
  mentionsRealFields: /Plugin Textkey/i.test(joined) && /Metric Type/i.test(joined) && /(Number|Boolean|Percent)/i.test(joined),
  thresholdsPerInstance: /per-instance|attached to an instance|Monitoring Policy/i.test(joined),
  noFabricatedConcerns: !/Data source:/i.test(joined) && !/Identity:/i.test(joined),
  noBareBreach: !/breach(?![\s\S]{0,120}threshold)/i.test(joined),
  reachedQuiz: seen.some((s) => s.quizVisible),
});
await browser.close();
