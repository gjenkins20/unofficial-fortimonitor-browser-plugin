// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-169: info bubbles on hover with master toggle + per-feature dismiss.
//
// True headless: no extension load needed (per memory
// playwright_offscreen_window.md Rule 2). Two scenarios:
//
//   1. Popup surface - imports the ES module info-bubble.js, mounts
//      against a fixture (bulk-composer tile, update banner). Verifies
//      hover → bubble appears, escape dismiss, "× don't show me this
//      again" persists, global toggle off suppresses, global toggle
//      on preserves per-feature dismissals.
//
//   2. Augment.js surface - routes the live FortiMonitor URL to a
//      synthetic harness that inlines augment.js. Verifies bubbles
//      attach to the omni-search chip / Columns button / IP-DNS
//      sub-header / Snapshot card ribbon, and the heartbeat counter
//      does NOT freeze (no MutationObserver feedback loop a la FMN-72).

import { test as base, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const POPUP_FIXTURE_PATH = path.resolve(REPO_ROOT, 'docs/harnesses/info-bubble-popup-fixture.html');
const POPUP_FIXTURE_URL = 'file://' + POPUP_FIXTURE_PATH;
const AUGMENT_FIXTURE_PATH = path.resolve(REPO_ROOT, 'docs/harnesses/info-bubble-augment-fixture.html');
const AUGMENT_JS_PATH = path.resolve(REPO_ROOT, 'extension/src/content/augment.js');
const FORTIMONITOR_URL = 'https://fortimonitor.forticloud.com/report/ListServers';

const test = base.extend({
  ctx: [async ({}, use) => {
    const browser = await chromium.launch({
      headless: true,
      args: ['--allow-file-access-from-files']
    });
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await use(context);
    await context.close();
    await browser.close();
  }, { scope: 'worker' }]
});

// ============================================================================
// Scenario 1: popup surface
// ============================================================================

test.describe('FMN-169 popup surface (ES module mount)', () => {
  async function gotoPopup(ctx) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });
    await page.goto(POPUP_FIXTURE_URL);
    // Wait for the module's import to land and expose the harness hook.
    await page.waitForFunction(() => typeof window.__mountInfoBubbles === 'function', null, { timeout: 5000 });
    return { page, errors };
  }

  test('mount adds an icon next to the Bulk Composer tile name', async ({ ctx }) => {
    const { page, errors } = await gotoPopup(ctx);
    await page.evaluate(() => window.__mountInfoBubbles('popup'));
    // Icon should be a child of .tool-name (mountTarget: append).
    const iconCount = await page.locator('.tool-card[data-tool="bulk-composer"] .tool-name .fmn-info-bubble-icon').count();
    expect(iconCount).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('hovering the icon shows a bubble with the title, body, Learn more link, and dismiss button', async ({ ctx }) => {
    const { page } = await gotoPopup(ctx);
    await page.evaluate(() => window.__mountInfoBubbles('popup'));
    const icon = page.locator('.tool-card[data-tool="bulk-composer"] .tool-name .fmn-info-bubble-icon');
    await icon.hover();
    // Hover delay is 0 in the harness; wait for the bubble to appear.
    const bubble = page.locator('.fmn-info-bubble[data-fmn-info-bubble-feature="bulk-composer"]');
    await expect(bubble).toBeVisible();
    await expect(bubble.locator('.fmn-info-bubble-title')).toHaveText('Bulk Action Composer');
    const bodyText = await bubble.locator('.fmn-info-bubble-body').textContent();
    expect(bodyText).toContain('Add Tag');
    const learn = bubble.locator('a.fmn-info-bubble-learn');
    await expect(learn).toHaveAttribute('href', /docs\/planning\/bulk-composer\.md$/);
    await expect(learn).toHaveAttribute('target', '_blank');
    const dismiss = bubble.locator('button.fmn-info-bubble-dismiss');
    await expect(dismiss).toContainText("don't show me this again");
    await page.close();
  });

  test('Escape dismisses an open bubble', async ({ ctx }) => {
    const { page } = await gotoPopup(ctx);
    await page.evaluate(() => window.__mountInfoBubbles('popup'));
    const icon = page.locator('.tool-card[data-tool="bulk-composer"] .tool-name .fmn-info-bubble-icon');
    await icon.hover();
    await expect(page.locator('.fmn-info-bubble')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.fmn-info-bubble')).toHaveCount(0);
    await page.close();
  });

  test('"× don\'t show me this again" persists dismissal and prevents future hover bubbles', async ({ ctx }) => {
    const { page } = await gotoPopup(ctx);
    await page.evaluate(() => window.__mountInfoBubbles('popup'));
    const icon = page.locator('.tool-card[data-tool="bulk-composer"] .tool-name .fmn-info-bubble-icon');
    await icon.hover();
    await expect(page.locator('.fmn-info-bubble')).toBeVisible();
    await page.locator('button.fmn-info-bubble-dismiss').click();
    await expect(page.locator('.fmn-info-bubble')).toHaveCount(0);

    // Storage must reflect the dismissal.
    const dismissed = await page.evaluate(() =>
      window.__harness.storageState['fm:dismissedInfoBubbles']
    );
    expect(dismissed).toEqual(['bulk-composer']);

    // Subsequent hover MUST NOT re-show the bubble.
    await page.mouse.move(0, 0); // reset hover
    await icon.hover();
    await page.waitForTimeout(50);
    await expect(page.locator('.fmn-info-bubble')).toHaveCount(0);
    await page.close();
  });

  test('global toggle off suppresses all bubbles, regardless of per-feature state', async ({ ctx }) => {
    const { page } = await gotoPopup(ctx);
    await page.evaluate(() => window.__harness.setFlag(false));
    await page.evaluate(() => window.__mountInfoBubbles('popup'));
    const icon = page.locator('.tool-card[data-tool="bulk-composer"] .tool-name .fmn-info-bubble-icon');
    await icon.hover();
    await page.waitForTimeout(50);
    await expect(page.locator('.fmn-info-bubble')).toHaveCount(0);
    await page.close();
  });

  test('global toggle back on preserves per-feature dismissals', async ({ ctx }) => {
    const { page } = await gotoPopup(ctx);
    // Seed: master ON (undefined => default-on), bulk-composer
    // dismissed, then flip master OFF, then flip ON.
    await page.evaluate(() => window.__harness.seedDismissed(['bulk-composer']));
    await page.evaluate(() => window.__harness.setFlag(false));
    await page.evaluate(() => window.__harness.setFlag(true));
    await page.evaluate(() => window.__mountInfoBubbles('popup'));

    // Bulk Composer is in the dismissal set, so its bubble must NOT
    // open on hover.
    const bulkIcon = page.locator('.tool-card[data-tool="bulk-composer"] .tool-name .fmn-info-bubble-icon');
    await bulkIcon.hover();
    await page.waitForTimeout(50);
    await expect(page.locator('.fmn-info-bubble[data-fmn-info-bubble-feature="bulk-composer"]')).toHaveCount(0);

    // Update banner is NOT dismissed, so its bubble MUST appear.
    const bannerIcon = page.locator('#update-banner .update-banner-body .fmn-info-bubble-icon');
    await bannerIcon.hover();
    await expect(page.locator('.fmn-info-bubble[data-fmn-info-bubble-feature="update-banner"]')).toBeVisible();

    // Dismissal set survived the flag round-trip.
    const dismissed = await page.evaluate(() =>
      window.__harness.storageState['fm:dismissedInfoBubbles']
    );
    expect(dismissed).toEqual(['bulk-composer']);
    await page.close();
  });

  test('mount is idempotent: re-mounting does not stack icons or handlers', async ({ ctx }) => {
    const { page } = await gotoPopup(ctx);
    await page.evaluate(() => window.__mountInfoBubbles('popup'));
    await page.evaluate(() => window.__mountInfoBubbles('popup'));
    await page.evaluate(() => window.__mountInfoBubbles('popup'));
    const iconCount = await page.locator('.tool-card[data-tool="bulk-composer"] .tool-name .fmn-info-bubble-icon').count();
    expect(iconCount).toBe(1);
    await page.close();
  });
});

// ============================================================================
// Scenario 2: augment.js synthetic surface
// ============================================================================

let cachedAugmentHtml = null;
function buildAugmentHarnessHtml() {
  if (cachedAugmentHtml) return cachedAugmentHtml;
  const harness = fs.readFileSync(AUGMENT_FIXTURE_PATH, 'utf-8');
  const augmentJs = fs.readFileSync(AUGMENT_JS_PATH, 'utf-8');
  cachedAugmentHtml = harness.replace(
    /<script src="\.\.\/\.\.\/extension\/src\/content\/augment\.js"><\/script>/,
    `<script>\n${augmentJs}\n</script>`
  );
  return cachedAugmentHtml;
}

async function gotoAugmentHarness(ctx) {
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
      body: buildAugmentHarnessHtml()
    });
  });
  // FMN-260: augment.js loads info-bubble-registry.js via a dynamic import()
  // of chrome.runtime.getURL(...). The harness getURL returns a same-origin
  // /__fmn_ext__/<path> URL (chrome-extension:// can't be routed); serve the
  // real extension module from disk so the import resolves and the
  // info-bubble icons mount deterministically.
  await page.route('**/__fmn_ext__/**', async (route) => {
    const rel = new URL(route.request().url()).pathname.replace(/^\/__fmn_ext__\//, '');
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body: fs.readFileSync(path.resolve(REPO_ROOT, 'extension', rel), 'utf-8')
    });
  });
  await page.goto(FORTIMONITOR_URL);
  // augment.js does a Promise.all([loadFlags()]).finally(ensureAll).
  // Wait for the info-bubble register entry to land its icon.
  await page.waitForSelector('#fmn-omni-search-container .fmn-info-bubble-icon', { timeout: 5000 });
  return { page, errors };
}

test.describe('FMN-169 augment.js synthetic surface', () => {
  test('icon mounts next to the omni-search chip', async ({ ctx }) => {
    const { page, errors } = await gotoAugmentHarness(ctx);
    await expect(page.locator('#fmn-omni-search-container .fmn-info-bubble-icon')).toHaveCount(1);
    expect(errors).toEqual([]);
    await page.close();
  });

  test('icon mounts next to the Columns button', async ({ ctx }) => {
    const { page } = await gotoAugmentHarness(ctx);
    // mountTarget: 'after' on #fmn-columns-button - icon is a sibling.
    const icon = page.locator('#fmn-columns-button + .fmn-info-bubble-icon[data-fmn-info-bubble-feature="native-column-reorder"]');
    await expect(icon).toHaveCount(1);
    await page.close();
  });

  test('handlers attach to the IP / DNS sub-headers (self mode)', async ({ ctx }) => {
    const { page } = await gotoAugmentHarness(ctx);
    // augment.js's instances-ip-dns-columns augmentation also runs in
    // the harness and replaces the static thead. Both the harness's
    // pre-baked sub-headers and any augment-generated sub-headers must
    // carry the ready attribute (so the live tenant version of the
    // same selector also gets a bubble).
    const ipReady = await page.locator('th.fmn-instance-merged [data-fmn-col="ip"][data-fmn-info-bubble-ready="1"]').count();
    const dnsReady = await page.locator('th.fmn-instance-merged [data-fmn-col="dns"][data-fmn-info-bubble-ready="1"]').count();
    expect(ipReady).toBeGreaterThanOrEqual(1);
    expect(dnsReady).toBeGreaterThanOrEqual(1);
    // self-mode entries get NO inserted icon child INSIDE the
    // sub-header. (The augment-created sub-header carries the
    // FMN-86 attribution ribbon, which is a separate decoration.)
    const insideIp = await page.locator('th.fmn-instance-merged [data-fmn-col="ip"] .fmn-info-bubble-icon').count();
    expect(insideIp).toBe(0);
    await page.close();
  });

  test('snapshot card info-bubble: self-mode ribbon wires a hover bubble (no icon by design)', async ({ ctx }) => {
    const { page } = await gotoAugmentHarness(ctx);
    // FMN-260: the snapshot-diff-card registry entry is anchorMode:'self' on
    // the card's ribbon - it wires hover/click handlers onto the ribbon itself
    // and inserts NO separate icon (verified against live FortiMonitor:
    // the ribbon carries data-fmn-info-bubble-ready=1 and hovering it shows the
    // bubble; there is no icon element). The previous assertion looked for a
    // '.fmn-info-bubble-icon' that self-mode never creates, so it always failed.
    const ribbon = page.locator('[data-fmn-entry="fmn-snapshot-diff-card"] .fmn-pa-card-ribbon');
    await expect(ribbon).toHaveAttribute('data-fmn-info-bubble-ready', '1', { timeout: 5000 });
    await expect(page.locator('[data-fmn-entry="fmn-snapshot-diff-card"] .fmn-info-bubble-icon')).toHaveCount(0);
    // The harness ribbon is an empty decorative span (aria-hidden, 0-size), so
    // Playwright .hover() can't target it; dispatch the same mouseenter the
    // self-mode handler listens for. (Live, the ribbon is hoverable - verified.)
    await ribbon.dispatchEvent('mouseenter');
    const bubble = page.locator('.fmn-info-bubble[data-fmn-info-bubble-feature="snapshot-diff-card"]');
    await expect(bubble).toBeVisible({ timeout: 2000 });
    await expect(bubble.locator('.fmn-info-bubble-title')).toHaveText('Snapshot & Diff');
    await page.close();
  });

  test('hovering the omni-search icon shows the FM TK Search bubble', async ({ ctx }) => {
    const { page } = await gotoAugmentHarness(ctx);
    const icon = page.locator('#fmn-omni-search-container .fmn-info-bubble-icon');
    await icon.hover();
    // augment.js's inlined hover delay is the production 500 ms, not
    // the harness's zeroed-out delay (the inlined version is a copy).
    // Wait for the bubble to materialize.
    const bubble = page.locator('.fmn-info-bubble[data-fmn-info-bubble-feature="omni-search"]');
    await expect(bubble).toBeVisible({ timeout: 2000 });
    await expect(bubble.locator('.fmn-info-bubble-title')).toHaveText('FM TK Search');
    await page.close();
  });

  test('no MutationObserver feedback loop: heartbeat keeps ticking after mount', async ({ ctx }) => {
    const { page } = await gotoAugmentHarness(ctx);
    const initial = await page.evaluate(() => window.__hbTicks);
    // Force several DOM mutations that will fire augment.js's
    // MutationObserver. If the info-bubble mount writes DOM
    // unconditionally (FMN-72-style), the observer will re-fire and
    // chain. Verify the heartbeat continues to tick at the expected
    // rate (i.e. the main thread is not pegged).
    await page.evaluate(() => {
      for (let i = 0; i < 50; i++) {
        const d = document.createElement('div');
        d.textContent = 'noise-' + i;
        document.body.appendChild(d);
      }
    });
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => window.__hbTicks);
    // 50 ms per tick → ~7-8 ticks in 400 ms. Anything <= initial+2
    // strongly suggests a freeze.
    expect(after - initial).toBeGreaterThanOrEqual(5);

    // And the icons did NOT multiply.
    const omniIcons = await page.locator('#fmn-omni-search-container .fmn-info-bubble-icon').count();
    expect(omniIcons).toBe(1);
    await page.close();
  });

  test('global flag off → no bubble on hover', async ({ ctx }) => {
    const { page } = await gotoAugmentHarness(ctx);
    // Flip the flag off via the augment.js storage subscription.
    await page.evaluate(() => chrome.storage.local.set({ 'fm:showInfoBubbles': false }));
    await page.waitForTimeout(50);
    const icon = page.locator('#fmn-omni-search-container .fmn-info-bubble-icon');
    await icon.hover();
    await page.waitForTimeout(600); // longer than the 500 ms hover delay
    await expect(page.locator('.fmn-info-bubble')).toHaveCount(0);
    await page.close();
  });
});
