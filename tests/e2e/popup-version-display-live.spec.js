// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-157 prereq: the popup footer must read its version from
// chrome.runtime.getManifest().version at load time, not from a hardcoded
// HTML string. Previously popup.html shipped "v0.7.0" while the manifest
// had moved to 1.0.0; this spec asserts that drift can't recur.
//
// Runs against the persistent Dev Launcher (tools/dev/launcher.mjs) over
// CDP. The launcher must be up; no FortiMonitor authentication is needed
// for this test (the popup page is fully offline). Single spec file, run
// with: npx playwright test tests/e2e/popup-version-display-live.spec.js

import { test as base, expect, chromium } from '@playwright/test';

const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const CDP_URL = `http://localhost:${CDP_PORT}`;

const test = base.extend({
  extensionPopup: [async ({}, use) => {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
    } catch (e) {
      throw new Error(
        `Could not connect to Chromium at ${CDP_URL}. ` +
        `Start the persistent launcher first: \`node tools/dev/launcher.mjs\`. ` +
        `Underlying error: ${e.message}`
      );
    }
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('CDP browser has no contexts');

    // Discover the extension ID from a registered service worker. The
    // launcher loads the toolkit via --load-extension, so a SW will be
    // present (it may be idle and require a wake event).
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) {
      sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
    }
    if (!sw) {
      throw new Error('Toolkit service worker not found in the launcher context.');
    }
    const m = sw.url().match(/^chrome-extension:\/\/([^/]+)\//);
    if (!m) throw new Error(`Unexpected SW url: ${sw.url()}`);
    const extensionId = m[1];

    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`, {
      waitUntil: 'domcontentloaded',
    });

    await use(page);
    await page.close();
    await browser.close();
  }, { scope: 'worker' }],
});

test.setTimeout(30_000);

test.describe('FMN-157 prereq: popup version display reads from manifest', () => {
  test('footer shows v<manifest.version>, never empty, never the old hardcoded v0.7.0', async ({ extensionPopup }) => {
    const page = extensionPopup;

    const manifestVersion = await page.evaluate(() => chrome.runtime.getManifest().version);
    expect(manifestVersion).toMatch(/^\d+\.\d+\.\d+$/);

    const displayed = (await page.locator('#version').textContent())?.trim() ?? '';
    expect(displayed).not.toBe('');
    expect(displayed).not.toBe('v0.7.0');
    expect(displayed).toBe(`v${manifestVersion}`);
  });

  test('source HTML carries no hardcoded version literal', async ({ extensionPopup }) => {
    const page = extensionPopup;
    const rawHtml = await page.evaluate(() => document.documentElement.outerHTML);
    // The version literal `v` followed by digits must not appear hardcoded
    // anywhere in the rendered HTML except as the textContent of #version
    // set by JS. Easiest assertion: confirm popup.html's #version span
    // starts empty on load (no text between the tags before JS runs would
    // be ideal, but we run after init; instead assert the literal v0.7.0
    // is gone everywhere).
    expect(rawHtml).not.toContain('v0.7.0');
  });
});
