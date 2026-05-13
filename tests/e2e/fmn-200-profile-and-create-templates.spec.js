// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-200: Configure step integration tests for the Profile + Create
// Templates action.
//
// Stubs chrome.runtime.sendMessage to mock the three SW handlers the
// Configure step fetches on mount: list-fabric-system-data,
// list-monitoring-config-batch, list-port-scope-batch. Per project
// memory playwright_stub_chrome_runtime_only.md: stub sendMessage only,
// leave chrome.tabs/storage real.
//
// Run: npx playwright test tests/e2e/fmn-200-profile-and-create-templates.spec.js

import { test, expect } from './fixtures.js';

const STUB_FSD = {
  42024061: { model_name: 'FortiGate', model_number: 'FGVMA6', os_version: 'v7.6.3' },
  42024062: { model_name: 'FortiGate', model_number: 'FGVMA6', os_version: 'v7.6.3' },
  42024063: { model_name: 'FortiGate', model_number: 'FG-100F', os_version: 'v7.4.1' }
};

const STUB_MONITORING = {
  42024061: [
    { textkey: 'fortinet.fortigate', name: 'CPU', metrics: [{ textkey: 'cpu', name: 'CPU Usage' }] },
    { textkey: 'fortinet.fortigate', name: 'Memory', metrics: [{ textkey: 'memory', name: 'Memory Usage' }] }
  ],
  42024062: [
    { textkey: 'fortinet.fortigate', name: 'CPU', metrics: [{ textkey: 'cpu', name: 'CPU Usage' }] },
    { textkey: 'fortinet.fortigate', name: 'Memory', metrics: [{ textkey: 'memory', name: 'Memory Usage' }] }
  ],
  42024063: [
    { textkey: 'fortinet.fortigate', name: 'CPU', metrics: [{ textkey: 'cpu', name: 'CPU Usage' }] }
  ]
};

const STUB_PORTS = {
  42024061: [0, 1, 2],
  42024062: [0, 1, 2],
  42024063: [0, 1, 2, 3, 4]
};

const STUB_SERVER_GROUPS = [
  { id: 617598, name: 'INCOMING SERVERS', resourceUrl: 'https://api2.panopta.com/v2/server_group/617598/' },
  { id: 985142, name: 'FM Toolkit Templates', resourceUrl: 'https://api2.panopta.com/v2/server_group/985142/' }
];

async function installSwStub(page, responses = {}) {
  await page.evaluate((args) => {
    const { responses, fsd, mc, ps, groups } = args;
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function patched(msg, cb) {
      const type = msg?.type;
      const payload = msg?.payload || {};

      const respondWith = (result) => setTimeout(() => cb({ ok: true, result }), 0);

      if (responses[type]) {
        const result = typeof responses[type] === 'function' ? responses[type](payload) : responses[type];
        respondWith(result);
        return true;
      }

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
  }, { responses, fsd: STUB_FSD, mc: STUB_MONITORING, ps: STUB_PORTS, groups: STUB_SERVER_GROUPS });
}

async function openConfigure(page, extensionId, targets, { stubResponses } = {}) {
  await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
  await installSwStub(page, stubResponses ?? {});
  await page.evaluate(async (targets) => {
    const mod = await import('./app.js');
    mod.store.targets = targets;
    mod.store.actionId = 'profile-and-create-templates';
    window.location.hash = '#/configure';
  }, targets);
}

test.describe('FMN-200: Configure step clusters and renders proposals', () => {
  test('two identical FortiGates form one cluster; a third (different) forms a second', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, [
      { id: 42024061, name: 'FGVM-A', template_names: [] },
      { id: 42024062, name: 'FGVM-B', template_names: [] },
      { id: 42024063, name: 'FG100F', template_names: [] }
    ]);

    await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 10000 });
    const rows = page.locator('[data-test="configure-pact-row"]');
    await expect(rows).toHaveCount(2);

    // Both clusters default to opted-in
    const opts = page.locator('[data-test="configure-pact-opt-in"]');
    await expect(opts).toHaveCount(2);

    await page.close();
  });

  test('Next button gated on destination-group selection + at least one opted-in cluster', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, [
      { id: 42024061, name: 'FGVM-A', template_names: [] }
    ]);
    await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 10000 });

    // No destination group picked -> disabled despite opted-in row.
    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();

    await page.locator('[data-test="configure-pact-destination-group"]').selectOption('grp-617598');
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    // Uncheck only row -> disabled again.
    await page.locator('[data-test="configure-pact-opt-in"]').first().uncheck();
    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();

    await page.close();
  });

  test('Existing groups appear as options in the destination dropdown', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, [
      { id: 42024061, name: 'FGVM-A', template_names: [] }
    ]);
    await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 10000 });
    const select = page.locator('[data-test="configure-pact-destination-group"]');
    // Expect a placeholder, the "+ Add new" option, and two stubbed groups = 4 options.
    const optionValues = await select.locator('option').evaluateAll((els) => els.map((e) => e.value));
    expect(optionValues).toContain('grp-617598');
    expect(optionValues).toContain('grp-985142');
    expect(optionValues).toContain('__new__');
    await page.close();
  });

  test('Picking "+ Add new group..." reveals the new-group name input', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, [
      { id: 42024061, name: 'FGVM-A', template_names: [] }
    ]);
    await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 10000 });

    const wrapper = page.locator('[data-test="configure-pact-new-group-wrapper"]');
    await expect(wrapper).toBeHidden();

    await page.locator('[data-test="configure-pact-destination-group"]').selectOption('__new__');
    await expect(wrapper).toBeVisible();

    // Empty name -> Next stays disabled.
    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();

    // Type a name -> Next enables; params has create_name.
    await page.locator('[data-test="configure-pact-new-group-name"]').fill('FM Toolkit Templates');
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    const params = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.params;
    });
    expect(params.destination_group).toBe('');
    expect(params.destination_group_create_name).toBe('FM Toolkit Templates');

    await page.close();
  });

  test('dry-run toggle + clone-from-device toggle persist into store.params', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, [
      { id: 42024061, name: 'FGVM-A', template_names: [] }
    ]);
    await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 10000 });

    await page.locator('[data-test="configure-pact-dry-run"]').check();
    await page.locator('[data-test="configure-pact-clone"]').first().check();

    const params = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.params;
    });
    expect(params.dry_run).toBe(true);
    expect(params.clusters[0].clone_from_device).toBe(true);

    await page.close();
  });

  test('editable template name updates store.params.clusters[i].proposed_template_name', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, [
      { id: 42024061, name: 'FGVM-A', template_names: [] }
    ]);
    await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 10000 });

    const nameInput = page.locator('[data-test="configure-pact-template-name"]').first();
    await nameInput.fill('My Custom Template');

    const params = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.params;
    });
    expect(params.clusters[0].proposed_template_name).toBe('My Custom Template');

    await page.close();
  });

  test('unclassified non-Fabric devices show in the footer count', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, [
      { id: 42024061, name: 'FGVM-A', template_names: [] },
      { id: 99999999, name: 'unagented-linux', template_names: [] }    // not in STUB_FSD
    ]);
    await expect(page.locator('[data-test="configure-pact-table"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-test="configure-pact-unmatched"]')).toBeVisible();
    await expect(page.locator('[data-test="configure-pact-unmatched"]')).toContainText('1 of 2');

    await page.close();
  });

  test('SW fetch failure surfaces in the status line and keeps Next disabled', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
    await page.evaluate(() => {
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = function patched(msg, cb) {
        const type = msg?.type;
        if (type === 'bulk-composer:list-fabric-system-data'
          || type === 'bulk-composer:list-monitoring-config-batch'
          || type === 'bulk-composer:list-port-scope-batch') {
          setTimeout(() => cb({ ok: false, error: 'simulated SW failure' }), 0);
          return true;
        }
        return real(msg, cb);
      };
    });
    await page.evaluate(async () => {
      const mod = await import('./app.js');
      mod.store.targets = [{ id: 42024061, name: 'FGVM-A', template_names: [] }];
      mod.store.actionId = 'profile-and-create-templates';
      window.location.hash = '#/configure';
    });
    await expect(page.locator('.execute-state.error').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();

    await page.close();
  });
});
