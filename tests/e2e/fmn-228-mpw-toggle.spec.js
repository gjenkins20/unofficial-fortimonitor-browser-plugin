// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-228: optional MPW-authoring step in Profile + Create Templates.
//
// Configure step gains a "Also create a monitoring-policy workflow per
// cluster..." toggle. This spec verifies the toggle is present, default
// off, and that flipping it updates store.params.create_mpws.
//
// The MPW write paths themselves are exercised by the descriptor unit
// suite (extension/tests/profile-and-create-templates-mpw.test.js).
//
// Run: npx playwright test tests/e2e/fmn-228-mpw-toggle.spec.js

import { test, expect } from './fixtures.js';

const STUB_FSD = {
  61: { model_name: 'FortiGate', model_number: 'FGVM64-AWS', os_version: 'v7.6.3' },
  62: { model_name: 'FortiGate', model_number: 'FGVM64-AWS', os_version: 'v7.6.3' }
};

function mkResources(keys) { return keys.map((k) => ({ textkey: k, name: k.toUpperCase() })); }

const SHARED = Array.from({ length: 30 }, (_, i) => `r${i}`);
const STUB_MONITORING = {
  61: [{ textkey: 'fortinet.fortigate', name: 'cat', metrics: mkResources([...SHARED, 'r30', 'r31']) }],
  62: [{ textkey: 'fortinet.fortigate', name: 'cat', metrics: mkResources([...SHARED, 'r30', 'r31']) }]
};

const STUB_PORTS = { 61: [0], 62: [0] };
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
      { id: 62, name: 'FGVM64-B', template_names: [] }
    ];
    mod.store.actionId = 'profile-and-create-templates';
    window.location.hash = '#/configure';
  });
  await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 10000 });
}

test.describe('FMN-228: MPW-authoring toggle', () => {
  test('toggle is present, default off, propagates to store.params.create_mpws', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);

    const toggle = page.locator('[data-test="configure-pact-create-mpws"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();

    // Default value in params: undefined or false
    const before = await page.evaluate(async () => (await import('./app.js')).store.params?.create_mpws);
    expect(before).not.toBe(true);

    await toggle.check();
    await expect(toggle).toBeChecked();

    const after = await page.evaluate(async () => (await import('./app.js')).store.params?.create_mpws);
    expect(after).toBe(true);

    // Flipping back off propagates too
    await toggle.uncheck();
    const final = await page.evaluate(async () => (await import('./app.js')).store.params?.create_mpws);
    expect(final).toBe(false);

    await page.close();
  });
});
