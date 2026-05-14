#!/usr/bin/env node
// FMN-154 Phase 2 live QA. Attaches to the operator's running Chromium
// (with the loaded extension + authenticated FortiMonitor session) and
// drives the popup + diff viewer + storage state to confirm the new
// rotation / picker / multi-tab / settings surfaces all work end-to-end
// against the real service worker.
//
// Does NOT run a real BPA scan (that takes 3+ minutes). Instead seeds
// synthetic condensed snapshots directly into chrome.storage.local via
// a SW evaluate, so the picker + diff path is exercised against the
// production handler code path with real chrome.storage.local.

import { chromium } from '@playwright/test';

const CDP = `http://localhost:${process.env.FMN_CDP_PORT || 9222}`;
const TENANT_ORIGIN_FALLBACK = 'https://fortimonitor.forticloud.com';

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 5_000 });
const extId = new URL(sw.url()).host;
console.log(`Extension id: ${extId}`);

const findings = [];
const record = (name, ok, detail = '') => {
  findings.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -  ' + detail : ''}`);
};

// 1. Wipe any pre-existing snapshots so we start from a known state.
await sw.evaluate(async () => {
  await chrome.storage.local.remove('fm:bpaSnapshots');
});

// 2. Open the popup and verify Settings flow: toggle on -> controls
//    visible, rotation defaults to 10, set to 4, persist, set Clear.
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'domcontentloaded' });
await popup.locator('#settings-toggle').click();
const toggle = popup.locator('#snapshot-diff-toggle');
const isChecked = await toggle.isChecked();
if (isChecked) await toggle.uncheck();
await toggle.check();
await popup.locator('[data-snapshot-diff-controls]').waitFor({ state: 'visible', timeout: 5_000 });
const initialRotation = await popup.locator('#snapshot-rotation-input').inputValue();
record('Settings: rotation defaults to 10 on first reveal', initialRotation === '10', `got "${initialRotation}"`);

await popup.locator('#snapshot-rotation-input').fill('4');
await popup.locator('#snapshot-rotation-input').dispatchEvent('change');
await popup.locator('#snapshot-rotation-status.ok').waitFor({ timeout: 4_000 });
const savedRotation = await popup.locator('#snapshot-rotation-input').inputValue();
const persistedMax = await sw.evaluate(async () => {
  const r = await chrome.storage.local.get('fm:bpaSnapshots');
  return r['fm:bpaSnapshots']?.maxSnapshots ?? null;
});
record('Settings: rotation=4 persists to chrome.storage.local',
  savedRotation === '4' && persistedMax === 4,
  `input="${savedRotation}", stored maxSnapshots=${persistedMax}`);

// 3. Seed three synthetic snapshots by importing bpa-snapshots.js into
//    the popup page (SW disallows dynamic import per HTML spec). The
//    popup is a chrome-extension:// page so it can resolve the module
//    URL by extension id.
const seedResult = await popup.evaluate(async (extensionId) => {
  const mod = await import(`chrome-extension://${extensionId}/src/lib/bpa-snapshots.js`);
  const mkSnap = (takenAt, servers, users = [], templates = [], groups = []) => ({
    schema: 1,
    takenAt,
    durationMs: 30_000,
    customer: { id: 1, name: 'Live QA', subdomain: 'liveqa' },
    inventory: {
      servers, users, server_templates: templates, server_groups: groups,
    },
  });
  await mod.writeSnapshot(mkSnap(
    '2026-05-14T10:00:00.000Z',
    [{ id: 1, name: 'fw-east', fqdn: '10.0.0.1', status: 'ok', tags: ['prod'], server_template: [100] }],
    [{ id: 50, username: 'alice', first_name: 'Alice', is_active: true, user_role: 'admin' }],
    [{ id: 100, name: 'FG Stock', template_type: 'fabric_template', server_group: 5, applied_servers: 3 }],
    [{ id: 5, name: 'Prod' }],
  ));
  await mod.writeSnapshot(mkSnap(
    '2026-05-14T11:00:00.000Z',
    [{ id: 1, name: 'fw-east', fqdn: '10.0.0.1', status: 'ok', tags: ['prod'], server_template: [100] }],
    [{ id: 50, username: 'alice', first_name: 'Alice', is_active: true, user_role: 'admin' }],
    [{ id: 100, name: 'FG Stock', template_type: 'fabric_template', server_group: 5, applied_servers: 5 }],
    [{ id: 5, name: 'Prod' }],
  ));
  await mod.writeSnapshot(mkSnap(
    '2026-05-14T12:00:00.000Z',
    [
      { id: 1, name: 'fw-east-renamed', fqdn: '10.0.0.1', status: 'ok', tags: ['prod'], server_template: [100] },
      { id: 2, name: 'fw-west', fqdn: '10.0.0.2', status: 'ok', tags: [], server_template: [] },
    ],
    [{ id: 50, username: 'alice', first_name: 'Alice', is_active: false, user_role: 'admin' }],
    [{ id: 100, name: 'FG Stock', template_type: 'fabric_template', server_group: 5, applied_servers: 7 }],
    [{ id: 5, name: 'Production' }],
  ));
  return mod.listAllSnapshots();
}, extId);
record('Storage: seeded 3 snapshots; listAllSnapshots returns 3',
  seedResult.length === 3,
  `got ${seedResult.length}, ids=${seedResult.map((s) => s.id).join(',')}`);

// 4. Open the diff viewer. Expect picker dropdowns with 3 options each.
const viewer = await ctx.newPage();
await viewer.goto(`chrome-extension://${extId}/src/ui/bpa-diff/app.html`, { waitUntil: 'domcontentloaded' });
await viewer.locator('#baseline-select').waitFor({ timeout: 5_000 });
const baselineOptionCount = await viewer.locator('#baseline-select option').count();
const currentOptionCount = await viewer.locator('#current-select option').count();
record('Viewer: picker dropdowns populated from list handler',
  baselineOptionCount === 3 && currentOptionCount === 3,
  `baseline=${baselineOptionCount}, current=${currentOptionCount}`);

// Defaults: current = newest, baseline = previous.
const defaultBaseline = await viewer.locator('#baseline-select').inputValue();
const defaultCurrent = await viewer.locator('#current-select').inputValue();
record('Viewer: defaults pair current+previous slots',
  Boolean(defaultBaseline && defaultCurrent && defaultBaseline !== defaultCurrent),
  `baseline="${defaultBaseline}" vs current="${defaultCurrent}"`);

// 5. Tab strip has 4 tabs.
const tabCount = await viewer.locator('.tab-strip button.tab').count();
record('Viewer: tab strip shows 4 sections', tabCount === 4, `got ${tabCount}`);

// 6. Each tab has its expected count. Diff(previous, current) =
//    servers: 1 added (id 2) + 1 modified (id 1 name change) = 2
//    users: 1 modified (is_active flip)
//    templates: 1 modified (applied_servers 5 -> 7)
//    groups: 1 modified (name rename)
const tabCounts = await viewer.evaluate(() => {
  const out = {};
  for (const btn of document.querySelectorAll('.tab-strip button.tab')) {
    // First non-whitespace text node is the section label.
    const labelNode = Array.from(btn.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    const label = labelNode ? labelNode.textContent.trim() : '';
    const c = btn.querySelector('.tab-count')?.textContent ?? '?';
    out[label] = c;
  }
  return out;
});
record('Viewer: per-tab counts match expected diff shape',
  tabCounts.Instances === '2' && tabCounts.Templates === '1' &&
  tabCounts.Users === '1' && tabCounts['Server Groups'] === '1',
  JSON.stringify(tabCounts));

// 7. Click Templates tab; verify the diff table re-renders with the
//    template-specific column header.
await viewer.locator('.tab-strip button.tab', { hasText: 'Templates' }).click();
const headerAfterSwitch = await viewer.locator('table.diff th').nth(1).textContent();
record('Viewer: Templates tab switches entity header to "Template"',
  headerAfterSwitch?.trim() === 'Template',
  `got "${headerAfterSwitch?.trim()}"`);

// 8. Change baseline dropdown to the oldest snapshot (T1). The diff
//    against T3 should now show 2 server changes still (id 1 modified,
//    id 2 added) since T1 and T2 had the same server list.
const allIds = await viewer.locator('#baseline-select option').evaluateAll((opts) => opts.map((o) => o.value));
const oldestId = allIds[allIds.length - 1];
await viewer.locator('#baseline-select').selectOption(oldestId);
// Switch back to Instances so we can read the row count.
await viewer.locator('.tab-strip button.tab', { hasText: 'Instances' }).click();
await viewer.waitForTimeout(150); // let the new diff render
const rowsAfterRebase = await viewer.locator('table.diff tbody tr').count();
record('Viewer: baseline change re-runs the diff (T1 -> T3 still shows 2 server rows)',
  rowsAfterRebase === 2, `got ${rowsAfterRebase} rows`);

// 9. Test Settings "Clear all snapshots" from the popup -> picker
//    should show the empty state. Stub window.confirm to skip the
//    native dialog (Playwright's dialog event handling races against
//    the synchronous confirm() call inside an inline click handler).
// Stub confirm, then trigger Clear by dispatching a synthetic click
// from inside the popup page. Playwright's locator.click() through CDP
// has been observed to race against popup event-handler attachment
// after cross-page interactions in this test; the in-page click() call
// is the same code path the operator hits with a real mouse.
await popup.evaluate(() => {
  window.confirm = () => true;
  document.getElementById('snapshot-clear-all').click();
});
await popup.locator('#snapshot-clear-status.ok').waitFor({ timeout: 4_000 });
const clearedByPolling = await (async () => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const empty = await sw.evaluate(async () => {
      const r = await chrome.storage.local.get('fm:bpaSnapshots');
      return r['fm:bpaSnapshots'] == null;
    });
    if (empty) return true;
    await popup.waitForTimeout(100);
  }
  return false;
})();
record('Settings: Clear-all removes fm:bpaSnapshots key from storage',
  clearedByPolling, clearedByPolling ? 'cleared within 3s' : 'still has data after 3s of polling');

// Reload viewer; the picker should now show 0 options.
await viewer.reload({ waitUntil: 'domcontentloaded' });
await viewer.waitForTimeout(500);
const afterClearOptions = await viewer.locator('#baseline-select option').count();
const afterClearContent = await viewer.locator('#content').textContent();
record('Settings: Clear all wipes storage; picker shows zero options',
  afterClearOptions === 1 && /no snapshots stored yet/i.test(afterClearContent),
  `options=${afterClearOptions}, content snippet="${afterClearContent?.slice(0, 80)}..."`);

// 10. Verify the Reports-page card responds to the toggle being on.
//     Just check that the existing tenant tab can navigate to
//     /report/ListReports and see the card data attribute.
const tenant = ctx.pages().find((p) => /fortimonitor/i.test(p.url()));
if (tenant) {
  // Note: avoid bringToFront so the tenant tab does not steal focus.
  await tenant.goto(`${TENANT_ORIGIN_FALLBACK}/report/ListReports`, { waitUntil: 'domcontentloaded' });
  await tenant.waitForTimeout(2_000); // let augment.js mount
  const cardPresent = await tenant.locator('[data-fmn-entry="fmn-snapshot-diff-card"]').count();
  record('Reports page: Snapshot & Diff card mounts when toggle is on',
    cardPresent >= 1, `cards found: ${cardPresent}`);
} else {
  record('Reports page: skipped (no FortiMonitor tab in context)', false, 'no tab');
}

// 11. Cleanup: turn the feature toggle back off so the next operator
//     session looks like a clean slate.
await popup.locator('#snapshot-diff-toggle').uncheck();
await popup.locator('[data-snapshot-diff-controls]').waitFor({ state: 'hidden', timeout: 3_000 });
record('Cleanup: feature toggle returned to off; controls re-hidden', true);

await popup.close();
await viewer.close();
await browser.close();

const failed = findings.filter((f) => !f.ok);
console.log(`\n=== ${findings.length - failed.length}/${findings.length} passed ===`);
if (failed.length) {
  for (const f of failed) console.log(`FAIL  ${f.name}  -  ${f.detail}`);
  process.exit(1);
}
