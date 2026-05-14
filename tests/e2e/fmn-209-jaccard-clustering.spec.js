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
    // Verify the merge from store.params (strategy column was removed
    // so the resource-cell range string isn't a reliable selector).
    const merged = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return (mod.store.params?.clusters || []).find((c) => c.applies_to_server_ids.length === 2);
    });
    expect(merged).toBeTruthy();
    expect(merged.resource_intersection.length).toBeGreaterThanOrEqual(31);
    expect(merged.resource_union.length).toBeGreaterThanOrEqual(32);
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

  test('Strategy column is gone; all clusters default to union (FMN-211 follow-up)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);
    // Strategy selector was removed entirely; never renders.
    await expect(page.locator('[data-test="configure-pact-strategy"]')).toHaveCount(0);
    // Internal resource_strategy still defaults to 'union' on every cluster.
    const strategies = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return (mod.store.params?.clusters || []).map((c) => c.resource_strategy);
    });
    expect(strategies.length).toBeGreaterThan(0);
    for (const s of strategies) expect(s).toBe('union');
    await page.close();
  });

  test('Devices in scope column lists device names', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);
    const cells = page.locator('[data-test="configure-pact-devices"]');
    await expect(cells.first()).toBeVisible();
    const texts = await cells.allInnerTexts();
    expect(texts.some((t) => /FGVM64-A|FGVM64-B|FGVM64-C/.test(t))).toBe(true);
    await page.close();
  });

  test('Similarity slider label no longer says "Jaccard"', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);
    const labelText = await page.locator('label', { has: page.locator('[data-test="configure-pact-threshold"]') }).innerText();
    expect(labelText).toContain('Similarity threshold');
    expect(labelText).not.toContain('Jaccard');
    await page.close();
  });

  test('Download report (PDF) mounts a printable iframe with cluster + rationale content', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);
    // Stub window.print so the dialog never opens during the spec.
    await page.evaluate(() => {
      const orig = HTMLIFrameElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(orig, 'srcdoc');
      Object.defineProperty(orig, 'srcdoc', {
        configurable: true,
        set(value) {
          if (desc?.set) desc.set.call(this, value);
          // After srcdoc is set, the load event fires; stub the print
          // call inside the iframe before then by overriding window.print
          // on contentWindow once it exists.
          this.addEventListener('load', () => {
            try { if (this.contentWindow) this.contentWindow.print = () => {}; } catch { /* cross-origin */ }
          });
        },
        get() { return desc?.get?.call(this); }
      });
    });
    const btn = page.locator('[data-test="configure-pact-download-report-pdf"]');
    await expect(btn).toBeEnabled({ timeout: 5000 });
    await btn.click();
    // The iframe is appended to body; verify it exists and its srcdoc has expected content.
    const iframe = page.locator('[data-test="configure-pact-pdf-iframe"]');
    await expect(iframe).toHaveCount(1);
    const srcdoc = await iframe.getAttribute('srcdoc');
    expect(srcdoc).toContain('Template Suggestions Report');
    expect(srcdoc).toContain('Similarity threshold');
    expect(srcdoc).toMatch(/Rationale/);
    expect(srcdoc).toMatch(/FortiGate/);
    await page.close();
  });

  test('download report button triggers a CSV download with similarity rationale per device', async ({ extensionContext, extensionId }) => {
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

    // Banner contains run summary
    expect(text).toMatch(/^# Template Suggestions Report/);
    expect(text).toMatch(/# Similarity threshold: 0\.80/);
    expect(text).toMatch(/# Devices: 3/);
    // Header row present after the banner
    expect(text).toContain('cluster_id,proposed_template,make,model,cluster_size');
    expect(text).toContain('rationale');
    // Rationale strings appear for clustered devices
    expect(text).toMatch(/Seeded cluster|Joined cluster|Identical signature/);
    // Filename is .csv
    expect(download.suggestedFilename()).toMatch(/^template-suggestions-.*\.csv$/);
    await page.close();
  });

  test('threshold slider re-cluster preserves per-cluster opt_in across thresholds when the cluster key matches', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);
    // At default 0.8, two clusters. Find the outlier (single-device
    // cluster) by store; uncheck its opt-in via its row.
    const outlierKey = await page.evaluate(async () => {
      const mod = await import('./app.js');
      const outlier = (mod.store.params?.clusters || []).find((c) => c.applies_to_server_ids.length === 1);
      return outlier?.key;
    });
    expect(outlierKey).toBeTruthy();
    const outlierRow = page.locator(`[data-test="configure-pact-row"][data-cluster-key="${outlierKey}"]`);
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
