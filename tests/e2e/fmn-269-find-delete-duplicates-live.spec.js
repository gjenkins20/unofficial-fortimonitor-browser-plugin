// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-269 LIVE spec: the Find & Delete Duplicates tool, driven over CDP against
// the persistent Dev Launcher.
//
// SAFETY: like FMN-267, this never clicks the final Delete - it drives the real
// tool to the ARMED delete button and asserts the type-to-confirm gate, so no
// instance is deleted. The committed-delete path is unit-tested (delete-set.js +
// delete-instance) and shares the same bulk-composer:commit runner. A genuinely
// destructive end-to-end test is opt-in (FMN_ALLOW_LIVE_DELETE=1).
//
// BEHAVIOR MATRIX (per Verification Discipline - not one happy path):
//   (1) LIVE flow: click Find against the real tenant; whichever state the
//       tenant is in, assert it renders correctly - populated (duplicate-set
//       cards, each with exactly one KEEP survivor) or the empty state.
//   (2) POPULATED choose+confirm (deterministic): inject duplicate sets into the
//       real tool's store, render the real Choose step, assert keep-->=1 (one
//       survivor per set) and that changing the survivor updates the delete
//       count, advance to Confirm, and assert the gate (Delete disabled until
//       the exact DELETE phrase, re-disabled on clear).
//
// SKIP conditions: no SW at the CDP port; FortiMonitor at a login screen;
//   (test 1 only) no API key to run the live find.
//
// Run: FMN_CDP_PORT=<port> npx playwright test --config tests/e2e/playwright.config.js \
//   tests/e2e/fmn-269-find-delete-duplicates-live.spec.js --grep "live -" --reporter=line

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
    let fmPage = ctx.pages().find((p) => p.url().startsWith(FM));
    let atLogin = false;
    if (fmPage) atLogin = (await fmPage.locator('input[type="password"]').count()) > 0;
    await use({ ctx, sw, browser, atLogin });
    await browser.close();
  }, { scope: 'worker' }]
});

test.setTimeout(120_000);

async function apiKeyConfigured(sw) {
  if (!sw) return false;
  return await sw.evaluate(async () => {
    const d = await chrome.storage.local.get('panopta.apiKey');
    return Boolean(d?.['panopta.apiKey']);
  });
}

function toolUrl(extensionId) {
  return `chrome-extension://${extensionId}/src/ui/find-delete-duplicates/app.html`;
}

test.describe('live - FMN-269 Find & Delete Duplicates', () => {
  test('live - SW find handler registered + tool loads', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');
    const keys = await sw.evaluate(() => globalThis.__fmDebugHandlerKeys || []);
    test.skip(!keys.includes('find-delete-duplicates:find'),
      'Launcher extension does not have FMN-269 wired; reload the launcher and re-run.');
    expect(keys).toContain('find-delete-duplicates:find');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    await page.goto(toolUrl(extensionId), { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.title-bar h1')).toContainText('Find & Delete Duplicates');
    await expect(page.locator('[data-test="find-btn"]')).toBeVisible();
    await page.close();
  });

  test('live - Find against the real tenant renders populated-or-empty correctly', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');
    const keys = await sw.evaluate(() => globalThis.__fmDebugHandlerKeys || []);
    test.skip(!keys.includes('find-delete-duplicates:find'),
      'Launcher extension does not have FMN-269 wired; reload the launcher and re-run.');
    test.skip(!(await apiKeyConfigured(sw)), 'No v2 API key seeded; cannot run the live find.');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
    await page.goto(toolUrl(extensionId), { waitUntil: 'domcontentloaded' });
    await page.locator('[data-test="find-btn"]').click();

    // Wait until the Choose step resolves to either populated or empty.
    const dupSet = page.locator('[data-test="dup-set"]');
    const empty = page.locator('[data-test="choose-empty"]');
    await expect(async () => {
      expect((await dupSet.count()) + (await empty.count())).toBeGreaterThan(0);
    }).toPass({ timeout: 60_000 });

    const sets = await dupSet.count();
    if (sets === 0) {
      await expect(empty).toBeVisible();
    } else {
      // Every duplicate set must have exactly one KEEP survivor (keep-->=1).
      for (let i = 0; i < sets; i++) {
        const card = dupSet.nth(i);
        const checked = await card.locator('[data-test="keep-radio"]:checked').count();
        expect(checked, `duplicate set ${i} must have exactly one survivor`).toBe(1);
      }
      await expect(page.locator('[data-test="choose-summary"]')).toContainText('Will delete');
    }
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    await page.close();
  });

  test('live - populated choose+confirm + gate (injected duplicate sets, real tool code)', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');
    const keys = await sw.evaluate(() => globalThis.__fmDebugHandlerKeys || []);
    test.skip(!keys.includes('find-delete-duplicates:find'),
      'Launcher extension does not have FMN-269 wired; reload the launcher and re-run.');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
    await page.goto(toolUrl(extensionId), { waitUntil: 'domcontentloaded' });

    // Inject duplicate sets into the real tool's store and render the real
    // Choose step (the live tenant may have zero duplicates, so this guarantees
    // the populated path is exercised).
    const mountErr = await page.evaluate(async () => {
      try {
        const mod = await import('./app.js');
        const helper = await import('../../lib/find-delete-duplicates/delete-set.js');
        mod.store.result = {
          available: true, scanned: 5,
          groups: [
            { axis: 'name', value: 'dup-name', count: 2, members: [
              { id: '901', name: 'dup-a', address: '10.9.9.1' },
              { id: '902', name: 'DUP-A', address: '10.9.9.2' }
            ] },
            { axis: 'address', value: '10.9.9.9', count: 2, members: [
              { id: '903', name: 'beta', address: '10.9.9.9' },
              { id: '904', name: 'gamma', address: '10.9.9.9' }
            ] }
          ],
          summary: {}
        };
        mod.store.keepMap = helper.defaultKeepMap(mod.store.result.groups);
        mod.renderChoose();
        return null;
      } catch (e) { return String((e && e.stack) || e); }
    });
    expect(mountErr, `inject/render threw: ${mountErr}`).toBeNull();

    // Two duplicate sets, each with exactly one survivor (default = lowest id).
    await expect(page.locator('[data-test="dup-set"]')).toHaveCount(2);
    for (const card of await page.locator('[data-test="dup-set"]').all()) {
      expect(await card.locator('[data-test="keep-radio"]:checked').count()).toBe(1);
    }
    await expect(page.locator('[data-test="choose-summary"]')).toContainText('Will delete 2');

    // Changing the survivor in set 0 keeps the delete count at 2 (still one
    // survivor per set) - the keep-->=1 guardrail can never zero a set out.
    const set0 = page.locator('[data-test="dup-set"]').nth(0);
    await set0.locator('[data-test="keep-radio"]').nth(1).check();
    await expect(page.locator('[data-test="choose-summary"]')).toContainText('Will delete 2');
    expect(await set0.locator('[data-test="keep-radio"]:checked').count()).toBe(1);

    // Advance to Confirm and assert the type-to-confirm gate.
    await page.locator('[data-test="choose-next"]').click();
    await expect(page.locator('[data-test="delete-table"]')).toBeVisible();
    await expect(page.locator('[data-test="delete-row"]')).toHaveCount(2);

    const apply = page.locator('[data-test="apply-btn"]');
    const input = page.locator('[data-test="delete-confirm-input"]');
    await expect(apply).toBeDisabled();
    await input.fill('delete');              // wrong case
    await expect(apply).toBeDisabled();
    await input.fill('DELETE');              // exact
    await expect(apply).toBeEnabled();
    await input.fill('');                    // cleared -> re-armed
    await expect(apply).toBeDisabled();

    // Do NOT click Apply: no deletion in this spec.
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    await page.close();
  });

  test('live - end-to-end delete of throwaway duplicates (opt-in: FMN_ALLOW_LIVE_DELETE=1)', async ({ liveCtx }) => {
    test.skip(process.env.FMN_ALLOW_LIVE_DELETE !== '1',
      'Destructive live delete is opt-in only. Set FMN_ALLOW_LIVE_DELETE=1 to run it.');
    test.skip(true,
      'Throwaway duplicate-instance setup needs operator-named safe instances; implement on opt-in.');
  });
});
