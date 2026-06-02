// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-263 LIVE spec: the Tenant Observations "Instance Breakdown" viewer tab,
// rendered against REAL tenant data over CDP.
//
// Why this drives the viewer directly instead of the full wizard: the
// Instance Breakdown tab reads only top-level inventory (servers / onsights /
// compound_services). A full ["all"] wizard run additionally does the
// minutes-long frontend walks (per-user + per-template session-auth crawls)
// that this feature does not touch. So we fetch the three inventory lists LIVE
// from the tenant (same /v2 wire contract the ObservationsFetcher uses), then
// render the ACTUAL viewer.js renderViewer() with that live blob and assert on
// the rendered DOM - the changed surface, against live FortiMonitor data. A
// scoped wizard run would NOT exercise this faithfully: topLevelKeysForSections
// fetches onsights/compound only for the ["all"] selection, so the headline
// total (servers + appliances + compound) would be wrong under any scope.
//
// BEHAVIOR MATRIX (per Verification Discipline - not one happy path):
//   (a) the headline "Total Monitored Instances" equals servers + OnSight
//       appliances + compound services, cross-checked against the counts we
//       fetched live;
//   (b) the per-resource-class sub-rows match each live count;
//   (c) two-level rendering: a device_type WITH device_sub_type children AND a
//       device_type WITHOUT children both render correctly. Ground truth is
//       recomputed independently from the live servers list, then compared to
//       the rendered rows (parents + indented children, as multisets). The
//       test skips with a clear message if the tenant lacks the dual shape.
//
// SKIP conditions (prerequisites unmet, not a failure):
//   - No extension service worker at the provisioned CDP port.
//   - No v2 API key seeded (panopta.apiKey) - can't fetch live inventory.
//   - FortiMonitor session at a login screen.
//   - Tenant has zero servers, or lacks both a with-children and a
//     without-children device_type (can't exercise the matrix).
//
// Run: npm run test:e2e:live   (or target this spec directly)
//   FMN_CDP_PORT=<port> npx playwright test --config tests/e2e/playwright.config.js \
//     tests/e2e/fmn-263-instance-breakdown-live.spec.js --grep "live -" --reporter=line

import { test as base, expect, chromium } from '@playwright/test';

const FM = 'https://fortimonitor.forticloud.com';
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const CDP_URL = `http://localhost:${CDP_PORT}`;
const HOST_ID = '__fmn263host';

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

// Fetch the three inventory lists LIVE from the tenant, inside the SW (which
// holds host_permissions for api2.panopta.com and the stored API key). Returns
// trimmed server records (only the type fields we need) plus appliance/compound
// counts - same wire contract as ObservationsFetcher's top-level pass.
async function fetchLiveInventory(sw) {
  return await sw.evaluate(async () => {
    const base = 'https://api2.panopta.com/v2';
    const d = await chrome.storage.local.get('panopta.apiKey');
    const key = d?.['panopta.apiKey'];
    if (!key) return null;
    const headers = { Authorization: `ApiKey ${key}` };
    async function pageAll(path, listKey) {
      let out = [];
      let offset = 0;
      for (let i = 0; i < 100; i++) {
        const r = await fetch(`${base}/${path}?limit=100&offset=${offset}`, { headers });
        if (!r.ok) break;
        const b = await r.json();
        const list = b[listKey] || [];
        out = out.concat(list);
        if (list.length < 100) break;
        offset += 100;
      }
      return out;
    }
    const servers = await pageAll('server', 'server_list');
    const onsights = await pageAll('onsight', 'onsight_list');
    const compound = await pageAll('compound_service', 'compound_service_list');
    return {
      servers: servers.map((s) => ({ device_type: s.device_type ?? null, device_sub_type: s.device_sub_type ?? null })),
      onsightCount: onsights.length,
      compoundCount: compound.length
    };
  });
}

// Independent ground truth (mirrors buildInstanceBreakdown's contract, computed
// from the live servers list - NOT imported from the builder, so a builder
// regression can't mask itself). Returns the expected parent totals and the
// expected child rows (named sub_types + an "(unspecified)" bucket only when a
// type has both named and null sub_types).
function groundTruth(servers) {
  const byType = new Map(); // dt -> { total, subs: Map<sub|null, count> }
  for (const s of servers) {
    const dt = s.device_type == null ? '(unspecified)' : String(s.device_type);
    const sub = s.device_sub_type == null || s.device_sub_type === '' ? null : String(s.device_sub_type);
    if (!byType.has(dt)) byType.set(dt, { total: 0, subs: new Map() });
    const e = byType.get(dt);
    e.total += 1;
    e.subs.set(sub, (e.subs.get(sub) || 0) + 1);
  }
  const parentTotals = [];
  const expectedChildren = []; // { label, count }
  let typesWithChildren = 0;
  let typesWithoutChildren = 0;
  for (const [, { total, subs }] of byType) {
    parentTotals.push(total);
    const named = [...subs.entries()].filter(([k]) => k !== null);
    if (named.length === 0) { typesWithoutChildren += 1; continue; }
    typesWithChildren += 1;
    for (const [sub, count] of named) expectedChildren.push({ label: sub, count });
    const nullCount = subs.get(null) || 0;
    if (nullCount > 0) expectedChildren.push({ label: '(unspecified)', count: nullCount });
  }
  return {
    distinctTypes: byType.size,
    parentTotals: parentTotals.sort((a, b) => b - a),
    expectedChildren,
    typesWithChildren,
    typesWithoutChildren
  };
}

function multiset(rows) {
  return rows.map((r) => `${r.label}::${r.count}`).sort();
}

test.describe('live - FMN-263 Instance Breakdown tab', () => {
  test('live - renders instance total + two-level type breakdown against live tenant data', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;

    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen; cannot fetch inventory.');
    test.skip(!(await apiKeyConfigured(sw)),
      'No FortiMonitor v2 API key seeded (panopta.apiKey); cannot fetch live inventory.');

    const inv = await fetchLiveInventory(sw);
    test.skip(!inv, 'Live inventory fetch returned null (no API key in SW).');
    test.skip(inv.servers.length === 0, 'Tenant has zero servers; nothing to break down.');

    const gt = groundTruth(inv.servers);
    test.skip(!(gt.typesWithChildren > 0 && gt.typesWithoutChildren > 0),
      `Tenant lacks the dual shape needed for the behavior matrix ` +
      `(types-with-children=${gt.typesWithChildren}, ` +
      `types-without-children=${gt.typesWithoutChildren}). Need at least one of each.`);

    const expectedTotal = inv.servers.length + inv.onsightCount + inv.compoundCount;
    const extensionId = sw.url().split('/')[2];

    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

    // Load the real extension page (origin needed for the module import + the
    // viewer's lazy chrome.* deps), then render the ACTUAL viewer.js into our
    // own host with the live-data blob and open the Instance Breakdown tab.
    await page.goto(`chrome-extension://${extensionId}/src/ui/tenant-observations/app.html`,
      { waitUntil: 'domcontentloaded' });

    const mountErr = await page.evaluate(async ({ hostId, inv }) => {
      try {
        const host = document.createElement('div');
        host.id = hostId;
        document.body.appendChild(host);
        const mod = await import('./viewer.js');
        const inventory = {
          servers: inv.servers,
          onsights: Array.from({ length: inv.onsightCount }, () => ({})),
          compound_services: Array.from({ length: inv.compoundCount }, () => ({}))
        };
        mod.renderViewer({
          root: host,
          store: { customerName: 'FMN-263 live', runResult: { inventory, analysis: {} } }
        });
        return null;
      } catch (e) {
        return String(e && e.stack || e);
      }
    }, { hostId: HOST_ID, inv });
    expect(mountErr, `renderViewer threw: ${mountErr}`).toBeNull();

    const tabBtn = page.locator(`#${HOST_ID} button[data-tab="instance-breakdown"]`);
    await expect(tabBtn, 'the Instance Breakdown tab button must render').toBeVisible({ timeout: 10_000 });
    await tabBtn.click();

    // Read both sections' rows straight off the rendered DOM. col0 keeps its
    // leading-space indentation (fmtCell does not trim), which is how we tell
    // parent rows from indented children.
    const sections = await page.evaluate((hostId) => {
      const host = document.getElementById(hostId);
      const out = {};
      host.querySelectorAll('.review-section').forEach((sec) => {
        const label = sec.querySelector('h3.subhead')?.textContent?.trim() || '(unlabeled)';
        out[label] = Array.from(sec.querySelectorAll('table.review-table tbody tr')).map((tr) => {
          const tds = tr.querySelectorAll('td');
          return { col0: tds[0]?.textContent ?? '', col1: (tds[1]?.textContent ?? '').trim() };
        });
      });
      return out;
    }, HOST_ID);

    // ---- (a) + (b) Instance Totals -----------------------------------------
    const totals = sections['Instance Totals'];
    expect(totals, 'Instance Totals section must render').toBeTruthy();
    const totalsMap = new Map(totals.map((r) => [r.col0.trim(), r.col1]));
    expect(totalsMap.get('Total Monitored Instances')).toBe(String(expectedTotal));
    expect(totalsMap.get('Servers / Devices')).toBe(String(inv.servers.length));
    expect(totalsMap.get('OnSight Appliances')).toBe(String(inv.onsightCount));
    expect(totalsMap.get('Compound Services')).toBe(String(inv.compoundCount));

    // ---- (c) Two-level Type Breakdown matrix -------------------------------
    const typeRows = sections['Type Breakdown'];
    expect(typeRows, 'Type Breakdown section must render').toBeTruthy();
    const parents = typeRows.filter((r) => !/^\s/.test(r.col0));
    const children = typeRows
      .filter((r) => /^\s/.test(r.col0))
      .map((r) => ({ label: r.col0.trim(), count: Number(r.col1) }));

    // Parent count matches the number of distinct device_types, and the parent
    // totals (sorted desc) match ground truth recomputed from the live list.
    expect(parents.length, 'one parent row per distinct device_type').toBe(gt.distinctTypes);
    expect(parents.map((p) => Number(p.col1)).sort((a, b) => b - a)).toEqual(gt.parentTotals);

    // The matrix: a device_type WITH children renders indented sub_type rows,
    // and at least one device_type WITHOUT children renders only a parent.
    expect(children.length, 'at least one device_type must render sub_type children').toBeGreaterThan(0);
    expect(parents.length, 'at least one device_type must render with no children')
      .toBeGreaterThan(gt.typesWithChildren);

    // Children (named sub_types + "(unspecified)" buckets) match ground truth
    // exactly, as a multiset of label::count.
    expect(multiset(children)).toEqual(multiset(gt.expectedChildren));

    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    await page.close();
  });
});
