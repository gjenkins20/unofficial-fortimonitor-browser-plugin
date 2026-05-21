// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-162: Bulk Add to Port Scope / Remove from Port Scope actions
// in the Bulk Action Composer.
//
// Stubs chrome.runtime.sendMessage for list-device-ports-batch (memory:
// playwright_stub_chrome_runtime_only).
//
// Run: npx playwright test tests/e2e/fmn-162-port-scope-bulk.spec.js

import { test, expect } from './fixtures.js';

// Two FortiGates with overlapping but not identical port lists.
// Common ports: port1 (active on both), port2 (active on both), port3
// (inactive on both), port4 (only on 100, inactive).
const PORTS = {
  100: [
    { name: 'port1', index: 0, isActive: true, admin_status: 'up', oper_status: 'up' },
    { name: 'port2', index: 1, isActive: true, admin_status: 'up', oper_status: 'up' },
    { name: 'port3', index: 2, isActive: false, admin_status: 'up', oper_status: 'down' },
    { name: 'port4', index: 3, isActive: false, admin_status: 'up', oper_status: 'down' }
  ],
  101: [
    { name: 'port1', index: 0, isActive: true, admin_status: 'up', oper_status: 'up' },
    { name: 'port2', index: 1, isActive: true, admin_status: 'up', oper_status: 'up' },
    { name: 'port3', index: 2, isActive: false, admin_status: 'up', oper_status: 'down' }
  ]
};

async function installSwStub(page) {
  await page.evaluate(({ portsByServerId }) => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__FMN_162_CALLS = [];
    chrome.runtime.sendMessage = function patched(msg, cb) {
      const type = msg?.type;
      const payload = msg?.payload || {};
      const respondWith = (result) => setTimeout(() => cb({ ok: true, result }), 0);
      window.__FMN_162_CALLS.push({ type, ids: Array.isArray(payload?.serverIds) ? payload.serverIds.slice() : null });
      if (type === 'bulk-composer:list-device-ports-batch') {
        const byServerId = {};
        for (const id of (payload.serverIds || [])) {
          const ports = portsByServerId[id];
          if (Array.isArray(ports)) {
            byServerId[id] = {
              ports,
              totalPortCount: ports.length,
              searchTerm: '',
              filters: []
            };
          } else {
            byServerId[id] = null;
          }
        }
        respondWith({ byServerId });
        return true;
      }
      if (type === 'bulk-composer:list-template-names-batch') {
        // commit.js fires this on /commit entry; respond empty.
        const byServerId = {};
        for (const id of (payload.serverIds || [])) byServerId[id] = [];
        respondWith({ byServerId });
        return true;
      }
      return real(msg, cb);
    };
  }, { portsByServerId: PORTS });
}

async function openConfigure(page, extensionId, actionId) {
  await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
  await installSwStub(page);
  await page.evaluate(async ({ actionId }) => {
    const mod = await import('./app.js');
    mod.store.targets = [
      { id: 100, name: 'fgt-a' },
      { id: 101, name: 'fgt-b' }
    ];
    mod.store.actionId = actionId;
    mod.store.params = {};
    window.location.hash = '#/configure';
  }, { actionId });
  await expect(page.locator('[data-test="configure-port-chip-mount"]')).toBeVisible({ timeout: 10000 });
}

test.describe('FMN-162: Bulk add-port-scope', () => {
  test('chip row renders union of port names with frequency counts', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, 'add-port-scope');

    // Wait for chip row to populate (replaces the loading placeholder)
    await expect(page.locator('[data-test="configure-port-chips"]')).toBeVisible({ timeout: 5000 });
    const chips = page.locator('[data-test="configure-port-chip"]');
    await expect(chips).toHaveCount(4);

    // port1 + port2 + port3 are on both -> count=2
    // port4 is on only 100 -> count=1
    const labels = await chips.allTextContents();
    expect(labels).toContain('port1 · 2');
    expect(labels).toContain('port2 · 2');
    expect(labels).toContain('port3 · 2');
    expect(labels).toContain('port4 · 1');

    await page.close();
  });

  test('clicking a chip toggles params.portNames and syncs the text input', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, 'add-port-scope');
    await expect(page.locator('[data-test="configure-port-chips"]')).toBeVisible({ timeout: 5000 });

    const chipPort3 = page.locator('[data-test="configure-port-chip"][data-port-name="port3"]');
    await chipPort3.click();

    // params.portNames updates, text input mirrors
    const portNames = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.params?.portNames || [];
    });
    expect(portNames).toEqual(['port3']);
    await expect(page.locator('[data-test="configure-port-input"]')).toHaveValue('port3');

    // Next button now enabled
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    // Click again -> deselects
    await chipPort3.click();
    const cleared = await page.evaluate(async () => (await import('./app.js')).store.params?.portNames);
    expect(cleared).toEqual([]);
    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();

    await page.close();
  });

  test('typing into the input parses into portNames and Next enables', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, 'add-port-scope');
    await expect(page.locator('[data-test="configure-port-chips"]')).toBeVisible({ timeout: 5000 });

    const input = page.locator('[data-test="configure-port-input"]');
    await input.fill('port3, port4');
    const portNames = await page.evaluate(async () => (await import('./app.js')).store.params?.portNames);
    expect(portNames).toEqual(['port3', 'port4']);
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    await page.close();
  });

  test('pre-flight caches target.ports on store.targets for the Preview step', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, 'add-port-scope');
    await expect(page.locator('[data-test="configure-port-chips"]')).toBeVisible({ timeout: 5000 });

    const cached = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.targets.map((t) => ({ id: t.id, portCount: Array.isArray(t.ports) ? t.ports.length : null, totalPortCount: t.totalPortCount }));
    });
    expect(cached[0]).toEqual({ id: 100, portCount: 4, totalPortCount: 4 });
    expect(cached[1]).toEqual({ id: 101, portCount: 3, totalPortCount: 3 });

    await page.close();
  });
});

test.describe('FMN-162: Bulk remove-port-scope', () => {
  test('chip row filters to ports currently in scope on at least one instance', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId, 'remove-port-scope');
    await expect(page.locator('[data-test="configure-port-chips"]')).toBeVisible({ timeout: 5000 });

    const chips = page.locator('[data-test="configure-port-chip"]');
    // port1, port2 are active on both. port3, port4 are inactive on all
    // -> remove-port-scope only surfaces the active ones.
    await expect(chips).toHaveCount(2);
    const labels = await chips.allTextContents();
    expect(labels).toContain('port1 · 2');
    expect(labels).toContain('port2 · 2');

    await page.close();
  });
});
