// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-200 live Playwright spec: drives the Profile + Create Templates
// action end-to-end against the operator's authenticated Chromium via
// CDP (tools/dev/launcher.mjs). Mirrors tests/e2e/fmn-155-bulk-composer-live.spec.js.
//
// Tests are split so the dry-run path can be exercised without touching
// the tenant. The live-commit test is gated behind FMN_LIVE_COMMIT=1 so
// it's opt-in - automated Claude QA should run the dry-run pass first,
// surface findings, and only run live-commit after explicit operator
// approval.
//
// Run dry-run only:  npx playwright test tests/e2e/fmn-200-profile-and-create-templates-live.spec.js
// Run live commit:   FMN_LIVE_COMMIT=1 npx playwright test tests/e2e/fmn-200-profile-and-create-templates-live.spec.js

import { test as base, expect, chromium } from '@playwright/test';

const FM = 'https://fortimonitor.forticloud.com';
const CDP_URL = `http://localhost:${process.env.FMN_CDP_PORT || '9222'}`;

// Test targets per project CLAUDE.md (Fabric FortiGate VMs).
const TARGET_IDS = [42024061, 42024060, 42024075];

const test = base.extend({
  liveCtx: [async ({}, use) => {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
    } catch (e) {
      throw new Error(
        `Could not connect to Chromium at ${CDP_URL}. ` +
        `Start the persistent launcher first: \`node tools/dev/launcher.mjs\`. ` +
        `Underlying: ${e.message}`
      );
    }
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('CDP browser has no contexts');
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
    const fmPage = ctx.pages().find((p) => p.url().startsWith(FM));
    if (!fmPage) {
      throw new Error('No FortiMonitor tab open in the launcher Chromium. Log in to FortiMonitor in that window and re-run.');
    }
    if (await fmPage.locator('input[type="password"]').count()) {
      throw new Error('FortiMonitor is at /login. Sign in in the launcher window and re-run.');
    }
    await use({ ctx, sw, browser });
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

function bulkAppUrl(extensionId, hash = '/pick') {
  return `chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#${hash}`;
}

test.describe('live FMN-200 Profile + Create Templates', () => {
  test('live - SW handlers registered (no stale build)', async ({ liveCtx }) => {
    const { sw } = liveCtx;
    test.skip(!sw, 'No SW connected.');
    const keys = await sw.evaluate(() => globalThis.__fmDebugHandlerKeys || []);
    for (const k of [
      'bulk-composer:list-fabric-system-data',
      'bulk-composer:list-monitoring-config-batch',
      'bulk-composer:list-port-scope-batch',
      'bulk-composer:list-server-groups',
      'bulk-composer:ensure-template',
      'bulk-composer:commit'
    ]) {
      expect(keys, `Missing handler ${k} - extension may be a stale build; reload via chrome://extensions and re-run.`).toContain(k);
    }
  });

  test('live - dry-run end-to-end: pick → action → configure → preview & commit shows no-write results', async ({ liveCtx }) => {
    const { ctx, sw } = liveCtx;
    test.skip(!sw, 'No SW connected.');
    const hasKey = await apiKeyConfigured(sw);
    test.skip(!hasKey, 'No API key configured; skipping live dry-run.');
    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    await page.goto(bulkAppUrl(extensionId, '/pick'));

    // Pick step (FMN-163 paste-area)
    const pasteValue = TARGET_IDS.map((id) => `${id},dev-${id}`).join('\n');
    await page.locator('textarea.paste-area').fill(pasteValue);
    await expect(page.locator('.sample-table tbody tr')).toHaveCount(TARGET_IDS.length, { timeout: 5000 });
    await expect(page.locator('[data-test="pick-next"]')).toBeEnabled();
    await page.locator('[data-test="pick-next"]').click();

    // Action step: pick profile-and-create-templates
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('2. Pick action', { timeout: 5000 });
    await page.locator('[data-test="action-card"][data-action-id="profile-and-create-templates"]').click();
    await page.locator('[data-test="action-next"]').click();

    // Configure step: wait for cluster table to render
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('3. Configure', { timeout: 5000 });
    await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 30000 });

    // Dump cluster summary so the test output shows what the live tenant
    // produced (handy when iterating against real data).
    const clusters = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return (mod.store.params?.clusters || []).map((c) => ({
        key: c.key, make: c.make, model: c.model,
        device_count: (c.applies_to_server_ids || []).length,
        resource_count: (c.proposed_resources || []).length,
        port_signature: c.port_signature,
        opted_in: c.opted_in, clone_from_device: c.clone_from_device
      }));
    });
    console.log('[live] clusters:', JSON.stringify(clusters, null, 2));

    expect(clusters.length).toBeGreaterThan(0);

    // Pick a destination group + toggle dry-run + advance
    const groupOptions = await page.locator('[data-test="configure-pact-destination-group"] option').evaluateAll((els) => els.map((e) => ({ value: e.value, label: e.textContent })));
    console.log('[live] available groups:', JSON.stringify(groupOptions, null, 2));
    const firstRealGroup = groupOptions.find((o) => o.value && o.value !== '__new__');
    expect(firstRealGroup, 'No existing server groups returned - cannot dry-run without picking one').toBeTruthy();
    await page.locator('[data-test="configure-pact-destination-group"]').selectOption(firstRealGroup.value);
    await page.locator('[data-test="configure-pact-dry-run"]').check();
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();
    await page.locator('[data-test="configure-next"]').click();

    // Commit step: click Apply, observe per-row results
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('4. Preview', { timeout: 5000 });
    const applyBtn = page.locator('[data-test="apply-btn"]');
    await expect(applyBtn).toBeVisible({ timeout: 5000 });
    const previewRowsBefore = await page.locator('[data-test="bulk-preview-row"]').count();
    console.log('[live] preview rows (pre-click):', previewRowsBefore);
    await applyBtn.click();

    // Wait for per-row events to settle.
    await page.waitForTimeout(8000);
    const runSummary = await page.locator('[data-test="bulk-run-summary"]').textContent().catch(() => null);
    console.log('[live] run summary:', runSummary);
    const rowDetails = await page.locator('[data-test="bulk-preview-row"]').evaluateAll((rows) => rows.map((r) => ({
      text: (r.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200)
    })));
    console.log('[live] dry-run per-row results:');
    for (const r of rowDetails) console.log('  ', r.text);

    // In dry-run mode the action commit should not throw; every row
    // should report a non-error result with dry_run/would_attach signals.
    expect(rowDetails.length).toBeGreaterThan(0);
    const anyFailed = rowDetails.some((r) => /failed|error/i.test(r.text));
    expect(anyFailed, `Some rows reported failure: ${JSON.stringify(rowDetails, null, 2)}`).toBe(false);

    await page.close();
  });

  // -------------------------------------------------------------------
  // Live-commit (writes!) - opt-in via FMN_LIVE_COMMIT=1
  // -------------------------------------------------------------------
  test('live commit: one Fabric device, clone-from-device, creates + attaches template', async ({ liveCtx }) => {
    test.skip(process.env.FMN_LIVE_COMMIT !== '1', 'Live-commit gated; set FMN_LIVE_COMMIT=1 to enable.');
    const { ctx, sw } = liveCtx;
    test.skip(!sw, 'No SW connected.');
    const hasKey = await apiKeyConfigured(sw);
    test.skip(!hasKey, 'No API key configured.');
    const extensionId = sw.url().split('/')[2];

    // Warm the SW: send a no-op message and wait for any reply. After a
    // chrome.runtime.reload() the SW takes a few hundred ms to register
    // all its onMessage handlers; firing the Configure step's fetches
    // before then results in undefined responses and a hung table.
    await sw.evaluate(async () => {
      // Touch the global handler registry to ensure all handlers wired
      // up. Returns synchronously once service-worker.js has run.
      const keys = globalThis.__fmDebugHandlerKeys || [];
      return keys.length;
    });
    const page = await ctx.newPage();
    await page.goto(bulkAppUrl(extensionId, '/pick'));

    // Pick ONE device.
    const ONE_TARGET = TARGET_IDS[0];
    await page.locator('textarea.paste-area').fill(`${ONE_TARGET},dev-${ONE_TARGET}`);
    await expect(page.locator('.sample-table tbody tr')).toHaveCount(1, { timeout: 5000 });
    await page.locator('[data-test="pick-next"]').click();

    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('2. Pick action', { timeout: 5000 });
    await page.locator('[data-test="action-card"][data-action-id="profile-and-create-templates"]').click();
    await page.locator('[data-test="action-next"]').click();

    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('3. Configure', { timeout: 5000 });
    await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 30000 });

    // Pick "FM Toolkit Templates" if available, else first real group.
    const groupOptions = await page.locator('[data-test="configure-pact-destination-group"] option').evaluateAll((els) => els.map((e) => ({ value: e.value, label: e.textContent })));
    const fmToolkit = groupOptions.find((o) => /FM Toolkit Templates/i.test(o.label || ''));
    const target = fmToolkit || groupOptions.find((o) => o.value && o.value !== '__new__');
    expect(target).toBeTruthy();
    await page.locator('[data-test="configure-pact-destination-group"]').selectOption(target.value);

    // Override the cluster's template name with a unique timestamp so we
    // exercise the CREATE path (not just reuse) on first run.
    const stamp = `FMN-200-verify-${Date.now()}`;
    await page.evaluate(async (stamp) => {
      const mod = await import('./app.js');
      const recs = (mod.store.params?.clusters || []).map((c) => ({ ...c, proposed_template_name: stamp }));
      mod.store.params = { ...mod.store.params, clusters: recs };
    }, stamp);

    // Reflect the new name in the input so describe() picks it up.
    const nameInput = page.locator('[data-test="configure-pact-template-name"]').first();
    await nameInput.fill(stamp);

    // Live mode: dry-run OFF (default after refresh).
    await expect(page.locator('[data-test="configure-pact-dry-run"]')).not.toBeChecked();
    await page.locator('[data-test="configure-next"]').click();
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('4. Preview', { timeout: 5000 });

    console.log('[live-commit] template name:', stamp, ' destination group:', target.value);

    // Subscribe to per-row events from the page so we can see the
    // actual action.commit() result detail (not just the UI summary).
    await page.evaluate(async () => {
      const mod = await import('../../lib/messaging.js');
      globalThis.__rowEvents = [];
      mod.onEvent((name, payload) => {
        if (name === 'bulk-composer:row-start' || name === 'bulk-composer:row-done') {
          globalThis.__rowEvents.push({ name, payload });
        }
      });
    });

    // Capture page console output so we see SW-relayed errors live.
    page.on('console', (m) => {
      const txt = m.text();
      if (/error|fail|throw|exception/i.test(txt) || m.type() === 'error') {
        console.log(`[page-console-${m.type()}]`, txt);
      }
    });
    page.on('pageerror', (e) => console.log('[page-pageerror]', e.message));

    // Commit
    const t0 = Date.now();
    await page.locator('[data-test="apply-btn"]').click();

    // Poll every 5s; on each poll dump current row state + run-summary
    // + recent row events, so we can see exactly when (and how) action.commit
    // stalls. Cap at 180s.
    let summary = '';
    for (let i = 0; i < 36; i++) {
      summary = (await page.locator('[data-test="bulk-run-summary"]').textContent()) || '';
      const rowText = await page.locator('[data-test="bulk-preview-row"]').evaluateAll((rs) => rs.map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)));
      const events = await page.evaluate(() => globalThis.__rowEvents || []);
      console.log(`[live-commit t+${((Date.now() - t0) / 1000).toFixed(1)}s] summary=${JSON.stringify(summary)} rowEvents=${events.length}`);
      for (const r of rowText) console.log('    row:', r);
      for (const e of events.slice(-3)) console.log('    evt:', e.name, JSON.stringify(e.payload).slice(0, 200));
      if (/complete/i.test(summary)) break;
      await page.waitForTimeout(5000);
    }
    if (!/complete/i.test(summary)) {
      throw new Error(`bulk-run-summary never reached "complete" within 180s; last summary=${JSON.stringify(summary)}`);
    }
    console.log('[live-commit] final run summary:', summary);
    const rowDetails = await page.locator('[data-test="bulk-preview-row"]').evaluateAll((rows) => rows.map((r) => (r.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300)));
    for (const r of rowDetails) console.log('[live-commit] row:', r);

    // Dump the actual row events (with full result detail).
    const events = await page.evaluate(() => globalThis.__rowEvents || []);
    console.log('[live-commit] row events:');
    console.log(JSON.stringify(events, null, 2));

    // No failed rows.
    const anyFailed = rowDetails.some((r) => /failed|error/i.test(r));
    expect(anyFailed, `Some rows reported failure on live commit: ${JSON.stringify(rowDetails, null, 2)}`).toBe(false);

    // Post-verify: the template should exist via v2 listTemplates.
    // Run from the page (not the SW) so chrome.runtime.sendMessage
    // actually routes to the SW handler dispatcher.
    const verify = await page.evaluate(async (stamp) => {
      try {
        const t = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'bulk-composer:list-templates' }, resolve);
        });
        const list = t?.result || t || [];
        const hit = list.find((x) => x.name === stamp);
        return { ok: true, foundCount: list.length, found: hit ? { id: hit.id, name: hit.name } : null };
      } catch (e) { return { ok: false, error: e.message }; }
    }, stamp);
    console.log('[live-commit] post-verify list-templates:', JSON.stringify(verify, null, 2));
    expect(verify.found, `Template "${stamp}" not found in tenant template list after commit`).toBeTruthy();

    // Note: operator must manually clean up the new template via
    // FortiMonitor UI. Print the id for ease.
    console.log(`[live-commit] CLEANUP: delete template id ${verify.found?.id} ("${stamp}") in FortiMonitor UI`);

    await page.close();
  });
});
