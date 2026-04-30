// Unofficial FortiMonitor Toolkit - Port Scope (Add / Remove) E2E (FMN-119).
// Stubbed only. Live coverage for these tools is intentionally deferred:
// they require a logged-in FortiMonitor browser session (not the v2 API
// key the other tools use), and a session-bootstrap fixture is out of
// scope for this commit. The stubbed flow exercises start -> scan ->
// review-step navigation, which is the regression surface most likely
// to break under unrelated refactors.

import { test, expect } from './fixtures.js';
import { portScopeStubScript } from './port-scope-stubs.js';

async function openTool(extensionContext, url) {
  const page = await extensionContext.newPage();
  await page.addInitScript(portScopeStubScript);
  await page.goto(url);
  await expect(page.locator('.step-header h2')).toContainText('Load devices from CSV');
  return page;
}

test.describe('Port Scope tools E2E - stubbed', () => {
  test('Remove from Port Scope: paste two ids, scan, advance to review', async ({ extensionContext, portScopeRemoveUrl }) => {
    const page = await openTool(extensionContext, portScopeRemoveUrl);
    try {
      await page.locator('textarea.paste-area').fill('1001\n1002');
      await page.getByRole('button', { name: /Start review/ }).click();
      // Scan navigates to /review on success.
      await expect(page).toHaveURL(/#\/review$/, { timeout: 10_000 });
    } finally {
      await page.close();
    }
  });

  test('Add to Port Scope: same flow but tool=add mode', async ({ extensionContext, portScopeAddUrl }) => {
    const page = await openTool(extensionContext, portScopeAddUrl);
    try {
      await page.locator('textarea.paste-area').fill('1001\n1002');
      await page.getByRole('button', { name: /Start review/ }).click();
      await expect(page).toHaveURL(/#\/review$/, { timeout: 10_000 });
    } finally {
      await page.close();
    }
  });
});
