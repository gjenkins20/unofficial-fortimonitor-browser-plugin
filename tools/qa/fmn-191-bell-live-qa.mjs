// FMN-191 (pivot) live QA: verify the in-page report-completion bell
// mounts next to the FortiMonitor topbar search, lights up on a
// completion event, shows the dropdown with history rows, and
// navigates the tab to /report/ListReports on row click.
import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 5_000 });
const extId = new URL(sw.url()).host;

const findings = [];
const rec = (name, ok, detail = '') => {
  findings.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -  ' + detail : ''}`);
};

const tenant = ctx.pages().find((p) => /fortimonitor/i.test(p.url()));
if (!tenant) { console.error('No FortiMonitor tab.'); process.exit(1); }
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'domcontentloaded' });
const sendToSW = (type, payload = {}) => popup.evaluate(({ type, payload }) =>
  new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, (r) => resolve(r)))
, { type, payload });

// 1. Manifest no longer requests "notifications".
const perms = await sw.evaluate(() => chrome.runtime.getManifest().permissions || []);
rec('Manifest no longer requests "notifications" permission',
  !perms.includes('notifications'), `perms=${perms.join(',')}`);

// 2. Toggle feature off + on. Bell starts hidden when off.
await popup.locator('#settings-toggle').click();
const toggle = popup.locator('#report-notifications-toggle');
if (await toggle.isChecked()) {
  await toggle.uncheck();
  await popup.waitForTimeout(300); // let the change propagate to storage
}
// Reset state.
await sendToSW('report-notifications:reset');
await sendToSW('report-notifications:clear-history');
await sendToSW('report-notifications:clear-badge');
// Reload tenant so the (fresh-content-script) bell observes the off state.
await tenant.goto('https://fortimonitor.forticloud.com/dashboardv2/renderDashboard?dashboard_id=51268', { waitUntil: 'domcontentloaded' });
await tenant.waitForTimeout(3_500); // longer for content script to load + read flag
const bellWhenOff = await tenant.evaluate(() =>
  !!document.querySelector('[data-fmn-entry="fmn-report-bell"]')
);
rec('Bell hidden when feature is off', bellWhenOff === false, `present=${bellWhenOff}`);

// 3. Flip toggle on; expect bell to appear next to the searchbar.
await toggle.check();
await tenant.waitForTimeout(2_500);
const bellWhenOn = await tenant.evaluate(() => {
  const bell = document.querySelector('[data-fmn-entry="fmn-report-bell"]');
  if (!bell) return { present: false };
  // Is it adjacent to the search input's li?
  const search = document.querySelector('#fmn-omni-search-input, input[placeholder*="Search Instances"]');
  const searchLi = search?.closest('li');
  return {
    present: true,
    inSiblingOfSearchLi: !!searchLi && searchLi.nextElementSibling === bell,
    visible: bell.offsetParent !== null,
  };
});
rec('Bell mounts next to the searchbar when toggle flips on',
  bellWhenOn.present && bellWhenOn.inSiblingOfSearchLi && bellWhenOn.visible,
  JSON.stringify(bellWhenOn));

// 4. Initially no badge (count=0).
const badgeStateInit = await tenant.evaluate(() => {
  const badge = document.querySelector('[data-fmn-entry="fmn-report-bell"] .fmn-report-bell-badge');
  return { hidden: badge?.hidden, text: badge?.textContent };
});
rec('Initial bell badge is hidden (count=0)',
  badgeStateInit.hidden === true,
  JSON.stringify(badgeStateInit));

// 5. Click "Simulate a completion" in the popup; bell badge updates to 1
//    via chrome.storage.onChanged.
await popup.locator('#report-notifications-test').click();
await popup.locator('#report-notifications-test-status.ok').waitFor({ timeout: 3_000 });
await tenant.waitForTimeout(800);
const badgeAfterTest = await tenant.evaluate(() => {
  const badge = document.querySelector('[data-fmn-entry="fmn-report-bell"] .fmn-report-bell-badge');
  return { hidden: badge?.hidden, text: badge?.textContent?.trim() };
});
rec('Bell badge updates to 1 after simulate-completion test',
  badgeAfterTest.hidden === false && badgeAfterTest.text === '1',
  JSON.stringify(badgeAfterTest));

// 6. Click the bell; dropdown appears with the history entry.
await tenant.evaluate(() => {
  document.querySelector('[data-fmn-entry="fmn-report-bell"] .fmn-report-bell-btn').click();
});
await tenant.waitForTimeout(500);
const dropdownState = await tenant.evaluate(() => {
  const dd = document.querySelector('[data-fmn-entry="fmn-report-bell"] .fmn-report-bell-dropdown');
  const list = dd?.querySelector('.fmn-report-bell-dropdown-list');
  const rows = list ? Array.from(list.querySelectorAll('li')) : [];
  return {
    open: !dd?.hidden,
    rowCount: rows.length,
    firstRowText: rows[0]?.querySelector('button')?.textContent?.replace(/\s+/g, ' ').trim(),
  };
});
rec('Bell click opens dropdown',
  dropdownState.open === true, JSON.stringify(dropdownState));
rec('Dropdown lists the test entry',
  dropdownState.rowCount === 1 && /Test Notification|report finished/.test(dropdownState.firstRowText || ''),
  JSON.stringify(dropdownState));

// 7. Click on the bell clears the toolbar badge via SW message.
await tenant.waitForTimeout(500);
const swBadgeAfterOpen = await sw.evaluate(() =>
  new Promise((resolve) => chrome.action.getBadgeText({}, resolve))
);
rec('Opening the bell dropdown clears the toolbar badge',
  swBadgeAfterOpen === '',
  `badge="${swBadgeAfterOpen}"`);

// 8. Click a history row -> tenant tab navigates to /report/ListReports
//    on the Report History sub-tab.
await tenant.evaluate(() => {
  const main = document.querySelector('[data-fmn-entry="fmn-report-bell"] .fmn-report-bell-dropdown-row-main');
  if (main) main.click();
});
await tenant.waitForURL(/\/report\/ListReports/i, { timeout: 6_000 }).catch(() => {});
rec('Clicking a history row navigates the tenant tab to Report History',
  /\/report\/ListReports#report-history/i.test(tenant.url()),
  `url=${tenant.url().slice(-70)}`);

// 9. Clear history button empties the dropdown.
await tenant.waitForTimeout(1_500);
// Open the dropdown again on the new page; the bell remounted post-nav.
await tenant.evaluate(() => {
  document.querySelector('[data-fmn-entry="fmn-report-bell"] .fmn-report-bell-btn')?.click();
});
await tenant.waitForTimeout(300);
await tenant.evaluate(() => {
  document.querySelector('[data-fmn-entry="fmn-report-bell"] .fmn-report-bell-dropdown-clear')?.click();
});
await tenant.waitForTimeout(500);
const afterClear = await tenant.evaluate(() => {
  const list = document.querySelector('[data-fmn-entry="fmn-report-bell"] .fmn-report-bell-dropdown-list');
  const empty = document.querySelector('[data-fmn-entry="fmn-report-bell"] .fmn-report-bell-dropdown-empty');
  return {
    listHidden: list?.hidden,
    rowCount: list ? Array.from(list.querySelectorAll('li')).length : -1,
    emptyShown: empty && !empty.hidden,
  };
});
rec('Bell "Clear" empties the dropdown and shows the empty state',
  afterClear.rowCount === 0 && afterClear.emptyShown === true,
  JSON.stringify(afterClear));

// 10. Cleanup: toggle off.
await toggle.uncheck();
await sendToSW('report-notifications:reset');
await sendToSW('report-notifications:clear-history');
await sendToSW('report-notifications:clear-badge');
await tenant.waitForTimeout(1_000);
const cleanupState = await tenant.evaluate(() =>
  !!document.querySelector('[data-fmn-entry="fmn-report-bell"]')
);
rec('Cleanup: toggle off removes the bell from the page',
  cleanupState === false, `present=${cleanupState}`);

await popup.close();
await b.close();

const failed = findings.filter((f) => !f.ok);
console.log(`\n=== ${findings.length - failed.length}/${findings.length} passed ===`);
if (failed.length) { for (const f of failed) console.log(`FAIL  ${f.name}  -  ${f.detail}`); process.exit(1); }
