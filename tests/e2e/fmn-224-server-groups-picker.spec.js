// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-224: Bulk Composer "Server groups" input mode.
//
// Verifies the new tab on the Bulk Composer pick step that lets the
// operator load devices by ticking server groups instead of pasting IDs.
//
// The SW handler bulk-composer:list-server-groups-tree is stubbed via
// chrome.runtime.sendMessage so the spec runs without a live FortiMonitor
// session. Per memory playwright_stub_chrome_runtime_only: stub
// sendMessage only, leave chrome.tabs / chrome.storage real.
//
// Run: npx playwright test tests/e2e/fmn-224-server-groups-picker.spec.js

import { test, expect } from './fixtures.js';

async function openPickWithStub({ page, extensionId, treeReply }) {
  await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);
  await page.evaluate(({ treeReply }) => {
    window.__fmn224TestReplies = { treeReply };
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function (msg, cb) {
      const type = msg && msg.type;
      if (type === 'bulk-composer:list-server-groups-tree') {
        const result = window.__fmn224TestReplies.treeReply;
        const envelope = result === null
          ? { ok: false, error: 'stub-error' }
          : { ok: true, result };
        if (typeof cb === 'function') cb(envelope);
        return undefined;
      }
      return originalSendMessage(msg, cb);
    };
  }, { treeReply });
}

const SAMPLE_REPLY = {
  groups: [
    {
      id: 0, name: 'All Instances', parentId: null, depth: 0,
      directMemberIds: [], allMemberIds: [42024060, 42024061, 42024075],
      skippedOnsightCount: 0, skippedCompoundCount: 0, skippedTemplateCount: 0
    },
    {
      id: 100, name: 'Branch Offices', parentId: 0, depth: 1,
      directMemberIds: [42024060, 42024061], allMemberIds: [42024060, 42024061],
      skippedOnsightCount: 0, skippedCompoundCount: 0, skippedTemplateCount: 0
    },
    {
      id: 200, name: 'Data Centers', parentId: 0, depth: 1,
      directMemberIds: [42024075], allMemberIds: [42024075],
      skippedOnsightCount: 1, skippedCompoundCount: 0, skippedTemplateCount: 0
    },
    {
      id: 300, name: 'Templates Group', parentId: 0, depth: 1,
      directMemberIds: [], allMemberIds: [],
      skippedOnsightCount: 0, skippedCompoundCount: 0, skippedTemplateCount: 6
    }
  ],
  nameById: {
    42024060: 'fw-branch-01',
    42024061: 'fw-branch-02',
    42024075: 'fw-datacenter-01'
  }
};

test.describe('FMN-224: Bulk Composer server-groups picker', () => {
  test('tab strip toggles between Paste and Server groups; defaults to Paste', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();

    await openPickWithStub({ page, extensionId, treeReply: SAMPLE_REPLY });

    const pasteTab = page.locator('[data-test="pick-tab-paste"]');
    const groupsTab = page.locator('[data-test="pick-tab-groups"]');
    await expect(pasteTab).toHaveClass(/active/);
    await expect(groupsTab).not.toHaveClass(/active/);

    // Paste pane visible, paste textarea reachable.
    await expect(page.locator('.pick-pane[data-pane="paste"]')).toBeVisible();
    await expect(page.locator('textarea.paste-area')).toBeVisible();
    await expect(page.locator('.pick-pane[data-pane="groups"]')).toBeHidden();

    // Switch to groups.
    await groupsTab.click();
    await expect(groupsTab).toHaveClass(/active/);
    await expect(pasteTab).not.toHaveClass(/active/);
    await expect(page.locator('.pick-pane[data-pane="groups"]')).toBeVisible();
    await expect(page.locator('.pick-pane[data-pane="paste"]')).toBeHidden();

    await page.close();
  });

  test('Groups tab renders rows from the stubbed SW handler in tree order', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();

    await openPickWithStub({ page, extensionId, treeReply: SAMPLE_REPLY });
    await page.locator('[data-test="pick-tab-groups"]').click();

    // List renders one row per group.
    const rows = page.locator('.pick-group-row');
    await expect(rows).toHaveCount(4);
    await expect(page.locator('.pick-group-name').nth(0)).toHaveText('All Instances');
    await expect(page.locator('.pick-group-name').nth(1)).toHaveText('Branch Offices');

    // Status line reports group count.
    await expect(page.locator('.pick-groups-status')).toContainText('4 groups loaded');

    // Member counts shown.
    await expect(page.locator('.pick-group-count').nth(0)).toHaveText('3 devices');
    await expect(page.locator('.pick-group-count').nth(3)).toHaveText('0 devices');

    await page.close();
  });

  test('Picking a group writes store.targets with names from the tree response', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();

    await openPickWithStub({ page, extensionId, treeReply: SAMPLE_REPLY });
    await page.locator('[data-test="pick-tab-groups"]').click();

    await page.locator('[data-test="pick-group-checkbox-100"]').check();

    // Summary updates.
    await expect(page.locator('.pick-groups-summary')).toContainText('1 group selected, 2 unique devices');

    // Parse-result panel reflects the picked union.
    await expect(page.locator('.parse-result .headline')).toContainText('2 instances ready');

    // store.targets carries the right ids + resolved names.
    const targets = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.targets;
    });
    expect(targets).toEqual([
      { id: 42024060, name: 'fw-branch-01' },
      { id: 42024061, name: 'fw-branch-02' }
    ]);

    // Continue button enables.
    await expect(page.locator('[data-test="pick-next"]')).toBeEnabled();

    await page.close();
  });

  test('Picking overlapping groups dedupes; cleared selection empties store.targets', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();

    await openPickWithStub({ page, extensionId, treeReply: SAMPLE_REPLY });
    await page.locator('[data-test="pick-tab-groups"]').click();

    // Pick "All Instances" (3 devices) + "Branch Offices" (overlap of 2).
    await page.locator('[data-test="pick-group-checkbox-0"]').check();
    await page.locator('[data-test="pick-group-checkbox-100"]').check();
    await expect(page.locator('.pick-groups-summary')).toContainText('2 groups selected, 3 unique devices');

    // Clear empties store.targets and disables Continue.
    await page.locator('button:has-text("Clear")').click();
    await expect(page.locator('[data-test="pick-next"]')).toBeDisabled();
    const targetsAfterClear = await page.evaluate(async () => {
      const mod = await import('./app.js');
      return mod.store.targets;
    });
    expect(targetsAfterClear).toEqual([]);

    await page.close();
  });

  test('Sort toggle: defaults to FortiMonitor order; A-Z reorders alphabetically', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();

    await openPickWithStub({ page, extensionId, treeReply: SAMPLE_REPLY });
    await page.locator('[data-test="pick-tab-groups"]').click();

    // Tree button active by default.
    await expect(page.locator('[data-test="pick-groups-sort-tree"]')).toHaveClass(/active/);
    await expect(page.locator('[data-test="pick-groups-sort-alpha"]')).not.toHaveClass(/active/);

    // Default order matches SAMPLE_REPLY's tree order: root, then Branch, then Data, then Templates.
    let names = await page.locator('.pick-group-name').allTextContents();
    expect(names).toEqual(['All Instances', 'Branch Offices', 'Data Centers', 'Templates Group']);

    // Flip to alphabetical.
    await page.locator('[data-test="pick-groups-sort-alpha"]').click();
    await expect(page.locator('[data-test="pick-groups-sort-alpha"]')).toHaveClass(/active/);
    await expect(page.locator('[data-test="pick-groups-sort-tree"]')).not.toHaveClass(/active/);

    names = await page.locator('.pick-group-name').allTextContents();
    expect(names).toEqual(['All Instances', 'Branch Offices', 'Data Centers', 'Templates Group']);
    // (SAMPLE_REPLY happens to already be alphabetical; assert the sort runs by switching back and forth without breaking.)

    await page.locator('[data-test="pick-groups-sort-tree"]').click();
    await expect(page.locator('[data-test="pick-groups-sort-tree"]')).toHaveClass(/active/);

    await page.close();
  });

  test('Sort toggle: alpha actually reorders when tree order differs from alphabetical', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    // Build a tree where tree order != alpha order.
    const reply = {
      groups: [
        { id: 0, name: 'Zeta Root', parentId: null, depth: 0, directMemberIds: [], allMemberIds: [1, 2, 3], skippedOnsightCount: 0, skippedCompoundCount: 0, skippedTemplateCount: 0 },
        { id: 1, name: 'middle group', parentId: 0, depth: 1, directMemberIds: [1], allMemberIds: [1], skippedOnsightCount: 0, skippedCompoundCount: 0, skippedTemplateCount: 0 },
        { id: 2, name: 'Alpha group', parentId: 0, depth: 1, directMemberIds: [2], allMemberIds: [2], skippedOnsightCount: 0, skippedCompoundCount: 0, skippedTemplateCount: 0 },
        { id: 3, name: 'beta group', parentId: 0, depth: 1, directMemberIds: [3], allMemberIds: [3], skippedOnsightCount: 0, skippedCompoundCount: 0, skippedTemplateCount: 0 }
      ],
      nameById: { 1: 'm', 2: 'a', 3: 'b' }
    };
    await openPickWithStub({ page, extensionId, treeReply: reply });
    await page.locator('[data-test="pick-tab-groups"]').click();

    // Tree order: Zeta Root, middle, Alpha, beta.
    let names = await page.locator('.pick-group-name').allTextContents();
    expect(names).toEqual(['Zeta Root', 'middle group', 'Alpha group', 'beta group']);

    // Alpha order (case-insensitive): Alpha, beta, middle, Zeta Root.
    await page.locator('[data-test="pick-groups-sort-alpha"]').click();
    names = await page.locator('.pick-group-name').allTextContents();
    expect(names).toEqual(['Alpha group', 'beta group', 'middle group', 'Zeta Root']);

    // Back to tree order.
    await page.locator('[data-test="pick-groups-sort-tree"]').click();
    names = await page.locator('.pick-group-name').allTextContents();
    expect(names).toEqual(['Zeta Root', 'middle group', 'Alpha group', 'beta group']);

    await page.close();
  });

  test('Search filter narrows the visible group list', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();

    await openPickWithStub({ page, extensionId, treeReply: SAMPLE_REPLY });
    await page.locator('[data-test="pick-tab-groups"]').click();

    await page.locator('[data-test="pick-groups-search"]').fill('branch');
    await expect(page.locator('.pick-group-row')).toHaveCount(1);
    await expect(page.locator('.pick-group-name')).toHaveText('Branch Offices');

    await page.locator('[data-test="pick-groups-search"]').fill('nothing-matches-this');
    await expect(page.locator('.pick-groups-empty')).toBeVisible();
    await expect(page.locator('.pick-groups-empty')).toContainText('No groups match');

    await page.close();
  });

  test('Empty groups (0 devices) render a hint instead of an enabled Continue', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();

    await openPickWithStub({ page, extensionId, treeReply: SAMPLE_REPLY });
    await page.locator('[data-test="pick-tab-groups"]').click();

    // Templates Group has 0 real members.
    await page.locator('[data-test="pick-group-checkbox-300"]').check();
    await expect(page.locator('.parse-result .headline')).toContainText('contain no devices');
    await expect(page.locator('[data-test="pick-next"]')).toBeDisabled();

    await page.close();
  });

  test('Auth failure surfaces a session-expired hint and an empty list', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();

    await openPickWithStub({
      page,
      extensionId,
      treeReply: { groups: [], nameById: {}, error: 'FortimonitorError: session not recognized (login)' }
    });
    await page.locator('[data-test="pick-tab-groups"]').click();

    await expect(page.locator('.pick-groups-status-error')).toBeVisible();
    await expect(page.locator('.pick-groups-status-error')).toContainText('session may have expired');
    await expect(page.locator('.pick-group-row')).toHaveCount(0);

    await page.close();
  });
});
