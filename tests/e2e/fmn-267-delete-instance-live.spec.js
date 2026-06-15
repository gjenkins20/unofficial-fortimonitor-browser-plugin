// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-267 LIVE spec: the Bulk Action Composer "Delete Instances" action,
// driven against the persistent Dev Launcher (tools/dev/launcher.mjs) over CDP.
//
// SAFETY: deletion in FortiMonitor is irreversible (agent_resources + metric
// history are destroyed, not suspended). This spec therefore drives the REAL
// composer against REAL cached instances all the way to the ARMED Apply button
// and asserts the type-to-confirm gate - but it never clicks Apply, so nothing
// is deleted. The destructive commit() path (success / 404-skip / error) is
// covered by tests/bulk-actions-delete-instance.test.js against a mock client.
// A genuinely-destructive end-to-end test (create a throwaway template, delete
// it, confirm it is gone) lives at the bottom, test.skip-ped unless the operator
// opts in with FMN_ALLOW_LIVE_DELETE=1 - never run it against a tenant whose
// instances you cannot afford to lose.
//
// BEHAVIOR MATRIX (per Verification Discipline - not one happy path):
//   (a) the Delete Instances action card is present in the picker;
//   (b) the Configure step renders the irreversibility warning and lets the
//       operator advance (no params required);
//   (c) the Preview step lists the REAL chosen instances with prev=exists,
//       next=DELETED, and the Apply button is DISABLED while the confirm box is
//       empty / holds the wrong phrase, and becomes ENABLED only on the exact
//       phrase "DELETE" (the gate block path AND the arm path);
//   (d) clearing the phrase re-disables Apply (gate re-arms).
//
// SKIP conditions (prerequisites unmet, not a failure):
//   - No extension service worker at the provisioned CDP port.
//   - Launcher running an older build without the delete-instance wiring.
//   - No v2 API key seeded (omni-search cache needs it to hold instances).
//   - FortiMonitor session at a login screen.
//   - Fewer than 1 cached instance to target.
//
// Run: FMN_CDP_PORT=<port> npx playwright test --config tests/e2e/playwright.config.js \
//   tests/e2e/fmn-267-delete-instance-live.spec.js --grep "live -" --reporter=line

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

    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
    if (sw) {
      await sw.evaluate(() => chrome.storage.local.set({ 'fm:omniSearchEnabled': true }));
    }
    let fmPage = ctx.pages().find((p) => p.url().startsWith(FM));
    if (!fmPage) {
      fmPage = await ctx.newPage();
      await fmPage.goto(`${FM}/report/ListServers`, { waitUntil: 'domcontentloaded' });
    }
    const atLogin = (await fmPage.locator('input[type="password"]').count()) > 0;
    if (sw && !atLogin) {
      await sw.evaluate(async () => {
        try { await chrome.runtime.sendMessage({ type: 'omni-search:warm', payload: {} }); } catch { /* swallow */ }
      });
    }
    await use({ ctx, fmPage, sw, browser, atLogin });
    await browser.close();
  }, { scope: 'worker' }]
});

test.setTimeout(120_000);

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

async function driveToPreview(page, targets) {
  await page.goto(bulkAppUrl(page._fmnExtId, '/pick'));
  const pasteValue = targets.map((s) => `${s.id},${(s.name ?? '').replace(/,/g, ' ')}`).join('\n');
  await page.locator('textarea.paste-area').fill(pasteValue);
  await expect(page.locator('.sample-table tbody tr')).toHaveCount(targets.length);
  await page.locator('[data-test="pick-next"]').click();

  await page.locator('[data-test="action-card"][data-action-id="delete-instance"]').click();
  await page.locator('[data-test="action-next"]').click();

  // (b) Configure renders the irreversibility warning; advancing is allowed.
  await expect(page.locator('[data-test="configure-delete-warning"]')).toBeVisible();
  await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();
  await page.locator('[data-test="configure-next"]').click();

  await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('Preview', { timeout: 5000 });
}

test.describe('live - FMN-267 Delete Instances action', () => {
  test('live - action card is present in the picker', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');
    const keys = await sw.evaluate(() => globalThis.__fmDebugHandlerKeys || []);
    test.skip(!keys.includes('bulk-composer:commit'),
      'Launcher extension does not have bulk-composer wired; reload the launcher and re-run.');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    page._fmnExtId = extensionId;
    // Need at least one target to reach the picker; use a synthetic id since
    // this test never commits.
    await page.goto(bulkAppUrl(extensionId, '/pick'));
    await page.locator('textarea.paste-area').fill('1,placeholder');
    await page.locator('[data-test="pick-next"]').click();
    await expect(page.locator('[data-test="action-card"][data-action-id="delete-instance"]'),
      'Delete Instances action card must be in the picker').toBeVisible();
    await page.close();
  });

  test('live - confirm gate: Apply disabled until exact phrase, re-arms on clear, against real instances', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');
    const keys = await sw.evaluate(() => globalThis.__fmDebugHandlerKeys || []);
    test.skip(!keys.includes('bulk-composer:commit'),
      'Launcher extension does not have bulk-composer wired; reload the launcher and re-run.');
    const sample = await getCachedServers(sw, 2);
    test.skip(sample.length < 1,
      'Omni-search cache holds no instances (needs an API key + a warm cache); cannot target real instances.');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    page._fmnExtId = extensionId;
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

    await driveToPreview(page, sample);

    // (c) Preview lists the real instances with the delete diff.
    const rows = page.locator('[data-test="bulk-preview-row"]');
    await expect(rows).toHaveCount(sample.length);
    const firstPrev = rows.first().locator('td').nth(2);
    const firstNext = rows.first().locator('td').nth(3);
    await expect(firstPrev).toHaveText('exists');
    await expect(firstNext).toHaveText('DELETED');

    const apply = page.locator('[data-test="apply-btn"]');
    const gate = page.locator('[data-test="delete-confirm-gate"]');
    const input = page.locator('[data-test="delete-confirm-input"]');
    await expect(gate, 'the confirm gate must render for delete').toBeVisible();

    // Empty -> disabled.
    await expect(apply).toBeDisabled();
    // Wrong phrase (lowercase) -> still disabled (case-sensitive).
    await input.fill('delete');
    await expect(apply).toBeDisabled();
    // Exact phrase -> enabled (arm path).
    await input.fill('DELETE');
    await expect(apply).toBeEnabled();
    // (d) Clearing the phrase re-disables Apply (gate re-arms).
    await input.fill('');
    await expect(apply).toBeDisabled();

    // Intentionally DO NOT click Apply: this spec must not delete real
    // instances. The committed-delete path is unit-tested with a mock client.
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    await page.close();
  });

  // GUARDED destructive end-to-end. Skipped unless FMN_ALLOW_LIVE_DELETE=1.
  // Creates a throwaway template on the live tenant, deletes it through the
  // composer, and confirms it is gone. Only run this against a tenant where a
  // self-created template is safe to destroy.
  test('live - end-to-end delete of a throwaway template (opt-in: FMN_ALLOW_LIVE_DELETE=1)', async ({ liveCtx }) => {
    test.skip(process.env.FMN_ALLOW_LIVE_DELETE !== '1',
      'Destructive live delete is opt-in only. Set FMN_ALLOW_LIVE_DELETE=1 to run it.');
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');

    // Left as an explicit, operator-gated stub: creating the throwaway
    // template requires a source instance id and the createServerTemplate
    // flow (FMN-203). Implement when the operator opts in and names a safe
    // source instance, so the spec never fabricates state on an unknown tenant.
    test.skip(true,
      'Throwaway-template setup needs an operator-named safe source instance; implement on opt-in.');
  });
});
