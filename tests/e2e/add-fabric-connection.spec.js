// Unofficial FortiMonitor Toolkit - Add Fabric Connection (API) E2E (FMN-119).
// Stubbed only. Live spec is intentionally omitted from this commit:
// fc:create-batch is destructive (creates real fabric_connection rows)
// and there is no read-only preview step like the attribute / template
// tools have. A live spec would need a cleanup hook to delete created
// rows, which is out of scope here.

import { test, expect } from './fixtures.js';
import { fabricConnectionStubScript } from './add-fabric-connection-stubs.js';

async function openTool(extensionContext, url) {
  const page = await extensionContext.newPage();
  await page.addInitScript(fabricConnectionStubScript);
  await page.goto(url);
  await expect(page.locator('.step-header h2')).toContainText('Load FortiGate devices and pick targets');
  return page;
}

test.describe('Add Fabric Connection (API) E2E - stubbed tenant', () => {
  test('Paste two devices, pick targets, advance through review to results', async ({ extensionContext, fabricConnectionUrl }) => {
    const page = await openTool(extensionContext, fabricConnectionUrl);
    try {
      // Wait for the dropdowns to populate (panopta:list-* responses).
      const onsightSelect = page.locator('select.select').first();
      await page.waitForFunction(() => {
        const sels = document.querySelectorAll('select.select');
        return sels.length >= 3 && sels[0].options.length > 1 && sels[1].options.length > 1;
      }, undefined, { timeout: 10_000 });

      // Pick the OnSight + Server group; leave appliance group as None.
      await onsightSelect.selectOption('7');
      await page.locator('select.select').nth(1).selectOption('100');

      // Paste 2 devices.
      await page.locator('textarea.paste-area').fill('FGT60FT123ABC,10.0.0.1,8443\nFGT60FT456DEF,10.0.0.2,8443');

      // Advance to review.
      await page.getByRole('button', { name: /Continue/ }).click();
      await expect(page).toHaveURL(/#\/review$/, { timeout: 10_000 });
      // Review step renders a table of the parsed devices.
      await expect(page.locator('.body-section')).toContainText('FGT60FT123ABC');
      await expect(page.locator('.body-section')).toContainText('FGT60FT456DEF');
    } finally {
      await page.close();
    }
  });
});
