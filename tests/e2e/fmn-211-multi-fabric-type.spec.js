// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-211: Configure step handles mixed Fabric device types
// (FortiGate / FortiAP / FortiSwitch / FortiExtender) and the
// port-scope batch is only invoked for FortiGate ids (FMN-211 Phase D).
//
// Stubs chrome.runtime.sendMessage (per project memory
// playwright_stub_chrome_runtime_only.md). Tracks which serverIds the
// port-scope handler is asked about so we can assert the gate worked.
//
// Run: npx playwright test tests/e2e/fmn-211-multi-fabric-type.spec.js

import { test, expect } from './fixtures.js';

const STUB_FSD = {
  101: { model_name: 'FortiGate', model_number: 'FGVMA6', os_version: 'v7.6.3' },
  102: { model_name: 'FortiGate', model_number: 'FGVMA6', os_version: 'v7.6.3' },
  201: { model_name: 'FortiAP', model_number: 'FAP-431F', os_version: 'v7.4.1' },
  202: { model_name: 'FortiAP', model_number: 'FAP-431F', os_version: 'v7.4.1' },
  301: { model_name: 'FortiSwitch', model_number: 'FS-148E-POE', os_version: 'v7.4.1' },
  401: { model_name: 'FortiExtender', model_number: 'FXA21F', os_version: 'v7.4.1' }
};

const STUB_MC = {
  101: [{ textkey: 'fortinet.fortigate', name: 'FortiGate', metrics: [{ textkey: 'cpu', name: 'CPU' }] }],
  102: [{ textkey: 'fortinet.fortigate', name: 'FortiGate', metrics: [{ textkey: 'cpu', name: 'CPU' }] }],
  201: [{ textkey: 'fortinet.fortiap', name: 'FortiAP', metrics: [{ textkey: 'radio.signal', name: 'Radio Signal' }] }],
  202: [{ textkey: 'fortinet.fortiap', name: 'FortiAP', metrics: [{ textkey: 'radio.signal', name: 'Radio Signal' }] }],
  301: [{ textkey: 'fortinet.fortiswitch', name: 'FortiSwitch', metrics: [{ textkey: 'port.utilization', name: 'Port Utilization' }] }],
  401: [{ textkey: 'fortinet.fortiextender', name: 'FortiExtender', metrics: [{ textkey: 'signal.rsrp', name: 'RSRP' }] }]
};

const STUB_PORTS_FG = { 101: [0, 1], 102: [0, 1] };

const STUB_GROUPS = [
  { id: 617598, name: 'INCOMING SERVERS', resourceUrl: 'https://api2.panopta.com/v2/server_group/617598/' }
];

async function installSwStub(page) {
  await page.evaluate((args) => {
    const { fsd, mc, psFg, groups } = args;
    // Track which serverIds each handler is asked about.
    window.__fmnPortScopeCalls = [];
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
          const ids = idsFor(payload);
          window.__fmnPortScopeCalls.push([...ids]);
          const byServerId = {};
          for (const id of ids) byServerId[id] = psFg[id] ?? null;
          respondWith({ byServerId });
          return true;
        }
        case 'bulk-composer:list-server-groups':
          respondWith({ groups });
          return true;
      }
      return real(msg, cb);
    };
  }, { fsd: STUB_FSD, mc: STUB_MC, psFg: STUB_PORTS_FG, groups: STUB_GROUPS });
}

async function openConfigure(page, extensionId, targets) {
  await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
  await installSwStub(page);
  await page.evaluate(async (targets) => {
    const mod = await import('./app.js');
    mod.store.targets = targets;
    mod.store.actionId = 'profile-and-create-templates';
    window.location.hash = '#/configure';
  }, targets);
  await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 10000 });
}

test.describe('FMN-211: Multi-Fabric type support', () => {
  test('mixed-type pick produces one cluster per (Make, Model)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, [
      { id: 101, name: 'FGVMA6-A', template_names: [] },
      { id: 102, name: 'FGVMA6-B', template_names: [] },
      { id: 201, name: 'FAP-X', template_names: [] },
      { id: 202, name: 'FAP-Y', template_names: [] },
      { id: 301, name: 'FSW-1', template_names: [] },
      { id: 401, name: 'FEX-1', template_names: [] }
    ]);
    // 4 device classes -> 4 clusters (FortiGate pair, FortiAP pair, lone Switch, lone Extender)
    const rows = page.locator('[data-test="configure-pact-row"]');
    await expect.poll(() => rows.count()).toBe(4);
    await page.close();
  });

  test('port-scope batch is invoked for ALL Fabric ids (FMN-211 Phase A reverted the FortiGate-only gate)', async ({ extensionContext, extensionId }) => {
    // FMN-211 Phase A discovery: /onboarding/getDevicePorts returns
    // populated ports[] on Fabric FortiAP and Fabric FortiSwitch, not
    // only FortiGate. Earlier gate dropped that data; now we call with
    // every id and let the SW handler return null per id that fails.
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, [
      { id: 101, name: 'FGVMA6-A', template_names: [] },
      { id: 201, name: 'FAP-X', template_names: [] },
      { id: 301, name: 'FSW-1', template_names: [] }
    ]);
    const calls = await page.evaluate(() => window.__fmnPortScopeCalls);
    expect(calls.length).toBe(1);
    expect(calls[0].sort()).toEqual([101, 201, 301]);
    await page.close();
  });

  test('per-cluster template_type is fetched from get-create-template-defaults SW handler', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    // Install a stub that responds to get-create-template-defaults with
    // a per-id value so we can assert it lands on the cluster.
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
    await page.evaluate((args) => {
      const { fsd, mc, psFg, groups } = args;
      window.__fmnPortScopeCalls = [];
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
            respondWith({ byServerId });
            return true;
          }
          case 'bulk-composer:list-server-groups':
            respondWith({ groups });
            return true;
          case 'bulk-composer:get-create-template-defaults':
            // FortiGate -> fabric_template; FortiAP -> fabric_template
            // (real captures showed Fabric FortiAP returns fabric_template,
            // not network_device_template). Echo the id so we can verify
            // the cluster's sample_device_id was used.
            respondWith({ defaults: { template_type_options: [{ value: payload.serverId === 201 ? 'fabric_template_ap' : 'fabric_template', label: 'X' }] } });
            return true;
        }
        return real(msg, cb);
      };
    }, { fsd: STUB_FSD, mc: STUB_MC, psFg: STUB_PORTS_FG, groups: STUB_GROUPS });

    await page.evaluate(async () => {
      const mod = await import('./app.js');
      mod.store.targets = [
        { id: 101, name: 'FGVMA6-A', template_names: [] },
        { id: 201, name: 'FAP-X', template_names: [] }
      ];
      mod.store.actionId = 'profile-and-create-templates';
      window.location.hash = '#/configure';
    });
    await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 10000 });

    // Wait for the async defaults fetch to stitch in. Poll the store.
    await expect.poll(async () => page.evaluate(async () => {
      const mod = await import('./app.js');
      const map = {};
      for (const c of (mod.store.params?.clusters || [])) map[c.make] = c.template_type;
      return map;
    })).toEqual({ FortiGate: 'fabric_template', FortiAP: 'fabric_template_ap' });
    await page.close();
  });

  test('FortiAP cluster carries fortinet.fortiap plugin_textkey on proposed_resources', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, [
      { id: 201, name: 'FAP-X', template_names: [] },
      { id: 202, name: 'FAP-Y', template_names: [] }
    ]);
    const clusters = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return (mod.store.params?.clusters || []).map((c) => ({
        make: c.make,
        plugin_textkeys: (c.proposed_resources || []).map((r) => r.plugin_textkey)
      }));
    });
    expect(clusters.length).toBe(1);
    expect(clusters[0].make).toBe('FortiAP');
    expect(clusters[0].plugin_textkeys).toEqual(['fortinet.fortiap']);
    await page.close();
  });
});
