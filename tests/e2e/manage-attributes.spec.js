// Unofficial FortiMonitor Toolkit - Manage Attributes (Bulk) E2E (FMN-119).
// Drives the start -> preview path with a single set-attribute op and
// asserts the plan summary reflects the right counts.

import { test, expect } from './fixtures.js';
import { manageAttributesStubScript } from './manage-attributes-stubs.js';

async function openTool(extensionContext, url) {
  const page = await extensionContext.newPage();
  await page.addInitScript(manageAttributesStubScript);
  await page.goto(url);
  await expect(page.locator('.step-header h2')).toContainText('Set or remove one or more attributes');
  return page;
}

test.describe('Manage Attributes (Bulk) E2E - stubbed tenant', () => {
  test('Set Environment=prod across two servers: preview shows 2 add rows', async ({ extensionContext, manageAttributesUrl }) => {
    const page = await openTool(extensionContext, manageAttributesUrl);
    try {
      // Pick the type via the combobox. The combobox renders an input
      // .combobox-input. Wait for it to be enabled (after attr:list-types).
      const combo = page.locator('.combobox-input').first();
      await expect(combo).toBeEnabled({ timeout: 10_000 });
      await combo.fill('Environment');
      // Click the matched item in the dropdown.
      await page.getByRole('option', { name: /Environment/ }).first().click();
      // Fill the value (text input; in the same row, the .select with
      // type=text after the combobox).
      const valueInput = page.locator('.attribute-row input.select[type="text"]').first();
      await valueInput.fill('prod');
      // Paste two server names.
      await page.locator('textarea.paste-area').fill('srv-1\nsrv-2');
      // Continue.
      await page.getByRole('button', { name: /Continue → Preview/ }).click();
      // Preview navigates and runs attr:plan-batch.
      await expect(page).toHaveURL(/#\/preview$/, { timeout: 10_000 });
      // Plan summary updates after the async call. 2 entries x 1 attribute = 2 rows.
      await expect(page.locator('.summary-bar')).toContainText('2 plan rows', { timeout: 10_000 });
      await expect(page.locator('.summary-bar')).toContainText('2 add');
      const execBtn = page.getByRole('button', { name: /Execute 2 changes/ });
      await expect(execBtn).toBeEnabled();
    } finally {
      await page.close();
    }
  });
});
