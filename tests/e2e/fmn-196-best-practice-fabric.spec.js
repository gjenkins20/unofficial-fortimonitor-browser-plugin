// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-196: Configure step + commit-step integration tests for the
// Apply Best-Practice Fabric Templates action.
//
// Stubs chrome.runtime.sendMessage to mock the three SW handlers the
// Configure step fetches on mount (list-fabric-system-data,
// list-monitoring-policy-vocab, list-templates-with-groups) plus the
// bulk-composer:commit handler driven from the Commit step. Per project
// memory playwright_stub_chrome_runtime_only.md: stub sendMessage only,
// leave chrome.tabs/storage real.
//
// Run: npx playwright test tests/e2e/fmn-196-best-practice-fabric.spec.js

import { test, expect } from './fixtures.js';

const STUB_FABRIC_SYSTEM_DATA = {
  42024061: { model_name: 'FortiGate', model_number: 'FGVMA6', os_version: 'v7.6.3 build3510' },
  42024062: { model_name: 'FortiGate', model_number: 'FGVMA6', os_version: 'v7.6.3 build3510' },
  42024063: { model_name: 'FortiSwitch', model_number: 'FS-148F', os_version: 'v7.4.0' }
};

const STUB_NOUN_OPTIONS = {
  device_types: [
    { label: 'FortiGate', value: '[sub_type]fortinet.fortigate' },
    { label: 'Kubernetes', value: 'kubernetes' }
  ],
  attribute_types: [
    {
      label: 'FortiGate',
      options: [
        { label: 'Model', value: 'attribute,fortigate.model' },
        { label: 'Firmware', value: 'attribute,fortigate.os_version' }
      ]
    },
    {
      label: 'FortiSwitch',
      options: [
        { label: 'Model', value: 'attribute,fortiswitch.model' }
      ]
    }
  ]
};

const STUB_TEMPLATES = [
  { id: 101, name: 'FortiGate FGVMA6 Fabric', server_group_name: 'Production' },
  { id: 102, name: 'FortiGate Default', server_group_name: 'Production' },
  { id: 900, name: 'FortiGate Stock', server_group_name: 'Default Monitoring Templates' }
];

const STUB_RULESETS = [
  // No existing policies by default. Tests override per case to exercise
  // the "policy already exists" pill.
];

/**
 * Install a chrome.runtime.sendMessage stub on `page` that responds to
 * the FMN-196 bulk-composer handlers with synthetic data. Returns a
 * promise that resolves once the stub is in place.
 *
 * Per-test overrides: pass a `responses` map keyed by message type. The
 * default handler chains fall back to STUB_* constants.
 */
async function installSwStub(page, responses = {}) {
  await page.evaluate((args) => {
    const { responses, fsd, vocab, templates, rulesets } = args;
    // Preserve the real sendMessage to passthrough non-matched types
    // (storage events, internal messaging the popup uses).
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function patched(msg, cb) {
      const type = msg?.type;
      const payload = msg?.payload || {};

      const respondWith = (result) => {
        // Async to mimic real SW response timing.
        setTimeout(() => cb({ ok: true, result }), 0);
      };

      // Per-type overrides from the test
      if (responses[type]) {
        const result = typeof responses[type] === 'function'
          ? responses[type](payload)
          : responses[type];
        respondWith(result);
        return true;
      }

      switch (type) {
        case 'bulk-composer:list-fabric-system-data': {
          const ids = Array.isArray(payload.serverIds) ? payload.serverIds : [];
          const byServerId = {};
          for (const id of ids) byServerId[id] = fsd[id] ?? null;
          respondWith({ byServerId });
          return true;
        }
        case 'bulk-composer:list-monitoring-policy-vocab':
          respondWith({ rulesets, nounOptions: vocab });
          return true;
        case 'bulk-composer:list-templates-with-groups':
          respondWith({ templates });
          return true;
      }

      // Anything else passes through to the real SW.
      return real(msg, cb);
    };
  }, {
    responses,
    fsd: STUB_FABRIC_SYSTEM_DATA,
    vocab: STUB_NOUN_OPTIONS,
    templates: STUB_TEMPLATES,
    rulesets: STUB_RULESETS
  });
}

async function openConfigureWithFabricTargets(page, extensionId, targets, { stubResponses } = {}) {
  // FMN-201: gate removed; the bulk-composer app loads without any flag.
  // Open the bulk-composer app and install the SW stub on this page
  // BEFORE the Configure step's on-mount fetches run.
  await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
  await installSwStub(page, stubResponses ?? {});
  await page.evaluate(async (targets) => {
    const mod = await import('./app.js');
    mod.store.targets = targets;
    mod.store.actionId = 'apply-best-practice-fabric';
    window.location.hash = '#/configure';
  }, targets);
}

test.describe('FMN-196: Configure step renders the per-profile table', () => {
  test('one Fabric profile per (Make, Model) is rendered with opt-in defaulted to true', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigureWithFabricTargets(page, extensionId, [
      { id: 42024061, name: 'FGVM01TM24006844', template_names: [] },
      { id: 42024062, name: 'FGVM01TM24006845', template_names: [] },
      { id: 42024063, name: 'fortiswitch-1', template_names: [] }
    ]);

    await expect(page.locator('[data-test="configure-bpf-table"]')).toBeVisible({ timeout: 10000 });
    const rows = page.locator('[data-test="configure-bpf-row"]');
    await expect(rows).toHaveCount(2);

    const fgRow = page.locator('[data-test="configure-bpf-row"][data-profile-key="FortiGate::FGVMA6::Fabric"]');
    await expect(fgRow).toBeVisible();
    await expect(fgRow.locator('[data-test="configure-bpf-opt-in"]')).toBeChecked();

    const fsRow = page.locator('[data-test="configure-bpf-row"][data-profile-key="FortiSwitch::FS-148F::Fabric"]');
    await expect(fsRow).toBeVisible();

    await page.close();
  });

  test('Next button enables when at least one row is opted in', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigureWithFabricTargets(page, extensionId, [
      { id: 42024061, name: 'FGVM01TM24006844', template_names: [] }
    ]);

    await expect(page.locator('[data-test="configure-bpf-table"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    // Uncheck the only row -> next disabled.
    await page.locator('[data-test="configure-bpf-opt-in"]').first().uncheck();
    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();

    // Re-check -> enabled again.
    await page.locator('[data-test="configure-bpf-opt-in"]').first().check();
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    await page.close();
  });

  test('dry-run toggle persists into store.params', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigureWithFabricTargets(page, extensionId, [
      { id: 42024061, name: 'FGVM01TM24006844', template_names: [] }
    ]);

    await expect(page.locator('[data-test="configure-bpf-table"]')).toBeVisible({ timeout: 10000 });
    await page.locator('[data-test="configure-bpf-dry-run"]').check();

    const dryRun = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.params?.dry_run;
    });
    expect(dryRun).toBe(true);

    await page.close();
  });

  test('unclassified note appears when picks include non-Fabric devices', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigureWithFabricTargets(page, extensionId, [
      { id: 42024061, name: 'FGVM01TM24006844', template_names: [] },
      { id: 99999999, name: 'unagented-linux', template_names: [] }   // not in STUB_FABRIC_SYSTEM_DATA
    ]);

    await expect(page.locator('[data-test="configure-bpf-table"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-test="configure-bpf-unmatched"]')).toBeVisible();
    await expect(page.locator('[data-test="configure-bpf-unmatched"]')).toContainText('1 of 2');

    await page.close();
  });

  test('"exists" pill shows when a ruleset with the policy name already exists', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigureWithFabricTargets(page, extensionId, [
      { id: 42024061, name: 'FGVM01TM24006844', template_names: [] }
    ], {
      stubResponses: {
        'bulk-composer:list-monitoring-policy-vocab': {
          rulesets: [{ id: 7777, name: 'Apply Best-Practice FortiGate template', latest_version: 1, config: { rules: [] } }],
          nounOptions: STUB_NOUN_OPTIONS
        }
      }
    });

    const fgRow = page.locator('[data-test="configure-bpf-row"][data-profile-key="FortiGate::FGVMA6::Fabric"]');
    await expect(fgRow).toBeVisible({ timeout: 10000 });
    await expect(fgRow.locator('.pill', { hasText: 'exists' })).toBeVisible();

    await page.close();
  });

  test('row with no matching template has a disabled checkbox and "skip" status', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    // Templates list has no FortiSwitch entries; stock has no FortiSwitch.
    await openConfigureWithFabricTargets(page, extensionId, [
      { id: 42024063, name: 'fortiswitch-1', template_names: [] }
    ], {
      stubResponses: {
        'bulk-composer:list-templates-with-groups': {
          templates: STUB_TEMPLATES.filter((t) => !/FortiSwitch/i.test(t.name))
        }
      }
    });

    const fsRow = page.locator('[data-test="configure-bpf-row"][data-profile-key="FortiSwitch::FS-148F::Fabric"]');
    await expect(fsRow).toBeVisible({ timeout: 10000 });
    await expect(fsRow.locator('[data-test="configure-bpf-opt-in"]')).toBeDisabled();
    await expect(fsRow).toContainText('skip');

    // Next button stays disabled because no opted-in row has a chosen_template.
    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();

    await page.close();
  });

  // -----------------------------------------------------------------
  // Route-guard happy path: ensures clicking Next from Configure
  // actually advances to /commit (canEnter route guard has a branch
  // for 'apply-best-practice-fabric').
  // -----------------------------------------------------------------
  test('Configure → Next advances to the Commit step (route guard passes)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigureWithFabricTargets(page, extensionId, [
      { id: 42024061, name: 'FGVM-A', template_names: [] }
    ]);
    await expect(page.locator('[data-test="configure-bpf-table"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();
    await page.locator('[data-test="configure-next"]').click();
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('4. Preview', { timeout: 5000 });
    expect(page.url()).toContain('#/commit');
    await page.close();
  });

  test('SW fetch failure surfaces in the status line and disables Next', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    // Custom installer that rejects the bulk-composer:list-* calls.
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
    await page.evaluate(() => {
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = function patched(msg, cb) {
        const type = msg?.type;
        if (type?.startsWith('bulk-composer:list-')) {
          setTimeout(() => cb({ ok: false, error: 'simulated SW failure' }), 0);
          return true;
        }
        return real(msg, cb);
      };
    });
    await page.evaluate(async () => {
      const mod = await import('./app.js');
      mod.store.targets = [{ id: 42024061, name: 'FGVM01TM24006844', template_names: [] }];
      mod.store.actionId = 'apply-best-practice-fabric';
      window.location.hash = '#/configure';
    });
    await expect(page.locator('.execute-state.error').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();

    await page.close();
  });
});
