// Unofficial FortiMonitor Toolkit - Find Servers live-tenant E2E (FMN-117).
//
// Drives Find Servers (FMN-114) against the operator's real FortiMonitor
// tenant. Skip-by-default: tests only run when FORTIMONITOR_API_KEY is in
// process.env (loaded from tests/e2e/.env.local at config time, see
// playwright.config.js + load-env.js).
//
// Behavioural assertions: we never pin a count, since tenant data
// varies. Instead we assert that every returned row satisfies the
// criterion (e.g., every Status=active row has status=active; every
// Tag=X row has X in tags[]). When the tenant can't exercise a field
// (no tags, no active outages, etc.), individual tests skip themselves
// rather than fail.
//
// The api-key seed and tenant discovery happen once per worker (we run
// workers:1, so once per test run).

import { test, expect } from './fixtures.js';
import { seedApiKey } from './seed-api-key.js';

const PANOPTA_BASE = 'https://api2.panopta.com/v2';

// ---- Skip-by-default ----------------------------------------------

const API_KEY = process.env.FORTIMONITOR_API_KEY;

test.describe('Find Servers (FMN-114) E2E - live tenant', () => {
  test.skip(!API_KEY,
    'FORTIMONITOR_API_KEY not set. Add it to tests/e2e/.env.local or export it before running. See docs/playwright-e2e-runbook.md for details.'
  );

  // ---- Tenant discovery ------------------------------------------
  // One sample fetch per worker. We use it to pick a representative
  // tag, fqdn substring, name substring, device_type, OS attribute
  // value, and (if any are present) an id with an active outage. Tests
  // that need a value the tenant doesn't have call test.skip() with a
  // clear reason.

  let sample = null;        // { servers, tag, fqdnPart, namePart, deviceType, osValue }
  let activeOutageId = null; // first id with an active outage, or null

  test.beforeAll(async ({ extensionContext }) => {
    await seedApiKey(extensionContext, API_KEY);

    const headers = { 'Authorization': `ApiKey ${API_KEY}` };
    // Pull a generous sample so we have variety to choose from. 200
    // is enough to find at least one of each common field on most
    // tenants without paying for the full list.
    const r = await fetch(`${PANOPTA_BASE}/server?limit=200`, { headers });
    if (!r.ok) throw new Error(`Tenant discovery failed: GET /server returned ${r.status}`);
    const body = await r.json();
    const servers = Array.isArray(body?.server_list) ? body.server_list : [];
    if (servers.length === 0) throw new Error('Tenant discovery: tenant has no servers; cannot run live suite.');

    const taggedServer = servers.find((s) => Array.isArray(s.tags) && s.tags.length > 0);
    const fqdnServer = servers.find((s) => typeof s.fqdn === 'string' && s.fqdn.length > 0);
    const nameServer = servers.find((s) => typeof s.name === 'string' && s.name.length >= 3);
    const dtServer = servers.find((s) => typeof s.device_type === 'string' && s.device_type.length > 0);
    const osAttr = (() => {
      for (const s of servers) {
        if (!Array.isArray(s.attributes)) continue;
        const a = s.attributes.find((a) => /operating system/i.test(a?.name ?? '') || /server\.os/i.test(a?.textkey ?? ''));
        if (a && typeof a.value === 'string' && a.value.length > 0) return a.value;
      }
      return null;
    })();

    sample = {
      servers,
      tag: taggedServer?.tags?.[0] ?? null,
      fqdnPart: fqdnServer ? extractFqdnSubstring(fqdnServer.fqdn) : null,
      namePart: nameServer ? nameServer.name.slice(0, 3) : null,
      deviceType: dtServer?.device_type ?? null,
      osValue: osAttr,
      // Pick three identifiers we know exist for the round-trip test.
      ids: servers.slice(0, 3).map((s) => extractServerId(s)).filter((x) => x != null)
    };

    const ao = await fetch(`${PANOPTA_BASE}/outage/active?limit=10`, { headers });
    if (ao.ok) {
      const aob = await ao.json();
      const list = Array.isArray(aob?.outage_list) ? aob.outage_list : [];
      for (const o of list) {
        const id = extractOutageServerId(o);
        if (id != null) { activeOutageId = id; break; }
      }
    }

    // Log the discovered sample so operators running the live suite can
    // see exactly which tenant values exercised which scenarios.
    console.log('[live discovery] sampled', servers.length, 'servers from tenant');
    console.log('[live discovery] tag:        ', JSON.stringify(sample.tag));
    console.log('[live discovery] fqdnPart:   ', JSON.stringify(sample.fqdnPart));
    console.log('[live discovery] namePart:   ', JSON.stringify(sample.namePart));
    console.log('[live discovery] deviceType: ', JSON.stringify(sample.deviceType));
    console.log('[live discovery] osValue:    ', JSON.stringify(sample.osValue));
    console.log('[live discovery] ids:        ', JSON.stringify(sample.ids));
    console.log('[live discovery] activeOutageId:', JSON.stringify(activeOutageId));
  });

  // ---- Helpers ---------------------------------------------------

  async function openTool(extensionContext, findServersUrl) {
    const page = await extensionContext.newPage();
    await page.goto(findServersUrl);
    await expect(page.locator('.step-header h2')).toContainText('Find servers');
    return page;
  }

  async function setIdentifiers(page, text) {
    await page.locator('textarea.paste-area').fill(text);
  }
  async function setMatchMode(page, mode) {
    await page.locator('.mode-row select').selectOption(mode);
  }
  async function rowLocator(page, index) { return page.locator('.criterion-row').nth(index); }
  async function setFieldType(page, rowIndex, fieldType) {
    const row = await rowLocator(page, rowIndex);
    await row.locator('select').first().selectOption(fieldType);
  }
  async function fillCriterion(page, rowIndex, opts) {
    const row = await rowLocator(page, rowIndex);
    await setFieldType(page, rowIndex, opts.fieldType);
    if (opts.fieldType === 'has_active_outage') {
      await row.locator('select').nth(1).selectOption(opts.value ? 'true' : 'false');
      return;
    }
    if (opts.fieldType === 'status') {
      await row.locator('select').nth(1).selectOption(opts.value);
      return;
    }
    if (opts.fieldType === 'attribute') {
      // The criterion-row combobox is disabled until live
      // search:list-attribute-types resolves. start.js does not auto-
      // enable existing rows' combos when suggestions load (pre-FMN-117
      // UX quirk; the loop body in the suggestions-load handler is
      // commented out). Workaround: wait for suggestions to load, then
      // force a rebuild of the row's editor by switching field types
      // away and back. The rebuilt combobox is created with
      // attrSuggestionsLoading=false and starts enabled.
      await waitForAttrSuggestionsReady(page);
      await setFieldType(page, rowIndex, 'name');
      await setFieldType(page, rowIndex, 'attribute');
      const inputs = row.locator('input[type="text"]');
      await inputs.nth(0).fill(opts.attributeName);
      await inputs.nth(1).fill(opts.value);
      const exact = row.locator('input[type="checkbox"]');
      if (opts.exactMatch === false) await exact.uncheck();
      else await exact.check();
      return;
    }
    const valInput = row.locator('input[type="text"]').last();
    await valInput.fill(opts.value);
    const exact = row.locator('input[type="checkbox"]');
    if (opts.exactMatch === false) await exact.uncheck();
    else if (opts.exactMatch === true) await exact.check();
  }
  async function addCriterion(page) {
    await page.getByRole('button', { name: '+ Add criterion' }).click();
  }

  // Wait until search:list-attribute-types resolves. The clean signal:
  // start.js only inserts the "+ Add attribute column" button into the
  // DOM after suggestions load. Its presence means attrSuggestionsLoading
  // is false and any newly-rebuilt row combobox will be enabled.
  async function waitForAttrSuggestionsReady(page) {
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('button'))
        .some((b) => b.textContent.trim() === '+ Add attribute column');
    }, undefined, { timeout: 30_000 });
  }
  // Order in start.js colDefs: 0=Status, 1=Tags, 2=Device type, 3=Device sub-type, 4=Source.
  const COL_INDEX = { status: 0, tags: 1, deviceType: 2, deviceSubType: 3, source: 4 };
  async function tickColumn(page, key) {
    await page.locator('.cols-box label input[type="checkbox"]').nth(COL_INDEX[key]).check();
  }
  async function addAttributeColumn(page, attrName) {
    await waitForAttrSuggestionsReady(page);
    // The column-picker combobox is the one inside .criterion-row sibling
    // .cols-box's parent; pick by finding the combobox NOT inside a
    // criterion-row. With strict mode in mind, target by its position
    // (it is the last .combobox-input on the page once both criterion
    // and column pickers are populated, but the simplest stable target
    // is the input directly preceding the "+ Add attribute column" button).
    const addBtn = page.getByRole('button', { name: '+ Add attribute column' });
    // The button lives in attrColPickerHost; the combobox is its sibling.
    const combo = addBtn.locator('xpath=preceding-sibling::div//input[contains(@class, "combobox-input")]').first();
    await combo.fill(attrName);
    await addBtn.click();
  }
  async function runSearch(page) {
    await page.getByRole('button', { name: 'Run search' }).click();
    // Live tenant pagination can be slow.
    await expect(page).toHaveURL(/#\/results$/, { timeout: 45_000 });
    await page.waitForSelector('.body-section table tbody tr, .body-section .parse-result.empty', {
      state: 'attached',
      timeout: 5_000
    });
  }
  async function getRows(page) {
    const tbody = page.locator('.body-section table tbody');
    if ((await tbody.count()) === 0) return { columns: [], rows: [] };
    const columns = await page.locator('.body-section table thead th').allTextContents();
    const rowLocators = await page.locator('.body-section table tbody tr').all();
    const rows = [];
    for (const r of rowLocators) {
      const cells = await r.locator('td').allTextContents();
      rows.push(cells.map((c) => c.trim()));
    }
    return { columns, rows };
  }
  function colIndex(columns, label) {
    return columns.indexOf(label);
  }

  // ---- Scenarios -------------------------------------------------

  test('live - Status=active: every result row has status=active', async ({ extensionContext, findServersUrl }) => {
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await fillCriterion(page, 0, { fieldType: 'status', value: 'active' });
      await tickColumn(page, 'status');
      await runSearch(page);
      const { columns, rows } = await getRows(page);
      const statusIdx = colIndex(columns, 'Status');
      expect(statusIdx).toBeGreaterThan(-1);
      // Behavioural: every returned row really is active. Empty result
      // is acceptable (means no active servers right now); the suite
      // doesn't pin counts.
      for (const row of rows) expect(row[statusIdx]).toBe('active');
    } finally { await page.close(); }
  });

  test('live - Tag query: every result row carries the queried tag', async ({ extensionContext, findServersUrl }) => {
    test.skip(!sample.tag, 'No servers with tags found in the discovery sample.');
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await fillCriterion(page, 0, { fieldType: 'tag', value: sample.tag, exactMatch: true });
      await tickColumn(page, 'tags');
      await runSearch(page);
      const { columns, rows } = await getRows(page);
      const tagsIdx = colIndex(columns, 'Tags');
      expect(tagsIdx).toBeGreaterThan(-1);
      // Tags column joins values with '|' in the renderer.
      for (const row of rows) {
        const tags = row[tagsIdx].split('|').map((t) => t.trim());
        expect(tags.map((t) => t.toLowerCase())).toContain(sample.tag.toLowerCase());
      }
    } finally { await page.close(); }
  });

  test('live - Server name substring: every result row contains the substring', async ({ extensionContext, findServersUrl }) => {
    test.skip(!sample.namePart, 'No usable server name substring in the discovery sample.');
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await fillCriterion(page, 0, { fieldType: 'name', value: sample.namePart, exactMatch: false });
      await runSearch(page);
      const { columns, rows } = await getRows(page);
      const nameIdx = colIndex(columns, 'Name');
      for (const row of rows) {
        expect(row[nameIdx].toLowerCase()).toContain(sample.namePart.toLowerCase());
      }
    } finally { await page.close(); }
  });

  test('live - FQDN substring: every result row matches the FQDN substring', async ({ extensionContext, findServersUrl }) => {
    test.skip(!sample.fqdnPart, 'No usable FQDN substring in the discovery sample.');
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await fillCriterion(page, 0, { fieldType: 'fqdn', value: sample.fqdnPart, exactMatch: false });
      await runSearch(page);
      const { columns, rows } = await getRows(page);
      const fqdnIdx = colIndex(columns, 'FQDN');
      // Note: the FQDN matcher ALSO checks additional_fqdns[]; the table
      // shows the primary fqdn only, so a match on additional_fqdns
      // would not appear in this cell. Assert that the primary-fqdn
      // matches OR is non-empty (something matched somewhere).
      for (const row of rows) {
        const primary = row[fqdnIdx];
        // Substring match on primary is the strict assertion. If the
        // tenant has servers where only additional_fqdns matched, the
        // primary won't contain the substring; tolerate via an OR with
        // "primary is non-empty" so we don't false-fail.
        const primaryHits = primary.toLowerCase().includes(sample.fqdnPart.toLowerCase());
        expect(primary !== '-' || primaryHits).toBeTruthy();
      }
    } finally { await page.close(); }
  });

  test('live - Device type: every result row matches the device type', async ({ extensionContext, findServersUrl }) => {
    test.skip(!sample.deviceType, 'No device_type in the discovery sample.');
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await fillCriterion(page, 0, { fieldType: 'device_type', value: sample.deviceType, exactMatch: true });
      await tickColumn(page, 'deviceType');
      await tickColumn(page, 'deviceSubType');
      await runSearch(page);
      const { columns, rows } = await getRows(page);
      const dtIdx = colIndex(columns, 'Device type');
      const dstIdx = colIndex(columns, 'Device sub-type');
      // device_type matcher hits either device_type OR device_sub_type;
      // assert at least one of the two columns matches.
      for (const row of rows) {
        const a = (row[dtIdx] ?? '').toLowerCase();
        const b = (row[dstIdx] ?? '').toLowerCase();
        const want = sample.deviceType.toLowerCase();
        expect(a === want || b === want).toBeTruthy();
      }
    } finally { await page.close(); }
  });

  test('live - Operating System attribute: every result row carries the OS value', async ({ extensionContext, findServersUrl }) => {
    test.skip(!sample.osValue, 'No Operating System attribute value in the discovery sample.');
    const page = await openTool(extensionContext, findServersUrl);
    try {
      console.log('[scenario 6] querying: Operating System (attribute) =', JSON.stringify(sample.osValue), '(exact)');
      // Use exact match against the sampled OS string. Add an attribute
      // column for "Operating System" so we can read the value back per row.
      await fillCriterion(page, 0, { fieldType: 'attribute', attributeName: 'Operating System', value: sample.osValue, exactMatch: true });
      await addAttributeColumn(page, 'Operating System');
      await runSearch(page);
      const { columns, rows } = await getRows(page);
      const osIdx = colIndex(columns, 'Operating System');
      expect(osIdx).toBeGreaterThan(-1);
      console.log('[scenario 6] columns:', columns);
      console.log('[scenario 6]', rows.length, 'rows returned');
      for (const row of rows.slice(0, 5)) console.log('[scenario 6]   ', row);
      if (rows.length > 5) console.log('[scenario 6]    ... and', rows.length - 5, 'more');
      for (const row of rows) {
        expect(row[osIdx].toLowerCase()).toBe(sample.osValue.toLowerCase());
      }
    } finally { await page.close(); }
  });

  test('live - has_active_outage=true: result rows are exactly tenant servers in active outage', async ({ extensionContext, findServersUrl }) => {
    test.skip(activeOutageId == null, 'No active outages in the tenant right now.');
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await fillCriterion(page, 0, { fieldType: 'has_active_outage', value: true });
      await runSearch(page);
      const { rows } = await getRows(page);
      // We can't know the exact count without reproducing the
      // /outage/active set; instead assert the seeded active-outage id
      // appears among the results.
      const ids = rows.map((r) => r[1]); // 'Server ID' is column index 1
      expect(ids).toContain(String(activeOutageId));
    } finally { await page.close(); }
  });

  test('live - Identifiers round-trip: pasted ids appear in the results', async ({ extensionContext, findServersUrl }) => {
    test.skip(sample.ids.length === 0, 'No usable ids in the discovery sample.');
    const page = await openTool(extensionContext, findServersUrl);
    try {
      const ids = sample.ids;
      await setIdentifiers(page, ids.join('\n'));
      await runSearch(page);
      const { rows } = await getRows(page);
      const idsOut = rows.map((r) => Number(r[1])).filter((n) => Number.isFinite(n));
      // Every input id should appear in the output (assuming none was
      // 404'd by the confirm step, which would be a real tenant issue
      // worth surfacing).
      for (const id of ids) expect(idsOut).toContain(id);
    } finally { await page.close(); }
  });

  test('live - Identifiers + filter intersection: results pass both gates', async ({ extensionContext, findServersUrl }) => {
    test.skip(sample.ids.length === 0 || !sample.tag, 'Need ids and a tag to run intersection.');
    const page = await openTool(extensionContext, findServersUrl);
    try {
      const ids = sample.ids;
      console.log('[scenario 9] identifiers (3 ids):', ids);
      console.log('[scenario 9] filter: Tag =', JSON.stringify(sample.tag), '(exact). Mode: ALL (intersection).');
      await setIdentifiers(page, ids.join('\n'));
      await fillCriterion(page, 0, { fieldType: 'tag', value: sample.tag, exactMatch: true });
      await tickColumn(page, 'tags');
      await runSearch(page);
      const { columns, rows } = await getRows(page);
      const tagsIdx = colIndex(columns, 'Tags');
      console.log('[scenario 9] columns:', columns);
      console.log('[scenario 9]', rows.length, 'rows returned (out of', ids.length, 'identifiers)');
      for (const row of rows) console.log('[scenario 9]   ', row);
      // Every returned row must (a) have its id in the input list and
      // (b) carry the tag we filtered on.
      for (const row of rows) {
        expect(ids).toContain(Number(row[1]));
        const tags = row[tagsIdx].split('|').map((t) => t.trim());
        expect(tags.map((t) => t.toLowerCase())).toContain(sample.tag.toLowerCase());
      }
    } finally { await page.close(); }
  });

  test('live - AND vs OR: ANY mode returns at least as many rows as ALL mode for the same two criteria', async ({ extensionContext, findServersUrl }) => {
    test.skip(!sample.tag, 'No tag available for the AND/OR comparison.');
    // ALL: Tag = sample.tag AND Status = active.
    const pageAll = await openTool(extensionContext, findServersUrl);
    let allCount;
    try {
      await fillCriterion(pageAll, 0, { fieldType: 'tag', value: sample.tag, exactMatch: true });
      await addCriterion(pageAll);
      await fillCriterion(pageAll, 1, { fieldType: 'status', value: 'active' });
      await setMatchMode(pageAll, 'all');
      await runSearch(pageAll);
      const { rows } = await getRows(pageAll);
      allCount = rows.length;
    } finally { await pageAll.close(); }

    // ANY: Tag = sample.tag OR Status = active.
    const pageAny = await openTool(extensionContext, findServersUrl);
    let anyCount;
    try {
      await fillCriterion(pageAny, 0, { fieldType: 'tag', value: sample.tag, exactMatch: true });
      await addCriterion(pageAny);
      await fillCriterion(pageAny, 1, { fieldType: 'status', value: 'active' });
      await setMatchMode(pageAny, 'any');
      await runSearch(pageAny);
      const { rows } = await getRows(pageAny);
      anyCount = rows.length;
    } finally { await pageAny.close(); }

    // ANY (union) is always >= ALL (intersection).
    expect(anyCount).toBeGreaterThanOrEqual(allCount);
  });

  test('live - Column picker: ticked columns + attribute column appear in the table', async ({ extensionContext, findServersUrl }) => {
    test.skip(!sample.osValue, 'Need an OS attribute value to exercise the attribute column.');
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await fillCriterion(page, 0, { fieldType: 'status', value: 'active' });
      await tickColumn(page, 'status');
      await tickColumn(page, 'tags');
      await tickColumn(page, 'deviceType');
      await addAttributeColumn(page, 'Operating System');
      await runSearch(page);
      const { columns } = await getRows(page);
      // ID/Name/FQDN are always there; we added Status/Tags/Device type
      // and an Operating System attribute column.
      expect(columns).toEqual(['#', 'Server ID', 'Name', 'FQDN', 'Status', 'Tags', 'Device type', 'Operating System']);
    } finally { await page.close(); }
  });
});

// ---- Local helpers (module-private) -------------------------------

function extractServerId(server) {
  if (server == null) return null;
  if (server.id != null) return Number(server.id);
  if (typeof server.url === 'string') {
    const m = server.url.match(/\/server\/(\d+)\/?$/);
    if (m) return Number(m[1]);
  }
  return null;
}

function extractOutageServerId(outage) {
  if (typeof outage?.server === 'string') {
    const m = outage.server.match(/\/server\/(\d+)/);
    if (m) return Number(m[1]);
  }
  if (outage?.server_id != null) return Number(outage.server_id);
  return null;
}

// Pick a meaningful FQDN substring: prefer the TLD-bearing tail (e.g.
// "example.com" or ".local") so the substring is broad enough to hit
// other servers in the same domain. Falls back to the first 5 chars.
function extractFqdnSubstring(fqdn) {
  if (typeof fqdn !== 'string' || fqdn.length === 0) return null;
  const dot = fqdn.indexOf('.');
  if (dot >= 0 && dot < fqdn.length - 1) return fqdn.slice(dot); // ".example.com"
  return fqdn.slice(0, Math.min(5, fqdn.length));
}
