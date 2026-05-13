// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-209: Configure step Jaccard-similarity threshold slider,
// per-cluster Union/Intersection strategy selector, and downloadable
// suggestions report.
//
// Stubs chrome.runtime.sendMessage for the same SW handlers the
// FMN-200 Configure spec stubs (memory: playwright_stub_chrome_runtime_only).
//
// Run: npx playwright test tests/e2e/fmn-209-jaccard-clustering.spec.js

import { test, expect } from './fixtures.js';

// Three FortiGate VM64-AWS with progressively different configs.
// Threshold 1.0 -> 3 clusters; 0.8 -> 2 clusters (devices A+B share
// ~31/32 keys; jaccard ~0.97); 0.5 -> still 2 (device C is disjoint).
const STUB_FSD = {
  61: { model_name: 'FortiGate', model_number: 'FGVM64-AWS', os_version: 'v7.6.3' },
  62: { model_name: 'FortiGate', model_number: 'FGVM64-AWS', os_version: 'v7.6.3' },
  63: { model_name: 'FortiGate', model_number: 'FGVM64-AWS', os_version: 'v7.6.3' }
};

function mkResources(keys) {
  return keys.map((k) => ({ textkey: k, name: k.toUpperCase() }));
}

const SHARED = Array.from({ length: 30 }, (_, i) => `r${i}`);
const STUB_MONITORING = {
  61: [{ textkey: 'fortinet.fortigate', name: 'cat', metrics: mkResources([...SHARED, 'r30', 'r31']) }],          // 32 keys
  62: [{ textkey: 'fortinet.fortigate', name: 'cat', metrics: mkResources([...SHARED, 'r30', 'r31', 'r32']) }],   // 33 keys
  63: [{ textkey: 'fortinet.fortigate', name: 'cat', metrics: mkResources(['x1', 'x2']) }]                        // disjoint
};

const STUB_PORTS = { 61: [0], 62: [0, 1], 63: [0] };

const STUB_SERVER_GROUPS = [
  { id: 617598, name: 'INCOMING SERVERS', resourceUrl: 'https://api2.panopta.com/v2/server_group/617598/' }
];

async function installSwStub(page) {
  await page.evaluate((args) => {
    const { fsd, mc, ps, groups } = args;
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function patched(msg, cb) {
      const type = msg?.type;
      const payload = msg?.payload || {};
      const respondWith = (result) => setTimeout(() => cb({ ok: true, result }), 0);
      const idsFor = (m) => Array.isArray(m.serverIds) ? m.serverIds : [];
      switch (type) {
        case 'bulk-composer:list-fabric-system-data': {
          const byServerId = {};
          for (const id of idsFor(payload)) byServerId[id] = fsd[id] ?? null;
          respondWith({ byServerId });
          return true;
        }
        case 'bulk-composer:list-monitoring-config-batch': {
          const byServerId = {};
          for (const id of idsFor(payload)) byServerId[id] = mc[id] ?? null;
          respondWith({ byServerId });
          return true;
        }
        case 'bulk-composer:list-port-scope-batch': {
          const byServerId = {};
          for (const id of idsFor(payload)) byServerId[id] = ps[id] ?? null;
          respondWith({ byServerId });
          return true;
        }
        case 'bulk-composer:list-server-groups':
          respondWith({ groups });
          return true;
      }
      return real(msg, cb);
    };
  }, { fsd: STUB_FSD, mc: STUB_MONITORING, ps: STUB_PORTS, groups: STUB_SERVER_GROUPS });
}

async function openConfigure(page, extensionId) {
  await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
  await installSwStub(page);
  await page.evaluate(async () => {
    const mod = await import('./app.js');
    mod.store.targets = [
      { id: 61, name: 'FGVM64-A', template_names: [] },
      { id: 62, name: 'FGVM64-B', template_names: [] },
      { id: 63, name: 'FGVM64-C', template_names: [] }
    ];
    mod.store.actionId = 'profile-and-create-templates';
    window.location.hash = '#/configure';
  });
  await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 10000 });
}

async function rowCount(page) {
  return page.locator('[data-test="configure-pact-row"]').count();
}

test.describe('FMN-209: Jaccard clustering controls', () => {
  test('default threshold 0.8 merges near-identical devices into a single cluster + outlier', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);
    // 0.8 should yield 2 clusters: {61,62} and {63}
    await expect.poll(() => rowCount(page)).toBe(2);
    // The merged cluster's resource cell should show a range "X-Y range"
    const cells = page.locator('[data-test="configure-pact-row"]');
    const mergedRow = cells.filter({ hasText: '32 (32-33 range)' }).or(cells.filter({ hasText: '33 (32-33 range)' }));
    await expect(mergedRow).toHaveCount(1);
    await page.close();
  });

  test('threshold 1.0 splits all three devices into separate clusters', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);
    const slider = page.locator('[data-test="configure-pact-threshold"]');
    await slider.evaluate((el) => { el.value = '1.0'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect.poll(() => rowCount(page)).toBe(3);
    await page.close();
  });

  test('per-cluster strategy selector flips proposed_resources between union and intersection', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);
    // Find the merged-cluster row (member count = 2)
    const rows = page.locator('[data-test="configure-pact-row"]');
    const mergedRow = rows.filter({ has: page.locator('td', { hasText: /^2$/ }) }).first();
    const strategy = mergedRow.locator('[data-test="configure-pact-strategy"]');
    await expect(strategy).toHaveValue('union');
    // Switch to intersection
    await strategy.selectOption('intersection');
    await expect(strategy).toHaveValue('intersection');
    // Verify store reflects strategy change
    const live = await page.evaluate(async () => {
      const mod = await import('./app.js');
      const merged = (mod.store.params?.clusters || []).find((c) => c.applies_to_server_ids.length === 2);
      return {
        strategy: merged?.resource_strategy,
        proposed_count: merged?.proposed_resources?.length,
        intersection_count: merged?.resource_intersection?.length,
        union_count: merged?.resource_union?.length
      };
    });
    expect(live.strategy).toBe('intersection');
    expect(live.proposed_count).toBe(live.intersection_count);
    expect(live.intersection_count).toBeLessThan(live.union_count);
    await page.close();
  });

  test('download report button triggers a JSON download with cluster metadata', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);
    // Wait for the button to enable (post initial fetch)
    const btn = page.locator('[data-test="configure-pact-download-report"]');
    await expect(btn).toBeEnabled({ timeout: 5000 });
    const downloadPromise = page.waitForEvent('download');
    await btn.click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    const report = JSON.parse(text);
    expect(report.schema_version).toBe(1);
    expect(report.summary.target_count).toBe(3);
    expect(report.summary.cluster_count).toBeGreaterThanOrEqual(2);
    expect(report.clusters[0]).toHaveProperty('proposed_template_name');
    expect(report.clusters[0]).toHaveProperty('resource_union');
    expect(report.clusters[0]).toHaveProperty('resource_intersection');
    expect(report.clusters[0]).toHaveProperty('member_devices');
    expect(Array.isArray(report.clusters[0].member_devices)).toBe(true);
    expect(download.suggestedFilename()).toMatch(/^template-suggestions-.*\.json$/);
    await page.close();
  });

  test('threshold slider re-cluster preserves per-cluster opt_in across thresholds when the cluster key matches', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);
    // At default 0.8, two clusters. Find the small/outlier and opt it out.
    const rows = page.locator('[data-test="configure-pact-row"]');
    const outlierRow = rows.filter({ has: page.locator('td', { hasText: /^1$/ }) }).first();
    const optIn = outlierRow.locator('[data-test="configure-pact-opt-in"]');
    await optIn.uncheck();
    // Lower the threshold to 0.5; cluster shape unchanged (disjoint outlier
    // stays separate), and opted_in state persists.
    const slider = page.locator('[data-test="configure-pact-threshold"]');
    await slider.evaluate((el) => { el.value = '0.5'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect.poll(() => rowCount(page)).toBe(2);
    const persisted = await page.evaluate(async () => {
      const mod = await import('./app.js');
      const outlier = (mod.store.params?.clusters || []).find((c) => c.applies_to_server_ids.length === 1);
      return outlier?.opted_in;
    });
    expect(persisted).toBe(false);
    await page.close();
  });
});
