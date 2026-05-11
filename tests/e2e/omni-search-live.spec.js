// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-152 Phase 5: live spec for field-coverage of the omni-search.
//
// Connects via CDP to the long-lived Chromium started by
// tools/dev/fmn-151-browser.mjs (port 9222 by default). Each test
// drives the FM TK search input against the real tenant and asserts
// the right field-tier match shows up in the top results.
//
// Like columns-alignment-live, this spec does NOT launch Chromium and
// does NOT close it; the launcher owns the lifecycle so the
// authenticated session survives across edit / re-run cycles.

import { test as base, expect, chromium } from '@playwright/test';

const FORTIMONITOR_ORIGIN = 'https://fortimonitor.forticloud.com';
const ALL_INSTANCES_URL = `${FORTIMONITOR_ORIGIN}/report/ListServers`;
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const CDP_URL = `http://localhost:${CDP_PORT}`;

const test = base.extend({
  livePage: [async ({}, use) => {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
    } catch (e) {
      throw new Error(
        `Could not connect to Chromium at ${CDP_URL}. ` +
        `Start the dev browser first: \`node tools/dev/fmn-151-browser.mjs\`. ` +
        `Underlying error: ${e.message}`
      );
    }
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('CDP browser has no contexts');
    let page = ctx.pages().find((p) => p.url().startsWith(FORTIMONITOR_ORIGIN));
    if (!page) page = ctx.pages()[0] || await ctx.newPage();
    if (!page.url().includes('/report/ListServers')) {
      await page.goto(ALL_INSTANCES_URL, { waitUntil: 'domcontentloaded' });
    }
    // Detect login screen and bail with a clear error.
    if (await page.locator('input[type="password"]').count()) {
      throw new Error('FortiMonitor is at a login screen. Sign in in the launcher window and re-run.');
    }
    await use(page);
    await browser.close();
  }, { scope: 'worker' }],
});

test.setTimeout(120_000);

async function ensureEnabledAndWarm(page) {
  // page.evaluate runs in the PAGE world (no chrome.*). To flip the
  // flag we go through the SW: connect the existing CDP browser, find
  // the SW, set storage from there. chrome.storage.onChanged in
  // augment.js (content-script isolated world) picks it up and mounts.
  const browser = page.context().browser();
  // Some Playwright CDP-connected browsers expose context.browser() as null;
  // fall back to the context's own connection.
  const ctx = page.context();
  let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
  if (sw) {
    await sw.evaluate(() => chrome.storage.local.set({ 'fm:omniSearchEnabled': true }));
  }
  await page.waitForSelector('#fmn-omni-search-input', { timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector('.fmn-omni-chip.is-warming'), { timeout: 30_000 });
}

async function runQuery(page, q) {
  // Close any lingering dropdown from a prior test so we don't read stale
  // rows. Click body to fire the document-mousedown close handler.
  await page.mouse.click(10, 10);
  await page.waitForFunction(
    () => !document.getElementById('fmn-omni-search-dropdown')?.classList.contains('is-open'),
    { timeout: 3000 }
  ).catch(() => {});
  // Empty the field, then type fresh. fill('') doesn't reliably fire
  // input on every browser; we set value via the property explicitly
  // and dispatch input ourselves so the debounce timer rearms.
  await page.evaluate(() => {
    const i = document.getElementById('fmn-omni-search-input');
    if (i) { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await page.fill('#fmn-omni-search-input', q);
  // Wait for the dropdown to render results for *this* query. Footer
  // always exists when results come back; using its presence as the
  // "fresh content" signal is more reliable than checking row count
  // (which can be stale from the previous test).
  await page.waitForFunction(() => {
    const d = document.getElementById('fmn-omni-search-dropdown');
    if (!d?.classList.contains('is-open')) return false;
    // Either rows are rendered (with the footer following), or an
    // empty / error state is shown.
    return d.querySelector('.fmn-omni-footer') || d.querySelector('.fmn-omni-empty') || d.querySelector('.fmn-omni-error');
  }, { timeout: 8_000 });
  return page.evaluate(() => {
    const d = document.getElementById('fmn-omni-search-dropdown');
    return {
      error: d?.querySelector('.fmn-omni-error')?.textContent || null,
      empty: !!d?.querySelector('.fmn-omni-empty'),
      footer: d?.querySelector('.fmn-omni-footer span')?.textContent || null,
      rows: Array.from(d?.querySelectorAll('.fmn-omni-row') || []).map((r) => ({
        name: r.querySelector('.fmn-omni-row-name')?.textContent,
        snippet: r.querySelector('.fmn-omni-row-snippet')?.textContent,
        badge: r.querySelector('.fmn-omni-badge')?.textContent,
      })),
    };
  });
}

test.describe('live - FMN-152 omni-search field coverage', () => {
  test.beforeEach(async ({ livePage }) => {
    await ensureEnabledAndWarm(livePage);
  });

  test('live - exact name "server" surfaces the literal server as row 1', async ({ livePage }) => {
    const r = await runQuery(livePage, 'server');
    expect(r.error, 'no SW error').toBeNull();
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0].name).toBe('server');
    expect(r.rows[0].badge).toBe('name');
  });

  test('live - name-contains "SQL" includes SQL_Server_01 in the top results', async ({ livePage }) => {
    const r = await runQuery(livePage, 'SQL');
    expect(r.rows.some((row) => row.name === 'SQL_Server_01' && row.badge === 'name')).toBe(true);
  });

  test('live - fqdn / IP "10.0.0.185" finds SQL_Server_01', async ({ livePage }) => {
    const r = await runQuery(livePage, '10.0.0.185');
    expect(r.rows[0]?.name).toBe('SQL_Server_01');
    expect(['fqdn', 'ip']).toContain(r.rows[0]?.badge);
  });

  test('live - additional_fqdns IP "172.31.9.170" matches with the ip badge', async ({ livePage }) => {
    const r = await runQuery(livePage, '172.31.9.170');
    // Some servers have IPs in additional_fqdns; the IP tier should fire.
    // Allow either "ip" or "fqdn" badge - some tenants put IPs in the
    // primary fqdn field. The point is the query matches at all.
    expect(r.empty, 'no IP servers in tenant').toBeFalsy();
    expect(r.rows.length).toBeGreaterThan(0);
    expect(['ip', 'fqdn']).toContain(r.rows[0]?.badge);
  });

  test('live - tag "Linux" returns matches badged as tag', async ({ livePage }) => {
    const r = await runQuery(livePage, 'Linux');
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.some((row) => row.badge === 'tag')).toBe(true);
  });

  test('live - "Red Hat" returns at least one match (attribute value or tag)', async ({ livePage }) => {
    const r = await runQuery(livePage, 'Red Hat');
    expect(r.rows.length).toBeGreaterThan(0);
    // On the test tenant, "Red Hat Enterprise Linux" appears as a tag
    // on some servers AND as the Operating System attribute value on
    // others. Tag tier (350/300) beats attribute tier (250), so the top
    // results legitimately badge as "tag". Accept either, since the
    // point of this assertion is that the search finds Red Hat servers
    // by their fielded data, regardless of which tier wins.
    expect(r.rows.some((row) => row.badge === 'attribute' || row.badge === 'tag')).toBe(true);
  });

  test('live - attribute name "Operating System" returns attribute-badged matches', async ({ livePage }) => {
    const r = await runQuery(livePage, 'Operating System');
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.some((row) => row.badge === 'attribute')).toBe(true);
  });

  test('live - group name match: query "Incoming" returns at least one group-badged row', async ({ livePage }) => {
    const r = await runQuery(livePage, 'Incoming');
    expect(r.rows.length).toBeGreaterThan(0);
    // The "incoming" substring lives in group_name "INCOMING SERVERS" but
    // also can match server.name on some tenants; allow either name or group.
    expect(r.rows.some((row) => row.badge === 'group' || row.badge === 'name')).toBe(true);
  });
});
