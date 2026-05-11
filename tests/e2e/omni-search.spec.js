// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-152 Phase 3 + 4: DOM-harness spec for the omni-search content-script
// UI. Headless Chromium, no FortiMonitor; drives docs/harnesses/omni-search.html
// (chrome.* + sendMessage stubs + a synthetic top-bar fixture) via a routed
// FortiMonitor URL so location.pathname is /report/ListServers and augment.js's
// mount gates are satisfied.

import { test as base, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.resolve(__dirname, '../../docs/harnesses/omni-search.html');
const AUGMENT_JS_PATH = path.resolve(__dirname, '../../extension/src/content/augment.js');
const ROUTED_URL = 'https://fortimonitor.forticloud.com/report/ListServers';

const test = base.extend({
  ctx: [async ({}, use) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
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
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  await page.route(ROUTED_URL, async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: buildHarnessHtml() });
  });
  await page.goto(ROUTED_URL);
  // Wait for augment.js to finish its Promise.all([loadXxxFlag()]).finally(ensureAll).
  await page.waitForTimeout(150);
  return { page, errors };
}

async function enable(page) {
  await page.evaluate(() => window.__omniHarness.setEnabled(true));
  // The storage onChanged listener calls ensureAll which mounts immediately;
  // a microtask is enough but we round up a frame.
  await page.waitForTimeout(60);
}

async function disable(page) {
  await page.evaluate(() => window.__omniHarness.setEnabled(false));
  await page.waitForTimeout(60);
}

test.describe('FMN-152 omni-search content-script UI', () => {
  test('default (flag off): no FM TK container, native search visible', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    const state = await page.evaluate(() => ({
      omni: !!document.getElementById('fmn-omni-search-container'),
      nativeHidden: !!document.querySelector('.search-form[data-fmn-omni-search-hidden]'),
      fmInputPresent: !!document.querySelector('input[placeholder="Search Instances"]'),
    }));
    expect(state).toEqual({ omni: false, nativeHidden: false, fmInputPresent: true });
    expect(errors).toEqual([]);
    await page.close();
  });

  test('toggle off -> on: FM TK injected, native hidden, warm fired', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await enable(page);
    const state = await page.evaluate(() => {
      const calls = window.__omniHarness.sendMessageCalls.map((c) => c.type);
      return {
        omni: !!document.getElementById('fmn-omni-search-container'),
        nativeHidden: !!document.querySelector('.search-form[data-fmn-omni-search-hidden]'),
        chip: !!document.querySelector('.fmn-omni-chip'),
        sentTypes: calls,
      };
    });
    expect(state.omni).toBe(true);
    expect(state.nativeHidden).toBe(true);
    expect(state.chip).toBe(true);
    expect(state.sentTypes).toContain('omni-search:warm');
    await page.close();
  });

  test('toggle on -> off: FM TK removed, native restored', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await enable(page);
    await disable(page);
    const state = await page.evaluate(() => ({
      omni: !!document.getElementById('fmn-omni-search-container'),
      nativeHidden: !!document.querySelector('.search-form[data-fmn-omni-search-hidden]'),
    }));
    expect(state).toEqual({ omni: false, nativeHidden: false });
    await page.close();
  });

  test('warm pulse: chip carries is-warming during fetch then clears', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    // Slow the stub so we can observe the warming state.
    await page.evaluate(() => window.__omniHarness.setWarmDelay(400));
    await enable(page);
    // Right after enable, chip should be pulsing.
    const duringWarm = await page.evaluate(() => !!document.querySelector('.fmn-omni-chip.is-warming'));
    expect(duringWarm).toBe(true);
    // Wait for warm to complete.
    await page.waitForTimeout(600);
    const afterWarm = await page.evaluate(() => !!document.querySelector('.fmn-omni-chip.is-warming'));
    expect(afterWarm).toBe(false);
    await page.close();
  });

  test('debounce: fast typing coalesces into one omni-search:query call', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await enable(page);
    // Wait for warm to finish to keep call counts predictable.
    await page.waitForTimeout(120);
    await page.evaluate(() => window.__omniHarness.resetCallLog());
    // Send several rapid keystrokes WELL inside the 180ms debounce window.
    await page.focus('#fmn-omni-search-input');
    for (const ch of 'serv') {
      await page.keyboard.type(ch, { delay: 20 });
    }
    // 180ms debounce + handler latency
    await page.waitForTimeout(350);
    const queryCalls = await page.evaluate(() =>
      window.__omniHarness.sendMessageCalls.filter((c) => c.type === 'omni-search:query').length
    );
    expect(queryCalls).toBe(1);
    await page.close();
  });

  test('dropdown renders rows, badges, and footer for a real match', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await enable(page);
    await page.waitForTimeout(120);
    await page.fill('#fmn-omni-search-input', 'server');
    await page.waitForTimeout(400);
    const dd = await page.evaluate(() => {
      const d = document.getElementById('fmn-omni-search-dropdown');
      const rows = Array.from(d?.querySelectorAll('.fmn-omni-row') || []).map((r) => ({
        name: r.querySelector('.fmn-omni-row-name')?.textContent,
        badge: r.querySelector('.fmn-omni-badge')?.textContent,
      }));
      return {
        open: d?.classList.contains('is-open'),
        rows,
        footer: d?.querySelector('.fmn-omni-footer span')?.textContent,
      };
    });
    expect(dd.open).toBe(true);
    expect(dd.rows[0]?.name).toBe('server');
    expect(dd.rows[0]?.badge).toBe('name');
    expect(dd.rows.some((r) => r.name === 'SQL_Server_01')).toBe(true);
    expect(dd.footer).toMatch(/\d+ match/);
    await page.close();
  });
});
