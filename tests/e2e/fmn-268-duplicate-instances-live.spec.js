// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-268 LIVE spec: the Tenant Observations "Duplicates" viewer tab, rendered
// against REAL tenant data over CDP.
//
// Like the FMN-263 instance-breakdown live spec, this drives the ACTUAL
// viewer.js (and the ACTUAL analyzeDuplicates analyzer) rather than the full
// minutes-long wizard: the Duplicates tab reads only the top-level servers list,
// so we fetch that list LIVE (same /v2 wire contract the ObservationsFetcher
// uses), run the real analyzer, render the real viewer, and assert on the
// rendered DOM - the changed surface, against live FortiMonitor data.
//
// BEHAVIOR MATRIX (per Verification Discipline - not one happy path):
//   (1) LIVE data: render with the real analyzer over the live servers list and
//       assert the rendered rows match ground truth recomputed independently
//       from that same list (populated OR empty, whichever the tenant is);
//   (2) POPULATED path (deterministic): inject a crafted inventory with known
//       name + address duplicates through the REAL analyzer + REAL viewer and
//       assert the groups render (guarantees the populated render path is
//       exercised even when the live tenant happens to be clean);
//   (3) EMPTY path (deterministic): inject an inventory with no duplicates and
//       assert the empty-state copy renders.
//
// SKIP conditions (prerequisites unmet, not a failure):
//   - No extension service worker at the provisioned CDP port.
//   - No v2 API key seeded (panopta.apiKey) - can't fetch live inventory.
//   - FortiMonitor session at a login screen.
//   - (test 1 only) Tenant has zero servers.
//
// Run: FMN_CDP_PORT=<port> npx playwright test --config tests/e2e/playwright.config.js \
//   tests/e2e/fmn-268-duplicate-instances-live.spec.js --grep "live -" --reporter=line

import { test as base, expect, chromium } from '@playwright/test';

const FM = 'https://fortimonitor.forticloud.com';
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const CDP_URL = `http://localhost:${CDP_PORT}`;
const HOST_ID = '__fmn268host';

const test = base.extend({
  liveCtx: [async ({}, use) => {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
    } catch (e) {
      throw new Error(
        `Could not connect to Chromium at ${CDP_URL}. A pre-provisioned ` +
        `authenticated Chromium with the extension loaded must be running at ` +
        `that CDP port. Underlying error: ${e.message}`
      );
    }
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('CDP browser has no contexts');
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
    let fmPage = ctx.pages().find((p) => p.url().startsWith(FM));
    let atLogin = false;
    if (fmPage) atLogin = (await fmPage.locator('input[type="password"]').count()) > 0;
    await use({ ctx, sw, browser, atLogin });
    await browser.close();
  }, { scope: 'worker' }]
});

test.setTimeout(120_000);

async function apiKeyConfigured(sw) {
  if (!sw) return false;
  return await sw.evaluate(async () => {
    const d = await chrome.storage.local.get('panopta.apiKey');
    return Boolean(d?.['panopta.apiKey']);
  });
}

// Fetch the servers list LIVE inside the SW (holds host_permissions + API key).
// Trim to the two fields the duplicate analyzer reads: name + fqdn.
async function fetchLiveServers(sw) {
  return await sw.evaluate(async () => {
    const base = 'https://api2.panopta.com/v2';
    const d = await chrome.storage.local.get('panopta.apiKey');
    const key = d?.['panopta.apiKey'];
    if (!key) return null;
    const headers = { Authorization: `ApiKey ${key}` };
    let out = [];
    let offset = 0;
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${base}/server?limit=100&offset=${offset}`, { headers });
      if (!r.ok) break;
      const b = await r.json();
      const list = b.server_list || [];
      out = out.concat(list);
      if (list.length < 100) break;
      offset += 100;
    }
    return out.map((s) => ({ url: s.url ?? null, id: s.id ?? null, name: s.name ?? '', fqdn: s.fqdn ?? '' }));
  });
}

// Independent ground truth: how many distinct-id members across all
// name-collision and address-collision groups (NOT importing the analyzer, so
// an analyzer regression cannot mask itself). Mirrors duplicate.js's contract:
// case-insensitive/trimmed key, empties never group, dedupe members by id.
function groundTruth(servers) {
  const idOf = (s) => {
    if (s.id != null && s.id !== '') return String(s.id);
    const m = /\/(\d+)\/?$/.exec(String(s.url ?? ''));
    return m ? m[1] : null;
  };
  const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const recs = servers.map((s) => ({ id: idOf(s), name: s.name ?? '', address: (s.fqdn ?? '').trim() }))
    .filter((r) => r.id != null);
  function groupCounts(valueOf) {
    const buckets = new Map();
    for (const r of recs) {
      const k = norm(valueOf(r));
      if (!k) continue;
      if (!buckets.has(k)) buckets.set(k, new Map());
      buckets.get(k).set(r.id, true);
    }
    const out = [];
    for (const [, ids] of buckets) if (ids.size >= 2) out.push(ids.size);
    return out;
  }
  const nameGroups = groupCounts((r) => r.name);
  const addrGroups = groupCounts((r) => r.address);
  const totalMembers = [...nameGroups, ...addrGroups].reduce((a, b) => a + b, 0);
  return { groupSizes: [...nameGroups, ...addrGroups].sort((a, b) => b - a), totalMembers, scanned: recs.length };
}

// Render the real viewer + real analyzer with a given inventory and return the
// rendered Duplicates-tab row data (one entry per <tr>) plus the empty-state
// text if present.
async function renderAndReadDuplicates(page, extensionId, inventory) {
  await page.goto(`chrome-extension://${extensionId}/src/ui/tenant-observations/app.html`,
    { waitUntil: 'domcontentloaded' });
  const mountErr = await page.evaluate(async ({ hostId, inventory }) => {
    try {
      const host = document.createElement('div');
      host.id = hostId;
      document.body.appendChild(host);
      const [viewer, analyzer] = await Promise.all([
        import('./viewer.js'),
        import('../../lib/observation-analyzers/duplicate.js')
      ]);
      const analysis = { duplicates: analyzer.analyzeDuplicates(inventory) };
      viewer.renderViewer({
        root: host,
        store: { customerName: 'FMN-268 live', runResult: { inventory, analysis } }
      });
      return null;
    } catch (e) {
      return String((e && e.stack) || e);
    }
  }, { hostId: HOST_ID, inventory });
  if (mountErr) return { mountErr };

  const tabBtn = page.locator(`#${HOST_ID} button[data-tab="duplicate-instances"]`);
  await expect(tabBtn, 'the Duplicates tab button must render').toBeVisible({ timeout: 10_000 });
  await tabBtn.click();

  return await page.evaluate((hostId) => {
    const host = document.getElementById(hostId);
    // FMN-272: the tab now has two sections (by name / by IP address); the
    // axis comes from the section heading, not a column. Columns within a
    // section: value, set-size, id, name, address.
    const out = { rows: [], emptyText: '' };
    let sawEmpty = false;
    for (const sec of host.querySelectorAll('.review-section')) {
      const heading = (sec.querySelector('h3.subhead')?.textContent || '').toLowerCase();
      const axis = heading.includes('name') ? 'Name' : 'Address';
      const trs = sec.querySelectorAll('table.review-table tbody tr');
      if (trs.length === 0) {
        if (sec.querySelector('p.muted')) { sawEmpty = true; out.emptyText = sec.querySelector('p.muted').textContent.trim(); }
        continue;
      }
      for (const tr of trs) {
        const tds = tr.querySelectorAll('td');
        out.rows.push({
          match: axis,
          value: (tds[0]?.textContent ?? '').trim(),
          groupSize: (tds[1]?.textContent ?? '').trim(),
          id: (tds[2]?.textContent ?? '').trim()
        });
      }
    }
    if (out.rows.length > 0) out.emptyText = ''; // only report empty when nothing rendered
    else if (!sawEmpty) out.emptyText = '';
    return out;
  }, HOST_ID);
}

test.describe('live - FMN-268 Duplicates tab', () => {
  test('live - real analyzer over live servers matches independent ground truth', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen; cannot fetch inventory.');
    test.skip(!(await apiKeyConfigured(sw)),
      'No FortiMonitor v2 API key seeded (panopta.apiKey); cannot fetch live servers.');

    const servers = await fetchLiveServers(sw);
    test.skip(!servers, 'Live server fetch returned null (no API key in SW).');
    test.skip(servers.length === 0, 'Tenant has zero servers; nothing to dedupe.');

    const gt = groundTruth(servers);
    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

    const res = await renderAndReadDuplicates(page, extensionId, { servers });
    expect(res.mountErr, `render threw: ${res.mountErr}`).toBeFalsy();

    // Row count equals total distinct members across all collision groups.
    expect(res.rows.length, 'rendered duplicate rows must equal ground-truth member total').toBe(gt.totalMembers);
    if (gt.totalMembers === 0) {
      expect(res.emptyText, 'empty state copy should render when no duplicates').toBeTruthy();
    } else {
      // Group sizes rendered (as a multiset) must match ground truth. Each
      // group contributes `size` rows each labelled with that group size.
      const renderedSizes = res.rows.map((r) => Number(r.groupSize)).sort((a, b) => b - a);
      const expectedSizes = gt.groupSizes.flatMap((sz) => Array.from({ length: sz }, () => sz)).sort((a, b) => b - a);
      expect(renderedSizes).toEqual(expectedSizes);
      for (const r of res.rows) expect(['Name', 'Address']).toContain(r.match);
    }
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    await page.close();
  });

  test('live - populated render path (injected name + address duplicates)', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const inventory = { servers: [
      { id: 901, name: 'dup-name', fqdn: '10.9.9.1' },
      { id: 902, name: 'DUP-NAME', fqdn: '10.9.9.2' },   // name collision (case-insensitive)
      { id: 903, name: 'alpha', fqdn: '10.9.9.9' },
      { id: 904, name: 'beta', fqdn: '10.9.9.9' },        // address collision
      { id: 905, name: 'unique', fqdn: '10.9.9.5' }       // no collision
    ] };
    const res = await renderAndReadDuplicates(page, extensionId, inventory);
    expect(res.mountErr, `render threw: ${res.mountErr}`).toBeFalsy();

    // 2 name-collision members + 2 address-collision members = 4 rows.
    expect(res.rows.length).toBe(4);
    const byMatch = res.rows.reduce((m, r) => { (m[r.match] ||= []).push(r); return m; }, {});
    expect(byMatch['Name']?.length).toBe(2);
    expect(byMatch['Address']?.length).toBe(2);
    expect(byMatch['Address'].every((r) => r.value === '10.9.9.9')).toBe(true);
    expect(res.rows.every((r) => r.groupSize === '2')).toBe(true);
    await page.close();
  });

  test('live - empty render path (injected inventory with no duplicates)', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;
    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen.');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const inventory = { servers: [
      { id: 1, name: 'one', fqdn: 'a' },
      { id: 2, name: 'two', fqdn: 'b' }
    ] };
    const res = await renderAndReadDuplicates(page, extensionId, inventory);
    expect(res.mountErr, `render threw: ${res.mountErr}`).toBeFalsy();
    expect(res.rows.length).toBe(0);
    expect(res.emptyText, 'empty-state copy must render').toBeTruthy();
    await page.close();
  });
});
