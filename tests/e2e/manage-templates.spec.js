// Unofficial FortiMonitor Toolkit - Manage Templates (Bulk) E2E (FMN-119).

import { test, expect } from './fixtures.js';
import { manageTemplatesStubScript } from './manage-templates-stubs.js';

async function openTool(extensionContext, url) {
  const page = await extensionContext.newPage();
  await page.addInitScript(manageTemplatesStubScript);
  await page.goto(url);
  await expect(page.locator('.step-header h2')).toContainText('Attach or detach a monitoring template');
  return page;
}

test.describe('Manage Templates (Bulk) E2E - stubbed tenant', () => {
  test('Attach Critical Infra to two servers: preview shows 1 attach + 1 skip', async ({ extensionContext, manageTemplatesUrl }) => {
    const page = await openTool(extensionContext, manageTemplatesUrl);
    try {
      // Default operation is attach (radio set in app.js store init).
      // Pick the template once the dropdown populates.
      const tplSelect = page.locator('select.select').first();
      await expect(tplSelect).toBeEnabled({ timeout: 10_000 });
      // Wait for the Loading→ choose transition.
      await page.waitForFunction(() => {
        const sel = document.querySelector('select.select');
        return sel && sel.options.length > 1;
      }, undefined, { timeout: 10_000 });
      await tplSelect.selectOption('/server_template/501');

      // Two servers: '1001' already has 501 attached -> skip; the other
      // -> attach.
      await page.locator('textarea.paste-area').fill('1001\n1002');
      await page.getByRole('button', { name: /Continue → Preview/ }).click();
      await expect(page).toHaveURL(/#\/preview$/, { timeout: 10_000 });
      const summary = page.locator('.summary-bar');
      await expect(summary).toContainText('2 targets', { timeout: 10_000 });
      await expect(summary).toContainText('1 attach');
      await expect(summary).toContainText('1 skip');
    } finally {
      await page.close();
    }
  });
});
