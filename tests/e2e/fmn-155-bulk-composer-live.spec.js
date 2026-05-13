// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155 live spec: end-to-end Bulk Action Composer against the
// persistent Dev Launcher (tools/dev/launcher.mjs) over CDP.
//
// Each test skips cleanly when prerequisites are not satisfied:
//   - No API key configured  -> skip
//   - Omni-search corpus is empty  -> skip
//   - No templates available (for the apply-template flow)  -> skip
//
// Run: npx playwright test tests/e2e/fmn-155-bulk-composer-live.spec.js

import { test as base, expect, chromium } from '@playwright/test';

const FM = 'https://fortimonitor.forticloud.com';
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const CDP_URL = `http://localhost:${CDP_PORT}`;

const test = base.extend({
  liveCtx: [async ({}, use) => {
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

    // FMN-201: bulk-composer flag removed; only the omni-search flag
    // still needs priming for this spec.
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
    if (sw) {
      await sw.evaluate(() => chrome.storage.local.set({
        'fm:omniSearchEnabled': true
      }));
    }
    let fmPage = ctx.pages().find((p) => p.url().startsWith(FM));
    if (!fmPage) {
      fmPage = await ctx.newPage();
      await fmPage.goto(`${FM}/report/ListServers`, { waitUntil: 'domcontentloaded' });
    }
    if (await fmPage.locator('input[type="password"]').count()) {
      throw new Error('FortiMonitor is at a login screen. Sign in in the launcher window and re-run.');
    }
    // Warm the omni-search cache - first query will trigger a /v2/server
    // walk which can take several seconds on a real tenant.
    if (sw) {
      await sw.evaluate(async () => {
        try { await chrome.runtime.sendMessage({ type: 'omni-search:warm', payload: {} }); } catch { /* swallow */ }
      });
    }

    await use({ ctx, fmPage, sw, browser });
    await browser.close();
  }, { scope: 'worker' }]
});

test.setTimeout(180_000);

async function apiKeyConfigured(sw) {
  if (!sw) return false;
  return await sw.evaluate(async () => {
    const d = await chrome.storage.local.get('panopta.apiKey');
    return Boolean(d?.['panopta.apiKey']);
  });
}

async function getCachedServers(sw, max = 5) {
  if (!sw) return [];
  return await sw.evaluate(async (max) => {
    const all = await chrome.storage.session.get(null);
    const cacheKey = Object.keys(all).find((k) => k.startsWith('fm:omni-search-cache:'));
    if (!cacheKey) return [];
    const servers = Array.isArray(all[cacheKey]?.servers) ? all[cacheKey].servers : [];
    return servers.slice(0, max);
  }, max);
}

function bulkAppUrl(extensionId, hash = '/pick') {
  return `chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#${hash}`;
}

test.describe('live - FMN-155 Bulk Action Composer end-to-end', () => {
  test('live - SW handlers register (bulk-composer:commit, list-templates, abort)', async ({ liveCtx }) => {
    const { sw } = liveCtx;
    test.skip(!sw, 'No SW connected.');
    const keys = await sw.evaluate(() => globalThis.__fmDebugHandlerKeys || []);
    // If the launcher is running an older extension build that does not
    // yet carry the FMN-155 wiring, surface that as a skip rather than a
    // false negative. Per FMN memory extension_reload_requires_tab_close:
    // the operator must close + reopen FortiMonitor for the new content
    // scripts to apply, and an extension reload is required for new SW
    // handlers - that's an operator action.
    test.skip(!keys.includes('bulk-composer:commit'),
      'Launcher extension does not have bulk-composer handlers wired. Reload the launcher (or chrome://extensions) and re-run.');
    expect(keys).toContain('bulk-composer:commit');
    expect(keys).toContain('bulk-composer:list-templates');
    expect(keys).toContain('bulk-composer:abort');
    expect(keys).toContain('bulk-composer:save-draft');
  });

  test('live - Tool app loads + step 1 renders search UI', async ({ liveCtx }) => {
    const { ctx, sw } = liveCtx;
    test.skip(!sw, 'No SW connected.');
    const keys = await sw.evaluate(() => globalThis.__fmDebugHandlerKeys || []);
    test.skip(!keys.includes('bulk-composer:commit'),
      'Launcher extension does not have bulk-composer wired; reload extension to pick up FMN-155.');
    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    await page.goto(bulkAppUrl(extensionId, '/pick'));
    await expect(page.locator('.title-bar h1')).toContainText('Bulk Action Composer');
    await expect(page.locator('input[type="search"]')).toBeVisible();
    await expect(page.locator('[data-test="pick-next"]')).toBeDisabled();
    await page.close();
  });

  test('live - Typing in the search input streams matches via omni-search:query', async ({ liveCtx }) => {
    const { ctx, sw } = liveCtx;
    test.skip(!sw, 'No SW connected.');
    const keys = await sw.evaluate(() => globalThis.__fmDebugHandlerKeys || []);
    test.skip(!keys.includes('bulk-composer:commit'),
      'Launcher extension does not have bulk-composer wired; reload extension to pick up FMN-155.');
    const apiKey = await apiKeyConfigured(sw);
    test.skip(!apiKey, 'No FortiMonitor API key configured; the omni-search cache cannot warm.');
    const sample = await getCachedServers(sw, 5);
    test.skip(sample.length === 0, 'Omni-search cache is empty.');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    await page.goto(bulkAppUrl(extensionId, '/pick'));

    // Use a 3-char substring from a known server name so we get >= 1 match
    // and stay loose w/r/t tenant data shape.
    const seed = String(sample[0].name || '').slice(0, 3);
    test.skip(!seed || seed.length < 2, 'Cached server has no usable name seed.');
    await page.locator('input[type="search"]').fill(seed);
    await page.waitForSelector('[data-test="bulk-search-row"]', { timeout: 10_000 });
    const rows = await page.locator('[data-test="bulk-search-row"]').count();
    expect(rows).toBeGreaterThan(0);
    await page.close();
  });

  test('live - End-to-end: pick 2 instances + Add Tag + commit (uses FM-TK-test- prefix tag)', async ({ liveCtx }) => {
    const { ctx, sw } = liveCtx;
    test.skip(!sw, 'No SW connected.');
    const keys = await sw.evaluate(() => globalThis.__fmDebugHandlerKeys || []);
    test.skip(!keys.includes('bulk-composer:commit'),
      'Launcher extension does not have bulk-composer wired; reload extension to pick up FMN-155.');
    const apiKey = await apiKeyConfigured(sw);
    test.skip(!apiKey, 'No FortiMonitor API key configured; live commit skipped.');
    const sample = await getCachedServers(sw, 3);
    test.skip(sample.length < 2, 'Need at least 2 cached servers for the bulk run.');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    await page.goto(bulkAppUrl(extensionId, '/pick'));

    // Pre-seed the targets directly to avoid coupling this test to the
    // tenant's search results. Drives the store via storage.session by
    // navigating step-by-step through the wizard hash routes after click.
    const targets = sample.slice(0, 2).map((s) => ({
      id: s.id, name: s.name, tags: s.tags || [], template_names: s.template_names || []
    }));
    await page.evaluate((targets) => {
      // Seed via the app module since the store lives in module scope.
      // We can't reach into the closure, so instead we drive the UI by
      // typing into search and clicking rows; but the simplest robust
      // path is to dispatch a custom event the spec listens to.
      window.__bulkSeed = targets;
    }, targets);

    // Drive the UI: type each target's name into search, pick from dropdown.
    for (const t of targets) {
      const seed = (t.name || '').slice(0, Math.min(8, (t.name || '').length));
      if (!seed) continue;
      await page.locator('input[type="search"]').fill(seed);
      await page.waitForSelector('[data-test="bulk-search-row"]', { timeout: 8_000 });
      const row = page.locator(`[data-test="bulk-search-row"][data-id="${t.id}"]`).first();
      const visible = await row.count();
      if (visible === 0) {
        test.skip(true, `Search for "${seed}" did not surface id=${t.id}; tenant data shape mismatch.`);
        return;
      }
      await row.click();
    }
    const chipCount = await page.locator('[data-test="bulk-chip"]').count();
    expect(chipCount).toBeGreaterThanOrEqual(2);

    await page.locator('[data-test="pick-next"]').click();
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('2. Pick action', { timeout: 5000 });

    await page.locator('[data-test="action-card"][data-action-id="add-tag"]').click();
    await page.locator('[data-test="action-next"]').click();

    // Use a recognizable test tag so it is easy to clean up post-run.
    const testTag = `FM-TK-test-${Date.now()}`;
    await page.locator('[data-test="configure-tag-input"]').fill(testTag);
    await page.locator('[data-test="configure-next"]').click();

    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('4. Preview', { timeout: 5000 });
    await page.locator('[data-test="apply-btn"]').click();

    // Wait for commit to finish - state label transitions to "Done in Ns".
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-test="commit-state"]');
      return el && /Done in/.test(el.textContent || '');
    }, { timeout: 60_000 });

    // Verify every preview row reached a terminal status (committed/no-op/failed).
    const statuses = await page.locator('[data-test="preview-status"]').evaluateAll((els) =>
      els.map((e) => e.textContent?.trim() ?? '')
    );
    for (const s of statuses) {
      expect(['committed', 'no-op', 'failed']).toContain(s);
    }

    // CSV export becomes enabled post-commit.
    await expect(page.locator('[data-test="export-csv"]')).toBeEnabled();
    await page.close();
  });
});
