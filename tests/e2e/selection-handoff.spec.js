// Unofficial FortiMonitor Toolkit - Send selection to handoff E2E (FMN-115).
//
// Drives the cross-tool handoff: select rows in Find Servers results,
// click "Send to → Manage Templates → Detach", assert the receiver tab
// opens with IDs prefilled and Detach radio selected. Plus an expiry
// edge case: a stale blob does not prefill.

import { test, expect } from './fixtures.js';
import { handoffCombinedStubScript } from './selection-handoff-stubs.js';

async function clearPendingSelection(extensionContext, extensionId) {
  // Wipe chrome.storage.session under the handoff key so test runs are
  // isolated. Run from a fresh page in the extension origin so
  // chrome.storage.session is reachable.
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/ui/server-search/app.html#/start`);
  await page.evaluate(async () => {
    if (chrome?.storage?.session?.remove) {
      await chrome.storage.session.remove('fm:pendingSelection');
    }
  });
  await page.close();
}

async function runFindServersAndOpenResults(page) {
  // Mirrors find-servers.spec's flow: tag = production exact, run search.
  const row = page.locator('.criterion-row').first();
  await row.locator('select').first().selectOption('tag');
  await row.locator('input[type="text"]').last().fill('production');
  await row.locator('input[type="checkbox"]').check();
  await page.getByRole('button', { name: 'Run search' }).click();
  await expect(page).toHaveURL(/#\/results$/, { timeout: 5_000 });
  await page.waitForSelector('.body-section table tbody tr', { state: 'attached', timeout: 5_000 });
}

test.describe('Send selection to handoff (FMN-115) E2E - stubbed tenant', () => {
  test('Find Servers → Manage Templates Detach: ids prefilled, Detach radio set', async ({ extensionContext, extensionId, findServersUrl }) => {
    await extensionContext.addInitScript(handoffCombinedStubScript);
    await clearPendingSelection(extensionContext, extensionId);

    const senderPage = await extensionContext.newPage();
    await senderPage.goto(findServersUrl);
    await expect(senderPage.locator('.step-header h2')).toContainText('Find servers');
    await runFindServersAndOpenResults(senderPage);

    // Both rows are selected by default; the count shows "(2)".
    await expect(senderPage.locator('.fmn-send-to-btn')).toBeEnabled();
    await expect(senderPage.locator('.fmn-send-to-count')).toHaveText(' (2)');

    // Open the menu and click the Detach receiver. Expect a new tab
    // opens to the template-management page.
    const newPagePromise = extensionContext.waitForEvent('page', { timeout: 10_000 });
    await senderPage.locator('.fmn-send-to-btn').click();
    await senderPage.locator('.fmn-send-to-menu').waitFor({ state: 'visible' });
    await senderPage.locator('.fmn-send-to-item', { hasText: 'Manage Templates → Detach' }).click();

    const receiverPage = await newPagePromise;
    await receiverPage.waitForLoadState('domcontentloaded');
    await expect(receiverPage).toHaveURL(/template-management\/app\.html/);

    // Receiver consumes the blob async on mount; wait for the textarea
    // to fill.
    await expect(receiverPage.locator('textarea.paste-area')).toHaveValue('1001\n1002', { timeout: 5_000 });
    // Detach radio is selected because the receiver hint was {operation: 'detach'}.
    await expect(receiverPage.locator('input[name="tmpl-op"][value="detach"]')).toBeChecked();
    // Banner reflects the source.
    await expect(receiverPage.locator('.fmn-handoff-banner')).toContainText('Find Servers');

    // Slot is single-shot: a fresh load of the receiver does NOT replay.
    const fresh = await extensionContext.newPage();
    await fresh.goto(`chrome-extension://${extensionId}/src/ui/template-management/app.html#/start`);
    await fresh.waitForSelector('textarea.paste-area');
    await expect(fresh.locator('textarea.paste-area')).toHaveValue('');
    await expect(fresh.locator('.fmn-handoff-banner')).toBeHidden();

    await receiverPage.close();
    await senderPage.close();
    await fresh.close();
  });

  test('Find Servers → Manage Attributes: ids prefilled, no operation hint', async ({ extensionContext, extensionId, findServersUrl }) => {
    await extensionContext.addInitScript(handoffCombinedStubScript);
    await clearPendingSelection(extensionContext, extensionId);

    const senderPage = await extensionContext.newPage();
    await senderPage.goto(findServersUrl);
    await runFindServersAndOpenResults(senderPage);

    // Untick the first row so we send a single id.
    await senderPage.locator('.body-section table tbody tr').first().locator('input.fmn-row-select').uncheck();
    await expect(senderPage.locator('.fmn-send-to-count')).toHaveText(' (1)');

    const newPagePromise = extensionContext.waitForEvent('page', { timeout: 10_000 });
    await senderPage.locator('.fmn-send-to-btn').click();
    await senderPage.locator('.fmn-send-to-item', { hasText: 'Manage Attributes' }).click();

    const receiverPage = await newPagePromise;
    await receiverPage.waitForLoadState('domcontentloaded');
    await expect(receiverPage).toHaveURL(/attribute-management\/app\.html/);
    // Whichever id remained ticked: we unticked the first row, so 1002 stays.
    await expect(receiverPage.locator('textarea.paste-area')).toHaveValue('1002', { timeout: 5_000 });

    await receiverPage.close();
    await senderPage.close();
  });

  test('Expired blob does not prefill the receiver', async ({ extensionContext, extensionId }) => {
    await extensionContext.addInitScript(handoffCombinedStubScript);
    await clearPendingSelection(extensionContext, extensionId);

    // Plant an already-expired blob directly into chrome.storage.session.
    const planter = await extensionContext.newPage();
    await planter.goto(`chrome-extension://${extensionId}/src/ui/server-search/app.html#/start`);
    await planter.evaluate(async () => {
      await chrome.storage.session.set({
        'fm:pendingSelection': {
          receiverId: 'manage-templates-detach',
          ids: [9999],
          names: null,
          source: 'find-servers',
          hint: { operation: 'detach' },
          expiresAt: Date.now() - 60_000   // already expired
        }
      });
    });
    await planter.close();

    const receiverPage = await extensionContext.newPage();
    await receiverPage.goto(`chrome-extension://${extensionId}/src/ui/template-management/app.html#/start`);
    await receiverPage.waitForSelector('textarea.paste-area');
    // Expired blob: no prefill, no banner.
    await expect(receiverPage.locator('textarea.paste-area')).toHaveValue('');
    await expect(receiverPage.locator('.fmn-handoff-banner')).toBeHidden();
    await receiverPage.close();
  });
});
