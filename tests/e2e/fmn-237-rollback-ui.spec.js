// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-237: smoke + integration tests for the "Rollback Changes" UI.
//
// Coverage:
//   1. Popup tile present and labelled "Rollback Changes".
//   2. Page renders the empty-state card when chrome.storage.local has
//      no journal.
//   3. Seeding the journal via chrome.storage.local + clicking Refresh
//      renders one run card with resource counts.
//   4. Rollback button is enabled when a run has resources; disabled when
//      the run was already fully rolled back.
//   5. Clicking Rollback fires `bulk-composer:rollback-run` and the page
//      re-renders with the outcome panel. With no API key configured the
//      panel shows "failed" steps citing the missing client - that's a
//      valid outcome we assert on directly (it exercises the full
//      round-trip without needing live FortiMonitor auth).
//
// Run: npx playwright test tests/e2e/fmn-237-rollback-ui.spec.js

import { test, expect } from './fixtures.js';

const JOURNAL_KEY = 'fm:bulkComposerRunLog';

function fakeRunWithTag(runId, extras = {}) {
  return {
    runId,
    actionId: 'add-tag',
    actionLabel: 'Add Tag',
    startedAt: '2026-05-22T00:00:00.000Z',
    finishedAt: '2026-05-22T00:00:01.000Z',
    targetIds: [42],
    created: {
      templates: [],
      mpws: [],
      server_groups: [],
      attributes: [],
      tags: [{ serverId: 42, tag: 'rollback-test', viaRowIndex: 0 }]
    },
    attached: { templateAttachments: [] },
    order: ['tag:42:rollback-test'],
    rollback: null,
    ...extras
  };
}

test.describe('FMN-237: Rollback Changes (rollback UI)', () => {
  test('Popup carries a tile with the FMN-237 label and URL', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    const tile = page.locator('.tool-card[data-tool="bulk-composer-runs"]');
    await expect(tile).toBeVisible();
    await expect(tile.locator('.tool-name')).toContainText('Rollback Changes');
    await expect(tile).toHaveAttribute('data-url', 'src/ui/bulk-composer-runs/app.html');
    await page.close();
  });

  test('Empty journal renders the empty state', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    // Ensure the key starts empty - other tests in this file run in
    // shared worker scope but key cleanup is ours to do.
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer-runs/app.html`);
    await page.evaluate(async (key) => { await chrome.storage.local.remove(key); }, JOURNAL_KEY);
    await page.locator('#refresh-btn').click();
    await expect(page.locator('.empty')).toBeVisible();
    await expect(page.locator('.empty')).toContainText('No changes recorded yet');
    await expect(page.locator('.run-card')).toHaveCount(0);
    await page.close();
  });

  test('Seeded journal renders one run card with resource counts', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer-runs/app.html`);
    await page.evaluate(async ({ key, runs }) => {
      await chrome.storage.local.set({ [key]: runs });
    }, { key: JOURNAL_KEY, runs: [fakeRunWithTag('test-run-1')] });
    await page.locator('#refresh-btn').click();
    const card = page.locator('.run-card[data-run-id="test-run-1"]');
    await expect(card).toBeVisible();
    await expect(card.locator('h3')).toContainText('Add Tag');
    await expect(card).toContainText('Tags added: 1');
    await expect(card.locator('.rollback-btn')).toBeEnabled();
    await expect(card.locator('.rollback-btn')).toHaveText(/^\s*Rollback\s*$/);
    await page.close();
  });

  test('Rollback button is disabled when the run was already fully rolled back', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer-runs/app.html`);
    const done = fakeRunWithTag('done-run', {
      rollback: {
        startedAt: '2026-05-22T00:01:00.000Z',
        finishedAt: '2026-05-22T00:01:01.000Z',
        steps: [{ kind: 'tag', identity: 'tag:42:rollback-test', label: 'tag x', status: 'succeeded' }]
      }
    });
    await page.evaluate(async ({ key, runs }) => {
      await chrome.storage.local.set({ [key]: runs });
    }, { key: JOURNAL_KEY, runs: [done] });
    await page.locator('#refresh-btn').click();
    const card = page.locator('.run-card[data-run-id="done-run"]');
    await expect(card.locator('.rollback-btn')).toBeDisabled();
    await expect(card.locator('.rollback-btn')).toHaveText(/Rolled back/);
    await expect(card.locator('.rollback-outcome .step .status.succeeded')).toBeVisible();
    await page.close();
  });

  test('Clicking Rollback round-trips to the service worker and renders the outcome panel', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    // No API key configured for this context, so the panopta factory in
    // the SW will throw; the rollback handler catches and surfaces a
    // "PanoptaClient unavailable" step. That's the outcome we assert on -
    // it proves the full message round-trip + outcome persistence path.
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer-runs/app.html`);
    await page.evaluate(async ({ key, runs }) => {
      await chrome.storage.local.set({ [key]: runs });
    }, { key: JOURNAL_KEY, runs: [fakeRunWithTag('roundtrip-run')] });
    await page.locator('#refresh-btn').click();
    page.once('dialog', (d) => d.accept());
    await page.locator('.run-card[data-run-id="roundtrip-run"] .rollback-btn').click();
    const outcome = page.locator('.run-card[data-run-id="roundtrip-run"] .rollback-outcome');
    await expect(outcome).toBeVisible({ timeout: 10_000 });
    await expect(outcome.locator('.step .status.failed')).toBeVisible();
    await expect(outcome).toContainText(/PanoptaClient unavailable/);
    // After completion, the button stays enabled (not fully rolled back) so
    // operator can retry once they fix the missing client.
    await expect(page.locator('.run-card[data-run-id="roundtrip-run"] .rollback-btn')).toBeEnabled();
    await page.close();
  });
});
