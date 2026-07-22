// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-299 LIVE spec: session-only template extraction (NO v2 API key), driven
// against the real tenant over CDP.
//
// Proves the download/anonymize/audit template flow works with only the
// FortiMonitor browser session - the whole point of FMN-299 (some clients have
// no API key). The spec REMOVES panopta.apiKey (to prove session-only) and
// RESTORES it in a finally, so it never breaks sibling specs (FMN-298 needs it).
//
// BEHAVIOR MATRIX (per Verification Discipline):
//   (a) the labeled "Extract & anonymize templates" entry + guidance render;
//   (b) with the API key removed, clicking it runs the detached session-only
//       collection (tree + concurrent config crawl) and lands on the Template
//       Analysis view - single tab, sections painted, real templates present;
//   (c) Export produces a structurally-anonymized pack (template names
//       tokenized, metric names tokenized, no tags, group names tokenized or
//       the preserved stock literal).
//
// SKIP conditions (prerequisites unmet, not a failure):
//   - No extension service worker at the provisioned CDP port.
//   - FortiMonitor session at a login screen (the tree/config endpoints are
//     session-auth).
//   - Tenant has zero templates.
//
// Run: FMN_CDP_PORT=<port> npx playwright test --config tests/e2e/playwright.config.js \
//   tests/e2e/fmn-299-session-only-extraction-live.spec.js --grep "live -" --reporter=line

import { test as base, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FM = 'https://fortimonitor.forticloud.com';
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const CDP_URL = `http://localhost:${CDP_PORT}`;
const STOCK = 'Default Monitoring Templates';
const API_KEY = 'panopta.apiKey';

const test = base.extend({
  liveCtx: [async ({}, use) => {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
    } catch (e) {
      throw new Error(
        `Could not connect to Chromium at ${CDP_URL}. A pre-provisioned ` +
        `authenticated Chromium with the extension loaded must be running at ` +
        `that CDP port. Underlying error: ${e.message}`
      );
    }
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('CDP browser has no contexts');
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
    let fmPage = ctx.pages().find((p) => p.url().startsWith(FM));
    let atLogin = false;
    if (fmPage) atLogin = (await fmPage.locator('input[type="password"]').count()) > 0;
    await use({ ctx, sw, browser, atLogin });
    await browser.close();
  }, { scope: 'worker' }]
});

// The detached config crawl is minutes-long on a full tenant.
test.setTimeout(360_000);

test.describe('live - FMN-299 session-only template extraction', () => {
  test('live - extracts + anonymizes templates with NO v2 API key', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen; session-auth endpoints unavailable.');

    const extensionId = sw.url().split('/')[2];

    // Save the current API key (removed inside the try below so the finally
    // always restores it, even if setup throws - FMN-299 review).
    const savedKey = await sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? null, API_KEY);
    let page;
    const pageErrors = [];

    try {
      await sw.evaluate(async (k) => { await chrome.storage.local.remove(k); }, API_KEY);
      page = await ctx.newPage();
      page.on('pageerror', (e) => pageErrors.push(e.message));

      const keyGone = await sw.evaluate(async (k) => !(await chrome.storage.local.get(k))[k], API_KEY);
      expect(keyGone, 'API key must be absent for the session-only assertion').toBe(true);

      // (a) the labeled entry + guidance.
      await page.goto(`chrome-extension://${extensionId}/src/ui/tenant-observations/app.html`,
        { waitUntil: 'domcontentloaded' });
      const extractBtn = page.locator('button[data-test="extract-templates"]');
      await expect(extractBtn, 'the "Extract & anonymize templates" entry must render').toBeVisible({ timeout: 10_000 });
      await expect(page.locator('[data-test="extract-templates-card"]'), 'guidance card must render').toBeVisible();

      // (b) run the session-only extraction -> template-only review.
      await extractBtn.click();
      const reviewTab = page.locator('.observations-viewer-host button[data-tab="template-recommendations"]');
      await expect(reviewTab, 'session-only extraction must land on the Template Analysis tab (no key)')
        .toBeVisible({ timeout: 300_000 });
      const tabCount = await page.locator('.observations-viewer-host button[data-tab]').count();
      expect(tabCount, 'a template-only extraction renders exactly one tab').toBe(1);
      const paneSections = await page.locator('.observations-viewer-host .tab-pane .review-section').count();
      expect(paneSections, 'the Template Analysis tab must paint its sections').toBeGreaterThan(0);

      // (c) export -> structurally-anonymized pack.
      const exportBtn = page.locator('.observations-viewer-host button[data-test="export-anon-templates"]');
      await expect(exportBtn, 'Export button must be available after session-only extraction').toBeVisible();
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), exportBtn.click()]);
      const tmpPack = path.join(os.tmpdir(), `fmn299-pack-${Date.now()}.json`);
      await dl.saveAs(tmpPack);
      const env = JSON.parse(fs.readFileSync(tmpPack, 'utf8'));
      expect(env.format).toBe('fmn-template-pack');
      const inv = env.pack.inventory;

      expect(inv.server_templates.length, 'pack carries templates extracted session-only').toBeGreaterThan(0);
      for (const t of inv.server_templates) {
        expect(t.name, `template name tokenized, got "${t.name}"`).toMatch(/^Template \d+$/);
        expect('tags' in t, 'no tags survive').toBe(false);
      }
      for (const g of Object.values(inv.server_group_details)) {
        expect(g.name === STOCK || /^Group \d+$/.test(g.name),
          `group name tokenized or stock literal, got "${g.name}"`).toBe(true);
      }
      for (const c of Object.values(inv.template_monitoring_configs)) {
        for (const n of [...(c.metric_names || []), ...(c.metrics_without_alerts || [])]) {
          expect(n, `metric name tokenized, got "${n}"`).toMatch(/^m\d+$/);
        }
      }
      expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
      fs.rmSync(tmpPack, { force: true });
    } finally {
      // Restore the API key so sibling specs (FMN-298) still have it.
      if (savedKey) await sw.evaluate(async ({ k, v }) => { await chrome.storage.local.set({ [k]: v }); }, { k: API_KEY, v: savedKey });
      // Clear any staged result/status this run left behind.
      await sw.evaluate(async () => { await chrome.storage.local.remove(['observations.lastResult', 'observations.lastRun']); }).catch(() => {});
      if (page) await page.close();
    }
  });
});
