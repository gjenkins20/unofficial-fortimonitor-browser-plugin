#!/usr/bin/env node
// Hot-reload the extension in place via the existing fm:dev-reload-extension
// bridge (FMN-85). Does NOT kill the Chromium process or invalidate the
// FortiMonitor session - the operator's logged-in tab survives. Content
// scripts in OPEN tabs need a tab reload to re-inject after extension
// reload; this script does that for any fortimonitor.* tab.
//
// Use this instead of kill+relaunch for picking up augment.js or
// service-worker.js edits.

import { chromium } from '@playwright/test';

const CDP = process.env.FMN_CDP_PORT
  ? `http://localhost:${process.env.FMN_CDP_PORT}`
  : 'http://localhost:9222';

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];

// Wake the SW so we can send a message to it. Pages with content scripts
// keep it alive when active.
let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
if (!sw) {
  console.log('SW idle. Waking by sending a runtime ping from an extension page...');
  // Open the extension popup briefly to wake the SW.
  // The extension ID is in service-worker.js path of any SW the context has.
  // If we have NO SW reference at all, try the fortimonitor tab approach.
  const page = ctx.pages().find((p) => p.url().startsWith('https://'));
  if (page) {
    // Trigger a tiny no-op via the content script's chrome.runtime.
    // Page-context can't call chrome.runtime, but reloading the page
    // re-injects the content script, which sends nothing on its own but
    // forces the SW to start to handle install. Simpler: just wait and
    // hope for SW to come up after CDP poll.
    await page.bringToFront().catch(() => {});
  }
  // Wait for SW to appear via event.
  sw = await ctx.waitForEvent('serviceworker', { timeout: 8000 }).catch(() => null);
}
if (!sw) {
  console.error('Could not locate or wake the SW. Try interacting with the FortiMonitor tab first.');
  process.exit(1);
}

console.log('Reloading extension via chrome.runtime.reload()...');
// reload() tears down the SW, so this evaluate will reject; ignore.
sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
// Wait for the fresh SW.
const fresh = await ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
if (fresh) {
  console.log('New SW registered:', fresh.url());
} else {
  console.log('No new SW event observed; extension may still be reloading.');
}

// Reload any FortiMonitor tab so the new content script (augment.js)
// re-injects. The session cookie persists; this is just a page reload.
for (const page of ctx.pages()) {
  if (!page.url().includes('fortimonitor')) continue;
  console.log('Reloading FortiMonitor tab:', page.url());
  await page.reload({ waitUntil: 'domcontentloaded' });
}

console.log('Done. Extension reloaded; session preserved.');
await browser.close();
