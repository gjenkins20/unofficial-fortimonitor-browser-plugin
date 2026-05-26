#!/usr/bin/env node
// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-244 live capture: connect to the running dev launcher (CDP :9222),
// confirm auth, capture the REAL Custom Metrics page + Add Custom Metric
// dialog + the row kebab menu so the training tour anchors/copy match live UI
// and we can locate where thresholds are configured (the dialog has none).
// Read-only: opens the dialog/menu to read, never clicks Save / Delete / menu items.

import { chromium } from '@playwright/test';

const CDP = 'http://localhost:9222';
const LIST_URL = 'https://fortimonitor.forticloud.com/config/ListCustomMetrics';
const out = (o) => console.log(JSON.stringify(o));

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('fortimonitor')) || ctx.pages()[0] || (await ctx.newPage());

await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
// wait out the "Caching, please wait..." banner
await page.waitForFunction(() => !/caching, please wait/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);

out({ stage: 'auth', url: page.url() });

// --- open Add Custom Metric dialog ---
await page.locator('button:has-text("Add Custom Metric")').first().click().catch((e) => out({ clickErr: String(e).slice(0, 80) }));
await page.waitForFunction(() => /metric configuration/i.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(1200);

const dialog = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('*'));
  const panel = all.find((d) => /metric configuration/i.test(d.textContent || '') &&
    d.querySelector('input,select') &&
    (d.className || '').length && d.getBoundingClientRect().width > 200 && d.getBoundingClientRect().width < 700);
  const scope = panel || document;
  const labels = Array.from(scope.querySelectorAll('label, [class*="label"]'))
    .map((l) => l.textContent.trim().replace(/\s+/g, ' ')).filter((t) => t && t.length < 50);
  const fields = Array.from(scope.querySelectorAll('input,select,textarea'))
    .filter((i) => i.offsetParent !== null)
    .map((i) => ({
      tag: i.tagName, type: i.type || null, name: i.name || null, id: i.id || null,
      required: i.required || i.getAttribute('aria-required') === 'true' || null,
      options: i.tagName === 'SELECT' ? Array.from(i.options).map((o) => o.textContent.trim()).filter(Boolean).slice(0, 15) : undefined,
    }));
  const buttons = Array.from(scope.querySelectorAll('button')).map((b) => b.textContent.trim()).filter((t) => t && t.length < 24).slice(0, 10);
  return {
    panelFound: !!panel,
    labels: [...new Set(labels)],
    fields,
    buttons: [...new Set(buttons)],
    mentionsThreshold: /threshold|severity|warning|critical|alert/i.test(scope.textContent || ''),
  };
});
out({ stage: 'dialog', ...dialog });
await page.screenshot({ path: '/tmp/fmn-244-add-dialog.png' }).catch(() => {});

// close dialog (Escape / Cancel) then inspect a row kebab menu for threshold-related actions
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(800);
const kebab = page.locator('table tbody tr', { hasNot: page.locator('th') }).first().locator('button, [class*="kebab"], [class*="menu"], svg').last();
await kebab.click().catch(() => {});
await page.waitForTimeout(900);
const menu = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('[role="menuitem"], .pa-menu a, .dropdown-menu a, [class*="menu"] a, [class*="menu"] button, li'))
    .map((e) => e.textContent.trim().replace(/\s+/g, ' ')).filter((t) => t && t.length < 40 && t.length > 1);
  return [...new Set(items)].slice(0, 25);
});
out({ stage: 'rowMenu', items: menu });
await page.screenshot({ path: '/tmp/fmn-244-row-menu.png' }).catch(() => {});

out({ stage: 'done' });
await browser.close();
