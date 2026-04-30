// Unofficial FortiMonitor Toolkit - Find Servers E2E (FMN-116).
//
// Drives the unified Find Servers tool (FMN-114) against canned tenant
// data injected via page.addInitScript. Mirrors the four scenarios
// already covered by the synthetic harness at
// docs/harnesses/find-servers.html, but exercises the real extension
// page (real service worker, real chrome.runtime plumbing, real DOM).
//
// One Chromium launch per worker (workers:1, fixtures worker-scoped).

import { test, expect } from './fixtures.js';
import { findServersStubScript } from './stubs.js';

// ---- Helpers ------------------------------------------------------

async function openTool(extensionContext, findServersUrl) {
  const page = await extensionContext.newPage();
  // The stub MUST be installed before navigation so app.js sees the
  // patched chrome.runtime when its modules evaluate.
  await page.addInitScript(findServersStubScript);
  await page.goto(findServersUrl);
  // Sanity: the start page renders its h2 once the route mounts.
  await expect(page.locator('.step-header h2')).toContainText('Find servers');
  return page;
}

async function setIdentifiers(page, text) {
  const ta = page.locator('textarea.paste-area');
  await ta.fill(text);
}

async function setMatchMode(page, mode) {
  await page.locator('.mode-row select').selectOption(mode);
}

async function rowLocator(page, index) {
  return page.locator('.criterion-row').nth(index);
}

async function setFieldType(page, rowIndex, fieldType) {
  const row = await rowLocator(page, rowIndex);
  // The first <select> in the row is the field-type picker.
  await row.locator('select').first().selectOption(fieldType);
}

async function fillCriterion(page, rowIndex, opts) {
  const row = await rowLocator(page, rowIndex);
  const fieldType = opts.fieldType;
  await setFieldType(page, rowIndex, fieldType);

  if (fieldType === 'has_active_outage') {
    // The field-type select is select #0; the boolean picker is select #1.
    await row.locator('select').nth(1).selectOption(opts.value ? 'true' : 'false');
    return;
  }
  if (fieldType === 'status') {
    await row.locator('select').nth(1).selectOption(opts.value);
    return;
  }
  if (fieldType === 'applied_template') {
    // FMN-121: select #1 is the template picker (#0 is field-type),
    // select #2 is attached/not_attached. Wait for the template picker
    // to populate before selecting.
    const tplSelect = row.locator('select').nth(1);
    await expect(tplSelect).toBeEnabled({ timeout: 5_000 });
    await tplSelect.selectOption(opts.templateUrl);
    if (opts.match === 'not_attached') {
      await row.locator('select').nth(2).selectOption('not_attached');
    }
    return;
  }
  if (fieldType === 'attribute') {
    // Inside the .field-host, first text input is the combobox; second is the value.
    const inputs = row.locator('input[type="text"]');
    await inputs.nth(0).fill(opts.attributeName);
    await inputs.nth(1).fill(opts.value);
    if (opts.exactMatch === false) {
      await row.locator('input[type="checkbox"]').uncheck();
    } else {
      await row.locator('input[type="checkbox"]').check();
    }
    return;
  }
  // string fields: name / fqdn / tag / device_type
  // Only one text input in the field-host (the value).
  const valInput = row.locator('input[type="text"]').last();
  await valInput.fill(opts.value);
  if (opts.exactMatch === false) {
    await row.locator('input[type="checkbox"]').uncheck();
  } else if (opts.exactMatch === true) {
    await row.locator('input[type="checkbox"]').check();
  }
}

async function addCriterion(page) {
  await page.getByRole('button', { name: '+ Add criterion' }).click();
}

// Tick a column toggle by its index in the .cols-box order:
// 0=Status, 1=Tags, 2=Device type, 3=Device sub-type, 4=Source.
async function tickColumnByIndex(page, index) {
  await page.locator('.cols-box label input[type="checkbox"]').nth(index).check();
}

async function addAttributeColumn(page, attrName) {
  // The picker combobox + button live in attrColPickerHost. The
  // combobox renders as an input with class .combobox-input.
  // Fill it, then click the +Add attribute column button.
  await page.locator('.combobox-input').fill(attrName);
  await page.getByRole('button', { name: '+ Add attribute column' }).click();
}

async function runSearch(page) {
  await page.getByRole('button', { name: 'Run search' }).click();
  // The tool navigates to /results 400ms after a successful run.
  await expect(page).toHaveURL(/#\/results$/, { timeout: 5_000 });
  // Wait for the results table OR the empty-state message to render.
  await page.waitForSelector('.body-section table tbody tr, .body-section .parse-result.empty', {
    state: 'attached',
    timeout: 5_000
  });
}

async function getResultRows(page) {
  // Returns { columns, rows } - mirrors the harness's dump-results probe.
  // FMN-115 added a checkbox column at index 0 (.fmn-row-select-cell)
  // for the Send-to handoff. It carries no text and is not part of the
  // tool's data model, so we strip it before returning.
  const tbody = page.locator('.body-section table tbody');
  const tbodyVisible = await tbody.count();
  if (tbodyVisible === 0) {
    return { columns: [], rows: [] };
  }
  const columns = (await page.locator('.body-section table thead th').allTextContents()).slice(1);
  const rowLocators = await page.locator('.body-section table tbody tr').all();
  const rows = [];
  for (const r of rowLocators) {
    const cells = await r.locator('td').allTextContents();
    rows.push(cells.slice(1).map((c) => c.trim()));
  }
  return { columns, rows };
}

// ---- Scenarios ----------------------------------------------------

test.describe('Find Servers (FMN-114) E2E - stubbed tenant', () => {
  test('Scenario 1: criteria-only AND - Tag=production AND OS contains Windows', async ({ extensionContext, findServersUrl }) => {
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await fillCriterion(page, 0, { fieldType: 'tag', value: 'production', exactMatch: true });
      await addCriterion(page);
      await fillCriterion(page, 1, { fieldType: 'attribute', attributeName: 'Operating System', value: 'Windows', exactMatch: false });
      await setMatchMode(page, 'all');
      await tickColumnByIndex(page, 0); // Status
      await tickColumnByIndex(page, 1); // Tags
      await runSearch(page);

      const { columns, rows } = await getResultRows(page);
      expect(columns).toEqual(['#', 'Server ID', 'Name', 'FQDN', 'Status', 'Tags']);
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r[1]).sort()).toEqual(['1001', '1002']);
      // edge-win-01 has tags [production, edge]; edge-win-02 has just [production].
      const win01 = rows.find((r) => r[1] === '1001');
      expect(win01[5]).toBe('production|edge');
    } finally {
      await page.close();
    }
  });

  test('Scenario 2: criteria-only OR - Tag=production OR has_active_outage', async ({ extensionContext, findServersUrl }) => {
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await fillCriterion(page, 0, { fieldType: 'tag', value: 'production', exactMatch: true });
      await addCriterion(page);
      await fillCriterion(page, 1, { fieldType: 'has_active_outage', value: true });
      await setMatchMode(page, 'any');
      await tickColumnByIndex(page, 1); // Tags
      await tickColumnByIndex(page, 4); // Source (will be empty here, but tests the column)
      await runSearch(page);

      const { columns, rows } = await getResultRows(page);
      expect(columns).toEqual(['#', 'Server ID', 'Name', 'FQDN', 'Tags', 'Source']);
      // 1001, 1002, 1004 have production tag; 1003 has active outage.
      expect(rows.length).toBe(4);
      expect(rows.map((r) => r[1]).sort()).toEqual(['1001', '1002', '1003', '1004']);
      // Source column for criteria-only searches is "-" everywhere.
      for (const row of rows) {
        expect(row[5]).toBe('-');
      }
    } finally {
      await page.close();
    }
  });

  test('Scenario 3: identifiers-only - 1001 + 1002 - no /server pagination', async ({ extensionContext, findServersUrl }) => {
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await setIdentifiers(page, '1001\n1002');
      // Remove the default empty criterion row so the filter is truly empty.
      // The remove button is hidden when there is only one row, but
      // leaving the row blank (default state) is fine: blank rows are
      // silently dropped at submit time. So we just leave it.
      await runSearch(page);

      const { columns, rows } = await getResultRows(page);
      expect(columns).toEqual(['#', 'Server ID', 'Name', 'FQDN']);
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r[1]).sort()).toEqual(['1001', '1002']);
    } finally {
      await page.close();
    }
  });

  test('Scenario 5: applied_template = Critical Infra (FMN-121)', async ({ extensionContext, findServersUrl }) => {
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await fillCriterion(page, 0, {
        fieldType: 'applied_template',
        templateUrl: '/server_template/501',
        match: 'attached'
      });
      await runSearch(page);

      const { columns, rows } = await getResultRows(page);
      // The matched-template column auto-shows when an applied_template
      // criterion is active (matched mode = attached).
      expect(columns).toEqual(['#', 'Server ID', 'Name', 'FQDN', 'Template: Critical Infra']);
      // Critical Infra applies to 1001 + 1004 per the stub.
      expect(rows.map((r) => r[1]).sort()).toEqual(['1001', '1004']);
      // Each row's template column shows the matched name.
      for (const r of rows) {
        expect(r[4]).toBe('Critical Infra');
      }
    } finally {
      await page.close();
    }
  });

  test('Scenario 6: applied_template AND tag intersection (FMN-121)', async ({ extensionContext, findServersUrl }) => {
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await fillCriterion(page, 0, { fieldType: 'tag', value: 'production', exactMatch: true });
      await addCriterion(page);
      await fillCriterion(page, 1, {
        fieldType: 'applied_template',
        templateUrl: '/server_template/501',
        match: 'attached'
      });
      await setMatchMode(page, 'all');
      await runSearch(page);

      const { rows } = await getResultRows(page);
      // production tag servers: 1001, 1002, 1004. Critical Infra: 1001, 1004.
      // Intersection: 1001, 1004.
      expect(rows.map((r) => r[1]).sort()).toEqual(['1001', '1004']);
    } finally {
      await page.close();
    }
  });

  test('Scenario 7: applied_template = NOT attached returns the inverse set (FMN-121)', async ({ extensionContext, findServersUrl }) => {
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await fillCriterion(page, 0, {
        fieldType: 'applied_template',
        templateUrl: '/server_template/501',
        match: 'not_attached'
      });
      await runSearch(page);

      const { columns, rows } = await getResultRows(page);
      // not_attached match: the auto template column should NOT appear
      // (it's only meaningful for attached matches).
      expect(columns).toEqual(['#', 'Server ID', 'Name', 'FQDN']);
      // Critical Infra is attached to 1001 + 1004; the rest (1002, 1003) match.
      expect(rows.map((r) => r[1]).sort()).toEqual(['1002', '1003']);
    } finally {
      await page.close();
    }
  });

  test('Scenario 4: identifiers + filter intersection', async ({ extensionContext, findServersUrl }) => {
    const page = await openTool(extensionContext, findServersUrl);
    try {
      await setIdentifiers(page, '1001\n1002\n1003');
      await fillCriterion(page, 0, { fieldType: 'tag', value: 'production', exactMatch: true });
      await setMatchMode(page, 'all');
      // Add an attribute column for "Operating System" to verify the
      // per-attribute output column works. 1001 has Windows Server 2022,
      // 1002 has Windows Server 2019. 1003 (excluded by the tag filter)
      // does not appear.
      await addAttributeColumn(page, 'Operating System');
      await runSearch(page);

      const { columns, rows } = await getResultRows(page);
      expect(columns).toEqual(['#', 'Server ID', 'Name', 'FQDN', 'Operating System']);
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r[1]).sort()).toEqual(['1001', '1002']);
      const win01 = rows.find((r) => r[1] === '1001');
      const win02 = rows.find((r) => r[1] === '1002');
      expect(win01[4]).toBe('Windows Server 2022');
      expect(win02[4]).toBe('Windows Server 2019');
    } finally {
      await page.close();
    }
  });
});
