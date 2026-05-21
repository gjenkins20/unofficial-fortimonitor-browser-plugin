// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-170: Set Parent Group bulk action.
//
// Stubs chrome.runtime.sendMessage (memory:
// playwright_stub_chrome_runtime_only).
//
// Run: npx playwright test tests/e2e/fmn-170-set-parent-group.spec.js

import { test, expect } from './fixtures.js';

const PROD_URL = 'https://api2.panopta.com/v2/server_group/100/';
const STAGING_URL = 'https://api2.panopta.com/v2/server_group/200/';

const GROUPS = [
  { id: 100, name: 'Production', resourceUrl: PROD_URL },
  { id: 200, name: 'Staging', resourceUrl: STAGING_URL }
];

const PARENTS_BY_ID = {
  10: { id: 200, name: 'Staging', url: STAGING_URL },
  11: { id: 100, name: 'Production', url: PROD_URL },
  12: null
};

async function installSwStub(page) {
  await page.evaluate(({ groups, parentsById }) => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function patched(msg, cb) {
      const type = msg?.type;
      const payload = msg?.payload || {};
      const respondWith = (result) => setTimeout(() => cb({ ok: true, result }), 0);
      if (type === 'bulk-composer:list-server-groups') {
        respondWith({ groups });
        return true;
      }
      if (type === 'bulk-composer:list-server-parents-batch') {
        const byServerId = {};
        for (const id of (payload.serverIds || [])) {
          byServerId[id] = Object.prototype.hasOwnProperty.call(parentsById, id) ? parentsById[id] : null;
        }
        respondWith({ byServerId });
        return true;
      }
      if (type === 'bulk-composer:list-template-names-batch') {
        const byServerId = {};
        for (const id of (payload.serverIds || [])) byServerId[id] = [];
        respondWith({ byServerId });
        return true;
      }
      return real(msg, cb);
    };
  }, { groups: GROUPS, parentsById: PARENTS_BY_ID });
}

async function openConfigure(page, extensionId) {
  await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
  await installSwStub(page);
  await page.evaluate(async () => {
    const mod = await import('./app.js');
    mod.store.targets = [
      { id: 10, name: 'web-01' },
      { id: 11, name: 'web-02' },
      { id: 12, name: 'orphan-01' }
    ];
    mod.store.actionId = 'set-parent-group';
    mod.store.params = {};
    window.location.hash = '#/configure';
  });
  await expect(page.locator('[data-test="set-parent-group-select"]')).toBeVisible({ timeout: 10000 });
}

test.describe('FMN-170: Set Parent Group', () => {
  test('group dropdown populates alphabetically; selecting one enables Next', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);

    const select = page.locator('[data-test="set-parent-group-select"]');
    await expect.poll(() => select.evaluate((el) => el.options.length)).toBeGreaterThan(1);
    const labels = await select.evaluate((el) => Array.from(el.options).map((o) => o.textContent));
    // First option is the "Select a destination..." sentinel; the next two
    // should be alphabetical
    expect(labels[1]).toBe('Production');
    expect(labels[2]).toBe('Staging');

    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();
    await select.selectOption(PROD_URL);
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    // store.params reflects the choice
    const params = await page.evaluate(async () => (await import('./app.js')).store.params);
    expect(params.groupUrl).toBe(PROD_URL);
    expect(params.groupName).toBe('Production');

    await page.close();
  });

  test('parent-group enrichment populates store.targets[i].parentGroup', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);

    await expect.poll(() => page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.targets.map((t) => t.parentGroup);
    })).toEqual([
      { id: 200, name: 'Staging', url: STAGING_URL },
      { id: 100, name: 'Production', url: PROD_URL },
      null
    ]);

    await page.close();
  });
});
