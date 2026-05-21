// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-226: Auto-set instance attributes by name regex.
//
// Stubs chrome.runtime.sendMessage (memory:
// playwright_stub_chrome_runtime_only).
//
// Run: npx playwright test tests/e2e/fmn-226-auto-set-attribute-by-name.spec.js

import { test, expect } from './fixtures.js';

const SITECODE_TYPE_URL = 'https://api2.panopta.com/v2/server_attribute_type/501/';
const REGION_TYPE_URL = 'https://api2.panopta.com/v2/server_attribute_type/502/';

const ATTRS_BY_ID = {
  100: [],
  101: [{ id: 1, name: 'sitecode', textkey: 'sitecode', value: '684', typeUrl: SITECODE_TYPE_URL, resourceUrl: 'https://api2/v2/server/101/server_attribute/1/' }],
  102: [{ id: 2, name: 'sitecode', textkey: 'sitecode', value: '999', typeUrl: SITECODE_TYPE_URL, resourceUrl: 'https://api2/v2/server/102/server_attribute/2/' }]
};

async function installSwStub(page) {
  await page.evaluate(({ attrsById, sitecodeUrl, regionUrl }) => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__FMN_226_CALLS = [];
    chrome.runtime.sendMessage = function patched(msg, cb) {
      const type = msg?.type;
      const payload = msg?.payload || {};
      const respondWith = (result) => setTimeout(() => cb({ ok: true, result }), 0);
      window.__FMN_226_CALLS.push({ type, ids: Array.isArray(payload?.serverIds) ? payload.serverIds.slice() : null });
      if (type === 'bulk-composer:list-attribute-types') {
        respondWith({
          types: [
            { id: 501, name: 'sitecode', textkey: 'sitecode', resourceUrl: sitecodeUrl },
            { id: 502, name: 'region', textkey: 'region', resourceUrl: regionUrl }
          ]
        });
        return true;
      }
      if (type === 'bulk-composer:list-server-attributes-batch') {
        const byServerId = {};
        for (const id of (payload.serverIds || [])) byServerId[id] = attrsById[id] ?? null;
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
  }, { attrsById: ATTRS_BY_ID, sitecodeUrl: SITECODE_TYPE_URL, regionUrl: REGION_TYPE_URL });
}

async function openConfigure(page, extensionId) {
  await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
  await installSwStub(page);
  await page.evaluate(async () => {
    const mod = await import('./app.js');
    mod.store.targets = [
      { id: 100, name: 'FGT-684-edge-01' },
      { id: 101, name: 'FGT-684-edge-02' },
      { id: 102, name: 'FGT-712-edge-01' },
      { id: 103, name: 'unrelated-host' }
    ];
    mod.store.actionId = 'auto-set-attribute-by-name';
    mod.store.params = {};
    window.location.hash = '#/configure';
  });
  await expect(page.locator('[data-test="auto-attr-type-select"]')).toBeVisible({ timeout: 10000 });
}

test.describe('FMN-226: Auto-set attribute by name pattern', () => {
  test('type dropdown populates from list-attribute-types and selecting an entry enables follow-on inputs', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);

    const select = page.locator('[data-test="auto-attr-type-select"]');
    await expect.poll(() => select.evaluate((el) => el.options.length)).toBeGreaterThan(1);
    const optTexts = await select.evaluate((el) => Array.from(el.options).map((o) => o.textContent));
    expect(optTexts.join(',')).toMatch(/sitecode/);
    expect(optTexts.join(',')).toMatch(/region/);

    // Next disabled until all three inputs land.
    await expect(page.locator('[data-test="configure-next"]')).toBeDisabled();
    await select.selectOption(SITECODE_TYPE_URL);
    await page.locator('[data-test="auto-attr-regex-input"]').fill('^FGT-(\\d{3})-');
    await page.locator('[data-test="auto-attr-value-input"]').fill('$1');
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();

    await page.close();
  });

  test('preview renders matches with the resulting value', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);
    await page.locator('[data-test="auto-attr-type-select"]').selectOption(SITECODE_TYPE_URL);
    await page.locator('[data-test="auto-attr-regex-input"]').fill('^FGT-(\\d{3})-');
    await page.locator('[data-test="auto-attr-value-input"]').fill('$1');

    await expect(page.locator('[data-test="auto-attr-preview-summary"]'))
      .toHaveText('3 matches · 1 no-match');

    const valueCells = await page.locator('[data-test="auto-attr-preview-value"]').allTextContents();
    expect(valueCells).toEqual(['684', '684', '712']);

    await page.close();
  });

  test('target.attributes enrichment fires for store.targets', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await openConfigure(page, extensionId);

    await expect.poll(() => page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.targets.map((t) => ({ id: t.id, n: Array.isArray(t.attributes) ? t.attributes.length : t.attributes }));
    })).toEqual([
      { id: 100, n: 0 },
      { id: 101, n: 1 },
      { id: 102, n: 1 },
      { id: 103, n: null }
    ]);

    await page.close();
  });
});
