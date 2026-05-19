// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-211 live Playwright spec: drives Profile + Create Templates against
// the operator's authenticated Chromium for non-FortiGate Fabric device
// classes (FortiAP / FortiSwitch). Mirrors fmn-200-profile-and-create-templates-live.spec.js
// and reuses the same CDP fixture + dry-run / live-commit gating.
//
// Phase F live QA needs a tenant that has Fabric FortiAPs and Fabric
// FortiSwitches. Device IDs are operator-supplied via env vars rather
// than hardcoded, since they vary per tenant.
//
// USAGE
//   # Dry-run cross-Fabric (no writes):
//   FMN_FORTIAP_IDS=12345,23456 \
//   FMN_FORTISWITCH_IDS=34567 \
//     npx playwright test tests/e2e/fmn-211-multi-fabric-type-live.spec.js
//
//   # Live-commit one FortiAP (writes!):
//   FMN_FORTIAP_IDS=12345 FMN_LIVE_COMMIT=1 \
//     npx playwright test tests/e2e/fmn-211-multi-fabric-type-live.spec.js
//
//   # Live-commit one FortiSwitch (writes!):
//   FMN_FORTISWITCH_IDS=34567 FMN_LIVE_COMMIT=1 \
//     npx playwright test tests/e2e/fmn-211-multi-fabric-type-live.spec.js
//
// Prereq: persistent launcher Chromium logged into the tenant.
//   node tools/dev/launcher.mjs

import { test as base, expect, chromium } from '@playwright/test';

const FM = 'https://fortimonitor.forticloud.com';
const CDP_URL = `http://localhost:${process.env.FMN_CDP_PORT || '9222'}`;

function parseIds(envVar) {
  const raw = process.env[envVar];
  if (!raw) return [];
  return raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

const FORTIAP_IDS = parseIds('FMN_FORTIAP_IDS');
const FORTISWITCH_IDS = parseIds('FMN_FORTISWITCH_IDS');
const FORTIGATE_IDS = parseIds('FMN_FORTIGATE_IDS');

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

async function pickThenAction(page, ids) {
  const pasteValue = ids.map((id) => `${id},dev-${id}`).join('\n');
  await page.locator('textarea.paste-area').fill(pasteValue);
  await expect(page.locator('.sample-table tbody tr')).toHaveCount(ids.length, { timeout: 5000 });
  await page.locator('[data-test="pick-next"]').click();

  await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('2. Pick action', { timeout: 5000 });
  await page.locator('[data-test="action-card"][data-action-id="profile-and-create-templates"]').click();
  await page.locator('[data-test="action-next"]').click();

  await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('3. Configure', { timeout: 5000 });
  await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 30000 });
}

async function readClusters(page) {
  return await page.evaluate(async () => {
    const mod = await import('./app.js');
    return (mod.store.params?.clusters || []).map((c) => ({
      key: c.key,
      make: c.make,
      model: c.model,
      template_type: c.template_type,
      device_count: (c.applies_to_server_ids || []).length,
      resource_count: (c.proposed_resources || []).length,
      plugin_textkeys: [...new Set((c.proposed_resources || []).map((r) => r.plugin_textkey))]
    }));
  });
}

test.describe('live FMN-211 cross-Fabric Profile + Create Templates', () => {
  test('live - dry-run: mixed pick produces one cluster per (Make, Model) with per-cluster template_type', async ({ liveCtx }) => {
    const allIds = [...FORTIAP_IDS, ...FORTISWITCH_IDS, ...FORTIGATE_IDS];
    test.skip(allIds.length === 0, 'Set at least one of FMN_FORTIAP_IDS / FMN_FORTISWITCH_IDS / FMN_FORTIGATE_IDS to run.');

    const { ctx, sw } = liveCtx;
    test.skip(!sw, 'No SW connected.');
    const hasKey = await apiKeyConfigured(sw);
    test.skip(!hasKey, 'No API key configured; skipping live dry-run.');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    await page.goto(bulkAppUrl(extensionId, '/pick'));
    await pickThenAction(page, allIds);

    const clusters = await readClusters(page);
    console.log('[live] clusters:', JSON.stringify(clusters, null, 2));
    expect(clusters.length).toBeGreaterThan(0);

    // Acceptance: each cluster carries a non-null template_type sourced
    // from /config/get_create_server_template_data per representative
    // device. The Phase A discovery comment flagged this as the unknown
    // (whether non-FortiGate accept fabric_template); failing template_type
    // here is the loud signal.
    for (const c of clusters) {
      expect(c.template_type, `cluster ${c.make}/${c.model} has null template_type — get-create-template-defaults handler did not stitch in`).toBeTruthy();
      expect(c.plugin_textkeys, `cluster ${c.make}/${c.model} has empty plugin_textkeys`).not.toEqual([]);
      // Plugin textkey must match the cluster's make. Cross-make leakage
      // is the FMN-211 regression-guard from the unit suite, but we
      // verify it lands in the live wire path too.
      const expectedTextkey = {
        FortiGate: 'fortinet.fortigate',
        FortiAP: 'fortinet.fortiap',
        FortiSwitch: 'fortinet.fortiswitch',
        FortiExtender: 'fortinet.fortiextender'
      }[c.make];
      if (expectedTextkey) {
        expect(c.plugin_textkeys, `cluster ${c.make} has wrong plugin_textkey`).toContain(expectedTextkey);
      }
    }

    // Pick a destination group + dry-run + walk to Preview.
    const groupOptions = await page.locator('[data-test="configure-pact-destination-group"] option').evaluateAll((els) => els.map((e) => ({ value: e.value, label: e.textContent })));
    const firstRealGroup = groupOptions.find((o) => o.value && o.value !== '__new__');
    expect(firstRealGroup, 'No existing server groups returned').toBeTruthy();
    await page.locator('[data-test="configure-pact-destination-group"]').selectOption(firstRealGroup.value);
    await page.locator('[data-test="configure-pact-dry-run"]').check();
    await page.locator('[data-test="configure-next"]').click();

    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('4. Preview', { timeout: 5000 });
    await page.locator('[data-test="apply-btn"]').click();

    await page.waitForTimeout(8000);
    const summary = await page.locator('[data-test="bulk-run-summary"]').textContent().catch(() => null);
    console.log('[live] dry-run summary:', summary);
    const rowDetails = await page.locator('[data-test="bulk-preview-row"]').evaluateAll((rows) => rows.map((r) => (r.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200)));
    for (const r of rowDetails) console.log('[live] dry-run row:', r);

    expect(rowDetails.length).toBeGreaterThan(0);
    const anyFailed = rowDetails.some((r) => /failed|error/i.test(r));
    expect(anyFailed, `Some rows reported failure: ${JSON.stringify(rowDetails, null, 2)}`).toBe(false);

    await page.close();
  });

  // -------------------------------------------------------------------
  // Live-commit per device class. Each test picks ONE id of its class,
  // creates a uniquely-named template, post-verifies via list-templates,
  // and prints cleanup info. Gated behind FMN_LIVE_COMMIT=1.
  // -------------------------------------------------------------------
  for (const klass of [
    { name: 'FortiAP', ids: FORTIAP_IDS, expectedTextkey: 'fortinet.fortiap' },
    { name: 'FortiSwitch', ids: FORTISWITCH_IDS, expectedTextkey: 'fortinet.fortiswitch' }
  ]) {
    test(`live commit: one ${klass.name}, clone-from-device, creates + attaches template`, async ({ liveCtx }) => {
      test.skip(process.env.FMN_LIVE_COMMIT !== '1', 'Live-commit gated; set FMN_LIVE_COMMIT=1 to enable.');
      test.skip(klass.ids.length === 0, `No ${klass.name} ids supplied; set FMN_${klass.name.toUpperCase()}_IDS.`);

      const { ctx, sw } = liveCtx;
      test.skip(!sw, 'No SW connected.');
      const hasKey = await apiKeyConfigured(sw);
      test.skip(!hasKey, 'No API key configured.');
      const extensionId = sw.url().split('/')[2];

      // Warm the SW (FMN-200 live spec pattern).
      await sw.evaluate(async () => {
        const keys = globalThis.__fmDebugHandlerKeys || [];
        return keys.length;
      });
      const page = await ctx.newPage();
      await page.goto(bulkAppUrl(extensionId, '/pick'));

      const ONE_TARGET = klass.ids[0];
      await pickThenAction(page, [ONE_TARGET]);

      // Verify the single cluster has the right make + plugin_textkey
      // BEFORE we commit. Catches a misclassified device early.
      const clusters = await readClusters(page);
      console.log(`[live-commit-${klass.name}] clusters:`, JSON.stringify(clusters, null, 2));
      expect(clusters.length).toBe(1);
      expect(clusters[0].make).toBe(klass.name);
      expect(clusters[0].plugin_textkeys).toContain(klass.expectedTextkey);
      expect(clusters[0].template_type).toBeTruthy();

      // Pick "FM Toolkit Templates" if available, else first real group.
      const groupOptions = await page.locator('[data-test="configure-pact-destination-group"] option').evaluateAll((els) => els.map((e) => ({ value: e.value, label: e.textContent })));
      const fmToolkit = groupOptions.find((o) => /FM Toolkit Templates/i.test(o.label || ''));
      const target = fmToolkit || groupOptions.find((o) => o.value && o.value !== '__new__');
      expect(target).toBeTruthy();
      await page.locator('[data-test="configure-pact-destination-group"]').selectOption(target.value);

      // Stamp a unique template name to force CREATE.
      const stamp = `FMN-211-${klass.name}-verify-${Date.now()}`;
      await page.evaluate(async (stamp) => {
        const mod = await import('./app.js');
        const recs = (mod.store.params?.clusters || []).map((c) => ({ ...c, proposed_template_name: stamp }));
        mod.store.params = { ...mod.store.params, clusters: recs };
      }, stamp);
      const nameInput = page.locator('[data-test="configure-pact-template-name"]').first();
      await nameInput.fill(stamp);

      await expect(page.locator('[data-test="configure-pact-dry-run"]')).not.toBeChecked();
      await page.locator('[data-test="configure-next"]').click();
      await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('4. Preview', { timeout: 5000 });
      console.log(`[live-commit-${klass.name}] template name:`, stamp, ' destination group:', target.value);

      await page.evaluate(async () => {
        const mod = await import('../../lib/messaging.js');
        globalThis.__rowEvents = [];
        mod.onEvent((name, payload) => {
          if (name === 'bulk-composer:row-start' || name === 'bulk-composer:row-done') {
            globalThis.__rowEvents.push({ name, payload });
          }
        });
      });

      page.on('console', (m) => {
        const txt = m.text();
        if (/error|fail|throw|exception/i.test(txt) || m.type() === 'error') {
          console.log(`[page-console-${m.type()}]`, txt);
        }
      });
      page.on('pageerror', (e) => console.log('[page-pageerror]', e.message));

      const t0 = Date.now();
      await page.locator('[data-test="apply-btn"]').click();

      let summary = '';
      for (let i = 0; i < 36; i++) {
        summary = (await page.locator('[data-test="bulk-run-summary"]').textContent()) || '';
        const rowText = await page.locator('[data-test="bulk-preview-row"]').evaluateAll((rs) => rs.map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)));
        const events = await page.evaluate(() => globalThis.__rowEvents || []);
        console.log(`[live-commit-${klass.name} t+${((Date.now() - t0) / 1000).toFixed(1)}s] summary=${JSON.stringify(summary)} rowEvents=${events.length}`);
        for (const r of rowText) console.log('    row:', r);
        for (const e of events.slice(-3)) console.log('    evt:', e.name, JSON.stringify(e.payload).slice(0, 200));
        if (/complete/i.test(summary)) break;
        await page.waitForTimeout(5000);
      }
      if (!/complete/i.test(summary)) {
        throw new Error(`bulk-run-summary never reached "complete" within 180s; last summary=${JSON.stringify(summary)}`);
      }
      const rowDetails = await page.locator('[data-test="bulk-preview-row"]').evaluateAll((rows) => rows.map((r) => (r.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300)));
      for (const r of rowDetails) console.log(`[live-commit-${klass.name}] row:`, r);

      const events = await page.evaluate(() => globalThis.__rowEvents || []);
      console.log(`[live-commit-${klass.name}] row events:`, JSON.stringify(events, null, 2));

      const anyFailed = rowDetails.some((r) => /failed|error/i.test(r));
      expect(anyFailed, `Some rows reported failure on live commit: ${JSON.stringify(rowDetails, null, 2)}`).toBe(false);

      // Post-verify via v2 listTemplates.
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
      console.log(`[live-commit-${klass.name}] post-verify list-templates:`, JSON.stringify(verify, null, 2));
      expect(verify.found, `Template "${stamp}" not found in tenant template list after commit`).toBeTruthy();

      console.log(`[live-commit-${klass.name}] CLEANUP: delete template id ${verify.found?.id} ("${stamp}") in FortiMonitor UI`);

      await page.close();
    });
  }
});
