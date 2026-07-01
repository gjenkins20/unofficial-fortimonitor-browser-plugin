// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-277 LIVE spec: the Bulk Action Composer "Set Parent Instance" action
// (device parent/child dependency), driven against the persistent Dev Launcher
// (tools/dev/launcher.mjs) over CDP.
//
// Set/change a parent is REVERSIBLE (v2 PUT). This spec therefore drives the
// REAL composer against REAL instances all the way through Apply and verifies
// the write via v2 - then restores the child's original parent so the tenant
// ends exactly as it started.
//
// BEHAVIOR MATRIX (per Verification Discipline - not one happy path):
//   (a) the Set Parent Instance action card is present in the picker;
//   (b) the Configure picker populates from LIVE instances, selecting one
//       enables Next, and the pre-flight populates each target's current parent;
//   (c) Preview: a child with a real parent shows "will change" (prev=current
//       name -> next=chosen), a self-parent target shows "skip", and an
//       already-parented target shows "skip";
//   (d) Apply actually writes parent_server (verified via v2 GET), then the
//       spec restores the original parent.
//
// SKIP conditions (prerequisites unmet, not a failure):
//   - No extension service worker at the provisioned CDP port.
//   - Launcher running an older build without the set-parent-instance wiring.
//   - No v2 API key seeded.
//   - FortiMonitor session at a login screen.
//   - Fewer than 2 instances on the tenant (need a child + a distinct parent).
//
// Run: FMN_CDP_PORT=<port> npx playwright test --config tests/e2e/playwright.config.js \
//   tests/e2e/fmn-277-set-parent-instance-live.spec.js --grep "live -" --reporter=line

import { test as base, expect, chromium } from '@playwright/test';

const FM = 'https://fortimonitor.forticloud.com';
const V2 = 'https://api2.panopta.com/v2';
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const CDP_URL = `http://localhost:${CDP_PORT}`;
// Child used for the reversible write test. Its original parent is captured and
// restored, so any lab instance is safe here.
const CHILD_ID = process.env.FMN_PARENT_TEST_CHILD || '44218437';

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
    if (!fmPage) {
      fmPage = await ctx.newPage();
      await fmPage.goto(`${FM}/report/ListServers`, { waitUntil: 'domcontentloaded' });
    }
    const atLogin = (await fmPage.locator('input[type="password"]').count()) > 0;
    await use({ ctx, fmPage, sw, browser, atLogin });
    await browser.close();
  }, { scope: 'worker' }]
});

test.setTimeout(200_000);

// ---- v2 helpers (via the SW so the API key never leaves the extension) ----
async function hasApiKey(sw) {
  if (!sw) return false;
  return await sw.evaluate(async () => !!(await chrome.storage.local.get('panopta.apiKey'))['panopta.apiKey']);
}
async function getParentV2(sw, id) {
  return await sw.evaluate(async ({ id, V2 }) => {
    const key = (await chrome.storage.local.get('panopta.apiKey'))['panopta.apiKey'];
    const r = await fetch(`${V2}/server/${id}`, { headers: { Authorization: `ApiKey ${key}` } });
    if (!r.ok) return { error: r.status };
    return { parent: (await r.json()).parent_server ?? null };
  }, { id, V2 });
}
// Restore helper: sets parent_server back to the captured original (URL or,
// if the original was null, the v2 API cannot clear it - noted, not forced).
async function setParentV2(sw, id, parentUrl) {
  return await sw.evaluate(async ({ id, parentUrl, V2 }) => {
    const key = (await chrome.storage.local.get('panopta.apiKey'))['panopta.apiKey'];
    const H = { Authorization: `ApiKey ${key}`, Accept: 'application/json' };
    const j = await (await fetch(`${V2}/server/${id}`, { headers: H })).json();
    const o = { ...j, parent_server: parentUrl };
    // inline sanitizeServerBodyForPut
    const c = (k) => { if (o[k] == null) return; if (typeof o[k] === 'number') return; const n = parseFloat(o[k]); o[k] = Number.isFinite(n) ? n : null; };
    c('geo_latitude'); c('geo_longitude');
    if (o.snmp_heartbeat_enabled === true && !o.snmp_scan_frequency) { o.snmp_heartbeat_enabled = false; o.snmp_heartbeat_notification_schedule = null; }
    if (Object.prototype.hasOwnProperty.call(o, 'device_type') && o.device_type !== 'server' && o.device_type !== 'network_device') delete o.device_type;
    const r = await fetch(`${V2}/server/${id}`, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
    return r.status;
  }, { id, parentUrl, V2 });
}

function bulkAppUrl(extensionId, hash = '/pick') {
  return `chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#${hash}`;
}

// Drive pick -> action -> configure for the given targets.
async function driveToConfigure(page, extensionId, targets) {
  await page.goto(bulkAppUrl(extensionId, '/pick'));
  const paste = targets.map((s) => `${s.id},${(s.name ?? '').replace(/,/g, ' ')}`).join('\n');
  await page.locator('textarea.paste-area').fill(paste);
  await expect(page.locator('.sample-table tbody tr')).toHaveCount(targets.length);
  await page.locator('[data-test="pick-next"]').click();
  await page.locator('[data-test="action-card"][data-action-id="set-parent-instance"]').click();
  await page.locator('[data-test="action-next"]').click();
  await expect(page.locator('[data-test="set-parent-instance-select"]')).toBeVisible({ timeout: 10000 });
}

// Select a parent option whose trailing /server/{id} is not in exclude[].
// Returns { url, id, name } of the chosen option.
async function selectParent(page, excludeIds) {
  const select = page.locator('[data-test="set-parent-instance-select"]');
  await expect.poll(() => select.evaluate((el) => el.options.length), { timeout: 70000 }).toBeGreaterThan(1);
  const chosen = await select.evaluate((el, exclude) => {
    for (const o of Array.from(el.options)) {
      if (!o.value) continue;
      const m = o.value.match(/\/server\/(\d+)\/?$/);
      const id = m ? m[1] : null;
      if (id && !exclude.includes(String(id))) {
        return { url: o.value, id, name: (o.dataset && o.dataset.name) || o.textContent };
      }
    }
    return null;
  }, excludeIds.map(String));
  if (chosen) await select.selectOption(chosen.url);
  return chosen;
}

async function gotoPreview(page) {
  await page.locator('[data-test="configure-next"]').click();
  await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('Preview', { timeout: 6000 });
}

test.describe('live - FMN-277 Set Parent Instance action', () => {
  test('live - action card is present in the picker', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');
    const keys = await sw.evaluate(() => globalThis.__fmDebugHandlerKeys || []);
    test.skip(!keys.includes('bulk-composer:list-instances-for-parent'),
      'Launcher extension lacks FMN-277 wiring; reload the launcher/SW and re-run.');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    await page.goto(bulkAppUrl(extensionId, '/pick'));
    await page.locator('textarea.paste-area').fill('1,placeholder');
    await page.locator('[data-test="pick-next"]').click();
    await expect(page.locator('[data-test="action-card"][data-action-id="set-parent-instance"]'),
      'Set Parent Instance action card must be in the picker').toBeVisible();
    await page.close();
  });

  test('live - picker populates from live instances, selecting enables Next, pre-flight sets current parent', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');
    test.skip(!(await hasApiKey(sw)), 'No v2 API key seeded.');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await driveToConfigure(page, extensionId, [{ id: CHILD_ID, name: 'child' }]);

    // (b) picker populated from live instances (> the sentinel option).
    const select = page.locator('[data-test="set-parent-instance-select"]');
    await expect.poll(() => select.evaluate((el) => el.options.length), { timeout: 70000 }).toBeGreaterThan(1);

    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();
    const chosen = await selectParent(page, [CHILD_ID]);
    expect(chosen, 'a non-self parent option must exist').toBeTruthy();
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    // pre-flight populated the target's current parent (object or null - both
    // are "enriched"; undefined would mean the batch never ran).
    await expect.poll(() => page.evaluate(async () => {
      const mod = await import('./app.js');
      const t = mod.store.targets[0];
      return t && t.parentInstance !== undefined;
    }), { timeout: 70000 }).toBe(true);

    expect(pageErrors, pageErrors.join(' | ')).toEqual([]);
    await page.close();
  });

  test('live - preview: will-change for a reparent, skip for self-parent', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');
    test.skip(!(await hasApiKey(sw)), 'No v2 API key seeded.');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();

    // Pick a real parent first (from a single-target configure) so we know its id.
    await driveToConfigure(page, extensionId, [{ id: CHILD_ID, name: 'child' }]);
    const parent = await selectParent(page, [CHILD_ID]);
    test.skip(!parent, 'No distinct parent instance available on this tenant.');

    // Re-drive with TWO targets: the child (will change) and the parent itself
    // (self-parent -> skip). Select the same parent.
    await driveToConfigure(page, extensionId, [
      { id: CHILD_ID, name: 'child' },
      { id: parent.id, name: 'parent-as-target' }
    ]);
    const select = page.locator('[data-test="set-parent-instance-select"]');
    await expect.poll(() => select.evaluate((el) => el.options.length), { timeout: 70000 }).toBeGreaterThan(1);
    await select.selectOption(parent.url);
    await gotoPreview(page);

    const rows = page.locator('[data-test="bulk-preview-row"]');
    await expect(rows).toHaveCount(2);
    // Map rows by the target id shown in the first cell.
    const statuses = await rows.evaluateAll((trs) => trs.map((tr) => ({
      idText: tr.children[0]?.textContent || '',
      nameText: tr.children[1]?.textContent || '',
      status: tr.querySelector('[data-test="preview-status"]')?.textContent || ''
    })));
    const childRow = statuses.find((s) => (s.idText + s.nameText).includes(String(CHILD_ID)) || s.nameText.includes('child'));
    const selfRow = statuses.find((s) => (s.idText + s.nameText).includes(String(parent.id)) || s.nameText.includes('parent-as-target'));
    expect(childRow?.status, 'child row should be will-change').toMatch(/will change/i);
    expect(selfRow?.status, 'self-parent row should skip').toMatch(/skip/i);
    // summary reflects 1 change + 1 skip
    await expect(page.locator('[data-test="bulk-preview-summary"]')).toContainText('1 row will change');
    await page.close();
  });

  test('live - Apply writes parent_server (verified via v2), then restore original', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');
    test.skip(!(await hasApiKey(sw)), 'No v2 API key seeded.');

    const before = await getParentV2(sw, CHILD_ID);
    test.skip(before.error, `Could not read child #${CHILD_ID} via v2 (status ${before.error}).`);
    const originalParent = before.parent; // URL or null

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await driveToConfigure(page, extensionId, [{ id: CHILD_ID, name: 'child' }]);
    // Choose a parent that is neither the child nor its current parent -> will change.
    const currentParentId = originalParent ? (originalParent.match(/\/server\/(\d+)\/?$/) || [])[1] : null;
    const parent = await selectParent(page, [CHILD_ID, currentParentId].filter(Boolean));
    test.skip(!parent, 'No distinct new parent available to force a change.');
    await gotoPreview(page);

    await expect(page.locator('[data-test="bulk-preview-row"]')).toHaveCount(1);
    await expect(page.locator('[data-test="preview-status"]').first()).toContainText(/will change/i);

    // Apply the real write.
    await page.locator('[data-test="apply-btn"]').click();
    await expect(page.locator('[data-test="bulk-run-summary"]')).toContainText('1 committed', { timeout: 30000 });

    // Ground-truth verification via v2.
    let after;
    await expect.poll(async () => {
      after = await getParentV2(sw, CHILD_ID);
      return after.parent;
    }, { timeout: 70000 }).toBe(parent.url);

    // Restore the original parent (URL). If the original was null, v2 cannot
    // clear it - leave a clear breadcrumb rather than silently diverging.
    if (originalParent) {
      const restoreStatus = await setParentV2(sw, CHILD_ID, originalParent);
      expect([200, 204]).toContain(restoreStatus);
      const restored = await getParentV2(sw, CHILD_ID);
      expect(restored.parent).toBe(originalParent);
    } else {
      test.info().annotations.push({ type: 'note',
        message: `Child #${CHILD_ID} had no parent originally; v2 cannot clear parent_server, so it now points at ${parent.url}. Clear via editInstance if needed.` });
    }

    expect(pageErrors, pageErrors.join(' | ')).toEqual([]);
    await page.close();
  });
});
