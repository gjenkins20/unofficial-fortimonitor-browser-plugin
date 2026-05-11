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
  // Stub destination pages for click-through nav tests so window.location.href
  // assignments don't 404 against the public origin.
  await page.route(/^https:\/\/fortimonitor\.forticloud\.com\/report\/Instance\//, async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html><body>instance stub</body></html>' });
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

  // ---- Phase 4: interactions + edge states ----

  test('keyboard nav: ArrowDown / ArrowUp highlights rows; Enter navigates', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await enable(page);
    await page.waitForTimeout(120);
    await page.focus('#fmn-omni-search-input');
    await page.keyboard.type('server', { delay: 5 });
    await page.waitForTimeout(350);
    await page.keyboard.press('ArrowDown');
    let active = await page.evaluate(() => document.querySelector('.fmn-omni-row.is-active')?.querySelector('.fmn-omni-row-name')?.textContent);
    expect(active).toBe('server'); // exact-name row 0
    await page.keyboard.press('ArrowDown');
    active = await page.evaluate(() => document.querySelector('.fmn-omni-row.is-active')?.querySelector('.fmn-omni-row-name')?.textContent);
    expect(active).toBe('SQL_Server_01'); // row 1
    await page.keyboard.press('ArrowUp');
    active = await page.evaluate(() => document.querySelector('.fmn-omni-row.is-active')?.querySelector('.fmn-omni-row-name')?.textContent);
    expect(active).toBe('server');
    // Enter -> nav to /report/Instance/1/details
    await Promise.all([page.waitForURL(/\/report\/Instance\/1\/details/, { timeout: 3000 }), page.keyboard.press('Enter')]);
    expect(page.url()).toMatch(/\/report\/Instance\/1\/details/);
    await page.close();
  });

  test('Esc closes the dropdown', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await enable(page);
    await page.waitForTimeout(120);
    await page.fill('#fmn-omni-search-input', 'server');
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => document.getElementById('fmn-omni-search-dropdown')?.classList.contains('is-open'))).toBe(true);
    await page.focus('#fmn-omni-search-input');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.getElementById('fmn-omni-search-dropdown')?.classList.contains('is-open'))).toBe(false);
    await page.close();
  });

  test('click row triggers nav', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await enable(page);
    await page.waitForTimeout(120);
    await page.fill('#fmn-omni-search-input', 'SQL');
    await page.waitForTimeout(350);
    await Promise.all([
      page.waitForURL(/\/report\/Instance\/2\/details/, { timeout: 3000 }),
      page.click('.fmn-omni-row >> nth=0'),
    ]);
    expect(page.url()).toMatch(/\/report\/Instance\/2\/details/);
    await page.close();
  });

  test('click outside container closes the dropdown', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await enable(page);
    await page.waitForTimeout(120);
    await page.fill('#fmn-omni-search-input', 'server');
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => document.getElementById('fmn-omni-search-dropdown')?.classList.contains('is-open'))).toBe(true);
    await page.mouse.click(10, 10); // body outside the container
    await page.waitForTimeout(60);
    expect(await page.evaluate(() => document.getElementById('fmn-omni-search-dropdown')?.classList.contains('is-open'))).toBe(false);
    await page.close();
  });

  test('refresh button fires omni-search:refresh then re-runs the query', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await enable(page);
    await page.waitForTimeout(120);
    await page.fill('#fmn-omni-search-input', 'server');
    await page.waitForTimeout(350);
    await page.evaluate(() => window.__omniHarness.resetCallLog());
    // Use mousedown - the refresh button binds on mousedown to avoid the
    // input blur preventing the click.
    await page.dispatchEvent('.fmn-omni-refresh', 'mousedown');
    await page.waitForTimeout(250);
    const types = await page.evaluate(() => window.__omniHarness.sendMessageCalls.map((c) => c.type));
    expect(types).toContain('omni-search:refresh');
    expect(types).toContain('omni-search:query');
    await page.close();
  });

  test('error from stub surfaces in the dropdown', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await enable(page);
    await page.waitForTimeout(120);
    await page.evaluate(() => window.__omniHarness.failNextQuery());
    await page.fill('#fmn-omni-search-input', 'anything');
    await page.waitForTimeout(350);
    const text = await page.evaluate(() => document.querySelector('#fmn-omni-search-dropdown .fmn-omni-error')?.textContent);
    expect(text).toMatch(/query-failed/);
    await page.close();
  });

  test('no-match query shows "No matches" copy', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await enable(page);
    await page.waitForTimeout(120);
    await page.fill('#fmn-omni-search-input', 'zxqv-nope');
    await page.waitForTimeout(350);
    const text = await page.evaluate(() => document.querySelector('#fmn-omni-search-dropdown .fmn-omni-empty')?.textContent);
    expect(text).toMatch(/No matches/);
    await page.close();
  });

  test('host Vue re-render wipe: container re-mounts and heartbeat keeps ticking (no feedback loop)', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await enable(page);
    await page.waitForTimeout(150);
    // Snapshot heartbeat before the wipe.
    const hb1 = await page.evaluate(() => document.getElementById('hb')?.textContent);
    // Simulate the host stripping our container + the hidden attr.
    await page.evaluate(() => window.__omniHarness.simulateHostRerenderWipe());
    // Wait a bit for the MutationObserver tick + ensureAll re-mount.
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({
      omni: !!document.getElementById('fmn-omni-search-container'),
      nativeHidden: !!document.querySelector('.search-form[data-fmn-omni-search-hidden]'),
      heartbeat: document.getElementById('hb')?.textContent,
      frozen: document.getElementById('hb')?.classList.contains('frozen'),
    }));
    expect(after.omni).toBe(true);
    expect(after.nativeHidden).toBe(true);
    expect(after.frozen).toBe(false);
    expect(after.heartbeat).not.toEqual(hb1);
    await page.close();
  });
});
