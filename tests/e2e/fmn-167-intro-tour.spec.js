// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-167: headless Playwright spec for the intro-tour engine + renderer.
//
// Drives docs/harnesses/intro-tour-harness.html (a fake FortiMonitor
// sidebar with the exact selector the stub anchors against). Pure
// headless, no extension load needed - the engine and renderer modules
// import via ES modules from extension/src/ui/intro-tour/.
//
// Verification posture per Verification Discipline #2: this is the
// synthetic-harness path. Operator captures the live FortiMonitor
// screenshot during review.

import { test as base, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.resolve(
  __dirname, '../../docs/harnesses/intro-tour-harness.html'
);
const HARNESS_URL = `file://${HARNESS_PATH}`;

const test = base.extend({
  ctx: [async ({}, use) => {
    const browser = await chromium.launch({
      headless: true,
      // file:// modules need this flag to resolve sibling ES-module
      // imports without an HTTP server.
      args: ['--allow-file-access-from-files']
    });
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await use(context);
    await context.close();
    await browser.close();
  }, { scope: 'worker' }]
});

async function gotoHarness(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => window.__harnessReady === true);
  return { page, errors };
}

test.describe('FMN-167 intro tour engine + renderer (headless harness)', () => {
  test('Start tour mounts an overlay with caption + Next button', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await page.locator('[data-test="start-tour"]').click();

    const overlay = page.locator('.fmn-tour-overlay');
    // Overlay host is a 0x0 positioned container; its children are
    // absolutely positioned. Assert attached + the card visible.
    await expect(overlay).toBeAttached();
    await expect(overlay).toHaveAttribute('data-fmn-tour-step', 'dashboards-welcome');

    const card = overlay.locator('.fmn-tour-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.fmn-tour-card-body')).toContainText('Welcome');
    await expect(card.locator('.fmn-tour-next')).toBeVisible();
    await expect(card.locator('.fmn-tour-dismiss')).toBeVisible();

    expect(errors).toEqual([]);
    await page.close();
  });

  test('Spotlight positions over the anchor node', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await page.locator('[data-test="start-tour"]').click();

    const spotlight = page.locator('.fmn-tour-spotlight');
    await expect(spotlight).toBeVisible();

    // The spotlight should roughly overlap the first nav item. Compare
    // bounding rects with a generous tolerance (the spotlight adds
    // padding so the boxes are intentionally slightly different).
    const anchorBox = await page.locator('li.pa-side-nav__top-level-item').first().boundingBox();
    const spotlightBox = await spotlight.boundingBox();
    expect(anchorBox).not.toBeNull();
    expect(spotlightBox).not.toBeNull();
    // Spotlight encloses the anchor (with padding) - so its top is at or
    // above the anchor's top, and its bottom is at or below.
    expect(spotlightBox.y).toBeLessThanOrEqual(anchorBox.y + 1);
    expect(spotlightBox.y + spotlightBox.height).toBeGreaterThanOrEqual(
      anchorBox.y + anchorBox.height - 1
    );

    await page.close();
  });

  test('Clicking Next on the single-step tour fires onComplete and tears down', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await page.locator('[data-test="start-tour"]').click();
    await expect(page.locator('.fmn-tour-overlay')).toBeAttached();
    await expect(page.locator('.fmn-tour-card')).toBeVisible();

    await page.locator('.fmn-tour-next').click();

    // Overlay removed, completion logged in the event log.
    await expect(page.locator('.fmn-tour-overlay')).toHaveCount(0);
    await expect(page.locator('[data-test="event-log"]')).toContainText('onComplete fired');
  });

  test('Clicking Dismiss tears the overlay down without onComplete', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await page.locator('[data-test="start-tour"]').click();
    await page.locator('.fmn-tour-dismiss').click();
    await expect(page.locator('.fmn-tour-overlay')).toHaveCount(0);
    await expect(page.locator('[data-test="event-log"]')).toContainText('onDismiss fired');
    await expect(page.locator('[data-test="event-log"]')).not.toContainText('onComplete fired');
  });

  test('Multi-step tour: Next advances and onAdvance is invoked per step', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await page.locator('[data-test="start-multi"]').click();

    // Step 1
    await expect(page.locator('.fmn-tour-overlay')).toHaveAttribute('data-fmn-tour-step', 'step-1-dashboards');

    await page.locator('.fmn-tour-next').click();
    await expect(page.locator('.fmn-tour-overlay')).toHaveAttribute('data-fmn-tour-step', 'step-2-instances');
    await expect(page.locator('[data-test="event-log"]')).toContainText('onAdvance step-1-dashboards -> step-2-instances');

    await page.locator('.fmn-tour-next').click();
    await expect(page.locator('.fmn-tour-overlay')).toHaveAttribute('data-fmn-tour-step', 'step-3-alerts');
    await expect(page.locator('[data-test="event-log"]')).toContainText('onAdvance step-2-instances -> step-3-alerts');

    // Final Next completes.
    await page.locator('.fmn-tour-next').click();
    await expect(page.locator('.fmn-tour-overlay')).toHaveCount(0);
    await expect(page.locator('[data-test="event-log"]')).toContainText('onComplete fired');
  });

  test('Caption HTML is rendered (sanitized) with allowed tags surviving', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await page.locator('[data-test="start-tour"]').click();
    const card = page.locator('.fmn-tour-card-body');
    await expect(card.locator('strong')).toContainText('Welcome');
    // No <script> should ever survive (none in the fixture, but guard).
    await expect(card.locator('script')).toHaveCount(0);
  });

  test('validateStep export reachable from the harness page', async ({ ctx }) => {
    const { page } = await gotoHarness(ctx);
    await page.locator('[data-test="validate-good"]').click();
    await expect(page.locator('[data-test="event-log"]')).toContainText('validate good: ok=true');
    await page.locator('[data-test="validate-bad"]').click();
    await expect(page.locator('[data-test="event-log"]')).toContainText('validate bad: ok=false');
  });
});
