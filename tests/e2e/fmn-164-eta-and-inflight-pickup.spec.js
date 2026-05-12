// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-164: stubbed Playwright spec for the snapshot card's tenant-size-aware
// ETA + in-flight resume on card mount. Headless Chromium, no live FM, no
// extension fixture - the harness routes the FortiMonitor URL to a static
// HTML page that stubs chrome.runtime + chrome.storage and mounts augment.js.
//
// Run: npx playwright test tests/e2e/fmn-164-eta-and-inflight-pickup.spec.js

import { test as base, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.resolve(__dirname, '../../docs/harnesses/snapshot-card-eta.html');
const AUGMENT_JS_PATH = path.resolve(__dirname, '../../extension/src/content/augment.js');
const ROUTED_URL = 'https://fortimonitor.forticloud.com/report/ListReports';
const CARD_SELECTOR = '[data-fmn-entry="fmn-snapshot-diff-card"]';
const META_SELECTOR = `${CARD_SELECTOR} .fmn-snapshot-meta`;

const test = base.extend({
  ctx: [async ({}, use) => {
    // Pure headless - no extension fixture, no offscreen window argument
    // dance. Per playwright_offscreen_window.md: tests that don't need
    // the MV3 extension loaded should use true headless.
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await use(context);
    await context.close();
    await browser.close();
  }, { scope: 'worker' }],
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
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: buildHarnessHtml(),
    });
  });
  await page.goto(ROUTED_URL);
  // Wait for augment.js's Promise.all([loadXxxFlag()]).finally(ensureAll) to settle.
  await page.waitForTimeout(150);
  return { page, errors };
}

async function enableAndMount(page) {
  await page.evaluate(() => window.__snapshotHarness.enable());
  // Storage onChanged listener runs ensureAll synchronously, which paints
  // the card; a microtask + small idle is enough.
  await page.waitForSelector(CARD_SELECTOR, { timeout: 5_000 });
  // Wait for the meta line to update past 'Loading...' (refreshSnapshotCardMeta
  // runs async).
  await page.waitForFunction(
    () => {
      const m = document.querySelector(
        '[data-fmn-entry="fmn-snapshot-diff-card"] .fmn-snapshot-meta'
      );
      return m && m.textContent.trim() && m.textContent.trim() !== 'Loading...';
    },
    { timeout: 5_000 }
  );
}

test.describe('FMN-164: tenant-size-aware ETA + in-flight pickup', () => {

  test('no prior snapshot -> "No snapshot yet · ~180s estimated (first run) · saved on this Chrome only"', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await page.evaluate(() => {
      window.__snapshotHarness.setStatus({ hasCurrent: false, hasPrevious: false, runInFlight: false });
      window.__snapshotHarness.setEstimate({ estimatedSeconds: 180, basedOn: 'default', lastServerCount: null });
    });
    await enableAndMount(page);

    const meta = await page.locator(META_SELECTOR).textContent();
    expect(meta).toContain('No snapshot yet');
    expect(meta).toContain('~180s estimated (first run)');
    expect(meta).toContain('saved on this Chrome only');
    expect(errors).toEqual([]);
  });

  test('in-flight pickup: card mounts while a run is in progress -> elapsed counter, not "No snapshot yet"', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    // Pretend a run started 47 seconds ago and the SW (or persisted
    // session state) is reporting runInFlight=true.
    const startedAt = Date.now() - 47_000;
    await page.evaluate((startedAtArg) => {
      window.__snapshotHarness.setStatus({
        hasCurrent: false,
        hasPrevious: false,
        runInFlight: true,
        runStartedAt: startedAtArg,
      });
      // Estimate would be returned too but the in-flight branch must
      // not paint the estimate text - it paints the elapsed counter.
      window.__snapshotHarness.setEstimate({
        estimatedSeconds: 180,
        basedOn: 'default',
        lastServerCount: null,
      });
    }, startedAt);
    await page.evaluate(() => window.__snapshotHarness.enable());
    await page.waitForSelector(CARD_SELECTOR, { timeout: 5_000 });
    // Wait for the running banner to render. The elapsed counter starts
    // at ~47s (since startedAt was 47s ago).
    await page.waitForFunction(
      () => {
        const m = document.querySelector(
          '[data-fmn-entry="fmn-snapshot-diff-card"] .fmn-snapshot-meta'
        );
        return m && /Taking a snapshot\.\.\./.test(m.textContent);
      },
      { timeout: 5_000 }
    );

    const r = await page.evaluate(() => {
      const meta = document.querySelector(
        '[data-fmn-entry="fmn-snapshot-diff-card"] .fmn-snapshot-meta'
      );
      return {
        text: meta?.textContent ?? '',
        hasRunningClass: meta?.classList.contains('fmn-snapshot-meta-running') ?? false,
      };
    });
    expect(r.text).toMatch(/Taking a snapshot\.\.\. \d+:\d{2} elapsed · safe to leave page/);
    // Must NOT be the stale "No snapshot yet" string. The whole point of
    // the in-flight resume.
    expect(r.text).not.toContain('No snapshot yet');
    expect(r.hasRunningClass).toBe(true);

    // Parse the m:ss out of the meta text and verify it's at least 47s.
    const m = r.text.match(/(\d+):(\d{2}) elapsed/);
    expect(m).not.toBeNull();
    const elapsed = Number(m[1]) * 60 + Number(m[2]);
    expect(elapsed).toBeGreaterThanOrEqual(46);
    // Should not be wildly in the future either.
    expect(elapsed).toBeLessThan(120);

    expect(errors).toEqual([]);
  });

  test('after a snapshot exists with last-run timing: "Last: ts · last took Xs next · this Chrome only"', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await page.evaluate(() => {
      window.__snapshotHarness.setStatus({
        hasCurrent: true,
        hasPrevious: false,
        currentTakenAt: '2026-05-10T18:00:00.000Z',
        previousTakenAt: null,
        runInFlight: false,
      });
      window.__snapshotHarness.setEstimate({
        estimatedSeconds: 240,
        basedOn: 'last-run',
        lastServerCount: 150,
      });
    });
    await enableAndMount(page);

    const meta = await page.locator(META_SELECTOR).textContent();
    expect(meta).toContain('Last:');
    expect(meta).toContain('last took 240s next');
    expect(meta).toContain('this Chrome only');
    expect(meta).not.toContain('No snapshot yet');
    expect(errors).toEqual([]);
  });
});
