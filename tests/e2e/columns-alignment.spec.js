// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-151: column alignment regression for /report/ListServers.
//
// Drives docs/harnesses/instances-list-alignment.html. The harness models
// DataTables's post-first-draw layout: explicit pixel widths on every TH
// and the first body row's TDs, table-layout:fixed, plus a scroll-sync
// handler mirroring scrollLeft from the body container to the head
// clone (what DataTables's fixed-header binding does on real tenants).
//
// The FMN-123 spec exercises the data-fmn-native-hidden attribute path
// but not the visual layout state, so any alignment failure caused by
// the interaction between display:none and the fixed two-table scroll
// layout slips past it. The operator's report ("notice the misalignment
// as you scroll side-to-side") points at scroll-sync, so the spec
// scrolls horizontally after hide operations and re-measures.
//
// True headless: harness-only spec, no extension load needed.
// Per memory playwright_offscreen_window.md Rule 2.

import { test as base, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.resolve(
  __dirname, '../../docs/harnesses/instances-list-alignment.html'
);
const AUGMENT_JS_PATH = path.resolve(
  __dirname, '../../extension/src/content/augment.js'
);
const FORTIMONITOR_URL = 'https://fortimonitor.forticloud.com/report/ListServers';
const SCREENSHOT_DIR = path.resolve(__dirname, '__screenshots__/fmn-151');

const test = base.extend({
  ctx: [async ({}, use) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1400, height: 800 } });
    await use(context);
    await context.close();
    await browser.close();
  }, { scope: 'worker' }]
});

let cachedHtml = null;
function buildHarnessHtml() {
  if (cachedHtml) return cachedHtml;
  const harness = fs.readFileSync(HARNESS_PATH, 'utf-8');
  const augmentJs = fs.readFileSync(AUGMENT_JS_PATH, 'utf-8');
  cachedHtml = harness.replace(
    /<script src="\.\.\/\.\.\/extension\/src\/content\/augment\.js"><\/script>/,
    `<script>\n${augmentJs}\n</script>`
  );
  return cachedHtml;
}

async function gotoHarness(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  await page.route(FORTIMONITOR_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: buildHarnessHtml()
    });
  });
  await page.goto(FORTIMONITOR_URL);
  await page.waitForSelector('tbody tr[data-fmn-ip-row-augmented]');
  return { page, errors };
}

async function pinWidths(page) {
  await page.evaluate(() => window.__pinWidthsLikeDataTables());
}

async function setHidden(page, ids) {
  await page.evaluate((ids) => window.__setHidden(ids), ids);
  await page.waitForTimeout(50);
}

async function scrollBodyTo(page, x) {
  await page.evaluate((x) => window.__scrollBodyTo(x), x);
  await page.waitForTimeout(50);
}

async function measure(page) {
  return page.evaluate(() => window.__measureAlignment());
}

function formatPerColumn(result) {
  const rows = [];
  for (const [id, info] of Object.entries(result.perColumn || {})) {
    rows.push(`  ${id.padEnd(15)}  ${JSON.stringify(info)}`);
  }
  return rows.join('\n');
}

async function captureOnMisalignment(page, label, result) {
  if (!result.anyMisaligned) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const screenshotPath = path.join(SCREENSHOT_DIR, `${label}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.error(`Misalignment captured: ${screenshotPath}\n${formatPerColumn(result)}`);
}

test.describe('Column alignment on /report/ListServers (FMN-151)', () => {
  test('pinned widths, no hide, no scroll: aligned', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await pinWidths(page);
    const result = await measure(page);
    await captureOnMisalignment(page, 'pin-only', result);
    expect(result.anyMisaligned).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('pinned widths, no hide, scrolled to 200px: head follows body via scroll-sync', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await pinWidths(page);
    await scrollBodyTo(page, 200);
    const result = await measure(page);
    await captureOnMisalignment(page, 'scroll-200-no-hide', result);
    expect(result.anyMisaligned).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('pinned widths, hide Tags + Heartbeat, no scroll: surviving columns aligned', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await pinWidths(page);
    await setHidden(page, ['tags', 'heartbeat']);
    const result = await measure(page);
    await captureOnMisalignment(page, 'hide-tags-heartbeat-no-scroll', result);
    expect(result.anyMisaligned).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('pinned widths, hide Parent Group only, no scroll: surviving columns aligned', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await pinWidths(page);
    await setHidden(page, ['parentGroup']);
    const result = await measure(page);
    await captureOnMisalignment(page, 'hide-parent-no-scroll', result);
    expect(result.anyMisaligned).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('pinned widths, hide Tags + Heartbeat, then scroll to 200px: ALIGNED expected (operator report case)', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await pinWidths(page);
    await setHidden(page, ['tags', 'heartbeat']);
    await scrollBodyTo(page, 200);
    const result = await measure(page);
    await captureOnMisalignment(page, 'hide-then-scroll', result);
    expect(result.anyMisaligned).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('pinned widths, scroll to 200px, THEN hide Tags + Heartbeat: surviving columns aligned', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await pinWidths(page);
    await scrollBodyTo(page, 200);
    await setHidden(page, ['tags', 'heartbeat']);
    const result = await measure(page);
    await captureOnMisalignment(page, 'scroll-then-hide', result);
    expect(result.anyMisaligned).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('pinned widths, hide Parent Group only, then scroll to 200px: surviving columns aligned', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await pinWidths(page);
    await setHidden(page, ['parentGroup']);
    await scrollBodyTo(page, 200);
    const result = await measure(page);
    await captureOnMisalignment(page, 'hide-parent-then-scroll', result);
    expect(result.anyMisaligned).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('pinned widths, hide all hideable, then scroll to 200px: surviving columns aligned', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await pinWidths(page);
    await setHidden(page, ['parentGroup', 'alertTimeline', 'tags', 'agentVersion', 'heartbeat']);
    await scrollBodyTo(page, 200);
    const result = await measure(page);
    await captureOnMisalignment(page, 'hide-all-then-scroll', result);
    expect(result.anyMisaligned).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('pinned widths, hide then show all, then scroll: aligned', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await pinWidths(page);
    await setHidden(page, ['parentGroup', 'alertTimeline', 'tags', 'agentVersion', 'heartbeat']);
    await setHidden(page, []);
    await scrollBodyTo(page, 200);
    const result = await measure(page);
    await captureOnMisalignment(page, 'hide-show-scroll', result);
    expect(result.anyMisaligned).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });
});
