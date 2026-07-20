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

  // FMN-265: cloud serials (hyphens) + include-flagged override.
  async function pickTargets(page) {
    await page.waitForFunction(() => {
      const sels = document.querySelectorAll('select.select');
      return sels.length >= 3 && sels[0].options.length > 1 && sels[1].options.length > 1;
    }, undefined, { timeout: 10_000 });
    await page.locator('select.select').first().selectOption('7');
    await page.locator('select.select').nth(1).selectOption('100');
  }

  test('cloud serial with a hyphen (FGTAWS-) parses and advances', async ({ extensionContext, fabricConnectionUrl }) => {
    const page = await openTool(extensionContext, fabricConnectionUrl);
    try {
      await pickTargets(page);
      await page.locator('textarea.paste-area').fill('FGTAWS-LYSIUYW7D,10.0.0.5,8013');
      const continueBtn = page.getByRole('button', { name: /Continue/ });
      await expect(continueBtn).toBeEnabled();
      await continueBtn.click();
      await expect(page).toHaveURL(/#\/review$/, { timeout: 10_000 });
      await expect(page.locator('.review-table')).toContainText('FGTAWS-LYSIUYW7D');
      // A valid cloud serial is NOT flagged.
      await expect(page.locator('.flag-badge')).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  test('non-IPv4 host is skipped by default, included via the flagged toggle', async ({ extensionContext, fabricConnectionUrl }) => {
    const page = await openTool(extensionContext, fabricConnectionUrl);
    try {
      await pickTargets(page);
      // A DNS host fails the IPv4 heuristic.
      await page.locator('textarea.paste-area').fill('FGVM01TM24006844,fgt.branch.example.com,8013');

      // Off by default: 0 devices, hint points at the override, Continue disabled.
      const continueBtn = page.getByRole('button', { name: /Continue/ });
      await expect(page.locator('.parse-hint')).toContainText('Include flagged devices');
      await expect(continueBtn).toBeDisabled();

      // Toggle on: the row is onboarded and flagged.
      await page.locator('.include-flagged-row input[type="checkbox"]').check();
      await expect(continueBtn).toBeEnabled();
      await continueBtn.click();
      await expect(page).toHaveURL(/#\/review$/, { timeout: 10_000 });
      await expect(page.locator('.review-table .flag-badge')).toBeVisible();
      await expect(page.locator('.review-table')).toContainText('fgt.branch.example.com');
    } finally {
      await page.close();
    }
  });

  // FMN-291: optional per-device name → connection label. Behavior matrix:
  // a named device carries its label; an unnamed one shows the IP-fallback.
  test('optional name renders as a label column and flows into the payload', async ({ extensionContext, fabricConnectionUrl }) => {
    const page = await openTool(extensionContext, fabricConnectionUrl);
    try {
      await pickTargets(page);
      // First device named, second omitted → falls back to IP. First device
      // drives the "Example POST body" preview.
      await page.locator('textarea.paste-area').fill(
        'serial,ip,port,name\nFGT60FT123ABC,10.0.0.1,8443,Edge-FW-01\nFGT60FT456DEF,10.0.0.2,8443'
      );
      await page.getByRole('button', { name: /Continue/ }).click();
      await expect(page).toHaveURL(/#\/review$/, { timeout: 10_000 });

      // New Name (label) column header is present.
      await expect(page.locator('.review-table thead')).toContainText('Name (label)');
      // Named device shows its label.
      await expect(page.locator('.review-table tbody tr').first()).toContainText('Edge-FW-01');
      // Unnamed device shows the muted IP-fallback hint.
      await expect(page.locator('.review-table .name-fallback')).toContainText('defaults to IP');
      // Example payload (first device) carries the label, not the IP.
      await expect(page.locator('.preview-payload')).toContainText('"label": "Edge-FW-01"');
    } finally {
      await page.close();
    }
  });

  test('flagged toggle does not rescue a row missing its host (hard skip)', async ({ extensionContext, fabricConnectionUrl }) => {
    const page = await openTool(extensionContext, fabricConnectionUrl);
    try {
      await pickTargets(page);
      await page.locator('.include-flagged-row input[type="checkbox"]').check();
      await page.locator('textarea.paste-area').fill('FGVM01TM24006844,,8013');
      // Missing host can never form a POST body - stays skipped, Continue disabled.
      await expect(page.getByRole('button', { name: /Continue/ })).toBeDisabled();
      // `.parse-result` also matches the (empty) targets-error div; scope to the populated summary.
      await expect(page.locator('.parse-result').first()).toContainText('missing IP');
    } finally {
      await page.close();
    }
  });
});
