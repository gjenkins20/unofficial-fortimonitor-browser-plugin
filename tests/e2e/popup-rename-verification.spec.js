// Verification spec for the FMN-126 + Ask Claude/Ask AI rename catch-up
// (2026-04-30). Asserts the doc-and-label changes landed in the popup DOM
// the operator actually loads, not just in the source files. Per the
// "verify in playwright what you can" rule (memory file
// verify_in_playwright_what_you_can.md), this is the verifiable residue
// of the doc commit; running it eliminates the NOT VERIFIED IN BROWSER
// disclosure that would otherwise apply.

import { test, expect } from './fixtures.js';

test.describe('popup labels (post-rename)', () => {
  test.beforeEach(async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await expect(page.locator('.tool-card[data-tool="find-servers"]')).toBeAttached();
    test.info().annotations.push({ type: 'page', description: page.url() });
    test.info()._page = page;
  });

  test.afterEach(async () => {
    const page = test.info()._page;
    if (page) await page.close();
  });

  test('Find Servers tile has no Prototype badge', async () => {
    const page = test.info()._page;
    const tile = page.locator('.tool-card[data-tool="find-servers"]');
    await expect(tile).toBeAttached();
    await expect(tile.locator('.badge')).toHaveCount(0);
  });

  test('Ask AI tile shows "Ask AI", not "Ask Claude"', async () => {
    const page = test.info()._page;
    const tile = page.locator('.tool-card[data-tool="ask-claude"]');
    await expect(tile).toBeAttached();
    const name = tile.locator('.tool-name');
    await expect(name).toContainText('Ask AI');
    await expect(name).not.toContainText('Ask Claude');
  });

  test('aria-label on tool-tier radio group is "Ask AI tool tier"', async () => {
    const page = test.info()._page;
    const group = page.locator('[role="radiogroup"][aria-label="Ask AI tool tier"]');
    await expect(group).toHaveCount(1);
  });

  test('Search Servers settings toggle reads "Show Search Servers" (no "(prototype)")', async () => {
    const page = test.info()._page;
    const toggleSpan = page.locator('label.toggle-row:has(#server-search-toggle) span');
    await expect(toggleSpan).toBeAttached();
    const text = (await toggleSpan.textContent())?.trim() ?? '';
    expect(text).toBe('Show Search Servers');
  });
});
