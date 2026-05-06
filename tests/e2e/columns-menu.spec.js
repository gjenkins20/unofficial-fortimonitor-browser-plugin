// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-150: in-page "Columns" menu on /report/ListServers.
//
// Drives docs/harnesses/instances-list-columns-menu.html. Routes the live
// FortiMonitor URL to the harness so augment.js's pathname guard fires
// under headless Chromium. No extension load required; augment.js is
// inlined into the harness response.

import { test as base, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.resolve(
  __dirname, '../../docs/harnesses/instances-list-columns-menu.html'
);
const AUGMENT_JS_PATH = path.resolve(
  __dirname, '../../extension/src/content/augment.js'
);
const FORTIMONITOR_URL = 'https://fortimonitor.forticloud.com/report/ListServers';

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
  await page.waitForSelector('#fmn-columns-button');
  return { page, errors };
}

test.describe('In-page Columns menu on /report/ListServers (FMN-150)', () => {
  test('toolkit Columns button mounts into the action bar (right-aligned)', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    const btn = page.locator('#fmn-columns-button');
    await expect(btn).toHaveCount(1);
    // Sibling-of: lives inside #action-bar.
    const parentId = await btn.evaluate((el) => el.parentElement && el.parentElement.id);
    expect(parentId).toBe('action-bar');
    // Carries FM TK chip + label + caret.
    await expect(btn.locator('.fmn-tk-chip')).toHaveText('FM TK');
    await expect(btn).toContainText('Columns');
    await expect(btn.locator('.fmn-caret')).toHaveText('▾');
  });

  test('mount is idempotent: re-running ensureAll does not duplicate the button', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    // Trigger a mutation that fires augment.js's MutationObserver multiple times.
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) {
        const span = document.createElement('span');
        span.textContent = 'noise-' + i;
        document.body.appendChild(span);
      }
    });
    await page.waitForTimeout(50);
    await expect(page.locator('#fmn-columns-button')).toHaveCount(1);
  });

  test('clicking the button opens the popover anchored below it', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await expect(page.locator('#fmn-columns-popover')).toHaveCount(0);
    await page.locator('#fmn-columns-button').click();
    const pop = page.locator('#fmn-columns-popover');
    await expect(pop).toHaveCount(1);
    // Six rows including the locked-visible Instance row.
    await expect(pop.locator('.fmn-columns-popover-row')).toHaveCount(6);
    await expect(pop.locator('.fmn-columns-popover-row.is-locked')).toHaveCount(1);
    // Header text + path context.
    await expect(pop.locator('.fmn-columns-popover-title')).toHaveText('Columns');
    await expect(pop.locator('.fmn-columns-popover-context')).toHaveText('/report/ListServers');
  });

  test('clicking the button a second time closes the popover', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    const btn = page.locator('#fmn-columns-button');
    await btn.click();
    await expect(page.locator('#fmn-columns-popover')).toHaveCount(1);
    await btn.click();
    await expect(page.locator('#fmn-columns-popover')).toHaveCount(0);
  });

  test('clicking outside the popover closes it', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await page.locator('#fmn-columns-button').click();
    await expect(page.locator('#fmn-columns-popover')).toHaveCount(1);
    // Click an inert area (heartbeat panel) outside both the button and popover.
    await page.locator('#hb').click();
    await expect(page.locator('#fmn-columns-popover')).toHaveCount(0);
  });

  test('Escape closes the popover', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await page.locator('#fmn-columns-button').click();
    await expect(page.locator('#fmn-columns-popover')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#fmn-columns-popover')).toHaveCount(0);
  });

  test('toggling a column writes to fm:webguiColumns and re-renders both surfaces', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await page.locator('#fmn-columns-button').click();
    const tagsRow = page.locator('.fmn-columns-popover-row', { hasText: 'Tags' });
    await expect(tagsRow).toHaveCount(1);
    await tagsRow.locator('.fmn-col-toggle').click();
    // Wait for the storage write + onChanged listener + re-render path.
    await page.waitForFunction(() => {
      const cur = window.__harnessStore['fm:webguiColumns'];
      if (!cur || !cur['instances-list-native']) return false;
      const tags = cur['instances-list-native'].find((c) => c.id === 'tags');
      return tags && tags.hidden === true;
    });
    // Row visually marks the column as hidden.
    await expect(tagsRow).toHaveClass(/is-hidden/);
    // The page-side hide also fired: TH at the Tags index has the hide attr.
    const tagsHidden = await page.evaluate(() => {
      const ths = document.querySelectorAll('#instances-table thead th');
      for (const th of ths) {
        if ((th.textContent || '').trim() === 'Tags') {
          return th.hasAttribute('data-fmn-native-hidden');
        }
      }
      return null;
    });
    expect(tagsHidden).toBe(true);
  });

  test('Instance row toggle is disabled (locked-visible)', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await page.locator('#fmn-columns-button').click();
    const instanceRow = page.locator('.fmn-columns-popover-row.is-locked');
    await expect(instanceRow).toHaveCount(1);
    await expect(instanceRow.locator('.fmn-col-toggle')).toBeDisabled();
  });

  test('storage change made elsewhere is mirrored in the open popover', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await page.locator('#fmn-columns-button').click();
    // Simulate the popup card writing to storage while our popover is open.
    await page.evaluate(async () => {
      const KEY = 'fm:webguiColumns';
      const cur = await window.chrome.storage.local.get(KEY);
      const all = (cur && cur[KEY]) || {};
      all['instances-list-native'] = [
        { id: 'instance', hidden: false },
        { id: 'parentGroup', hidden: false },
        { id: 'alertTimeline', hidden: false },
        { id: 'tags', hidden: false },
        { id: 'agentVersion', hidden: true }, // <-- external write
        { id: 'heartbeat', hidden: false },
      ];
      await window.chrome.storage.local.set({ [KEY]: all });
    });
    // Allow the deferred re-render (Promise.resolve().then in subscribe) to flush.
    await page.waitForFunction(() => {
      const row = Array.from(document.querySelectorAll('.fmn-columns-popover-row'))
        .find((r) => (r.textContent || '').includes('Agent Version'));
      return row && row.classList.contains('is-hidden');
    });
  });

  test('Reset to default clears the storage entry', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    // Seed a non-default state.
    await page.evaluate(async () => {
      const KEY = 'fm:webguiColumns';
      await window.chrome.storage.local.set({
        [KEY]: {
          'instances-list-native': [
            { id: 'instance', hidden: false },
            { id: 'parentGroup', hidden: true },
            { id: 'alertTimeline', hidden: false },
            { id: 'tags', hidden: true },
            { id: 'agentVersion', hidden: false },
            { id: 'heartbeat', hidden: false },
          ],
        },
      });
    });
    await page.locator('#fmn-columns-button').click();
    await page.locator('.fmn-columns-popover-reset').click();
    await page.waitForFunction(() => {
      const all = window.__harnessStore['fm:webguiColumns'];
      return !all || !all['instances-list-native'];
    });
  });
});
