import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTabs, buildTabCsv, csvEscape, tabFilename, buildCombinedZipEntries, combinedZipFilename } from '../src/ui/bpa-audit/viewer.js';

// =============================================================================
// Tab definitions sanity
// =============================================================================

test('getTabs: returns the 11 tabs FMN-133 spec calls for, in order', () => {
  const tabs = getTabs();
  assert.equal(tabs.length, 11);
  const ids = tabs.map((t) => t.id);
  assert.deepEqual(ids, [
    'executive-summary',
    'feature-utilization',
    'incident-summary',
    'incidents',
    'user-activity',
    'instance-analysis',
    'template-recommendations',
    'monitoring-policy',
    'recommendations',
    'recommended-labs',
    'raw-counts'
  ]);
  // Each has at least one section, every section has columns + rows.
  for (const tab of tabs) {
    assert.ok(Array.isArray(tab.sections) && tab.sections.length > 0, `${tab.id} should have sections`);
    for (const s of tab.sections) {
      assert.ok(Array.isArray(s.columns) && s.columns.length > 0, `${tab.id}.${s.label} should have columns`);
      assert.equal(typeof s.rows, 'function', `${tab.id}.${s.label} should have rows()`);
    }
  }
});

test('User Activity tab has annotation columns wired to the expected store keys', () => {
  const ua = getTabs().find((t) => t.id === 'user-activity');
  const cols = ua.sections[0].columns;
  const lastLogin = cols.find((c) => c.key === 'last_login');
  const assess = cols.find((c) => c.key === 'active_assessment');
  assert.ok(lastLogin?.annotation);
  assert.equal(lastLogin.annotation.storeKey, 'user_last_login');
  assert.equal(typeof lastLogin.annotation.rowKey, 'function');
  assert.ok(assess?.annotation);
  assert.equal(assess.annotation.storeKey, 'user_active_assessment');
});

// =============================================================================
// CSV helpers
// =============================================================================

test('csvEscape: doubles quotes, wraps everything in double-quotes, handles null', () => {
  assert.equal(csvEscape(null), '""');
  assert.equal(csvEscape('plain'), '"plain"');
  assert.equal(csvEscape('with "quote"'), '"with ""quote"""');
});

test('tabFilename: pattern is {customer}_{tab}_{YYYYMMDD}.csv (slugified customer)', () => {
  const tab = getTabs().find((t) => t.id === 'incidents');
  const fname = tabFilename(tab, 'Acme Corp');
  assert.match(fname, /^acme-corp_incidents_\d{8}\.csv$/);
});

test('tabFilename: blank customer falls back to "best-practice-assessment" prefix', () => {
  const tab = getTabs().find((t) => t.id === 'incidents');
  assert.match(tabFilename(tab, ''), /^best-practice-assessment_incidents_\d{8}\.csv$/);
});

// =============================================================================
// buildTabCsv end-to-end
// =============================================================================

test('buildTabCsv: Raw Counts tab emits a section header + table', () => {
  const tab = getTabs().find((t) => t.id === 'raw-counts');
  const ctx = {
    inventory: { servers: [{ status: 'active' }], fabric_connections: [{}] },
    analysis: {},
    customer: 'Acme',
    annotations: {}
  };
  const csv = buildTabCsv(tab, ctx, { generatedAt: '2026-05-01T00:00:00Z', customer: 'Acme' });
  assert.match(csv, /^# Unofficial FortiMonitor Toolkit - Best-Practice Assessment/);
  assert.match(csv, /# Customer: Acme/);
  assert.match(csv, /# Tab: Raw Counts/);
  assert.match(csv, /# Resource Counts/);
  assert.match(csv, /^"Resource","Count"$/m);
  assert.match(csv, /^"Servers \(Direct\)","1"$/m);
  assert.match(csv, /^"Fabric Connections","1"$/m);
});

test('buildTabCsv: User Activity includes annotation columns from ctx.annotations', () => {
  const tab = getTabs().find((t) => t.id === 'user-activity');
  const ctx = {
    inventory: {},
    analysis: {
      users: {
        total: 1,
        details: [{ id: 7, name: 'Alice', email: 'a@x', created: '2024-01-01', contact_methods: 1 }],
        primary_user: null,
        issues: []
      }
    },
    customer: '',
    annotations: {
      user_last_login: { '7': '2026-04-15' },
      user_active_assessment: { '7': 'active' }
    }
  };
  const csv = buildTabCsv(tab, ctx);
  // Header includes the annotation columns
  assert.match(csv, /Last Login \(manual\)/);
  assert.match(csv, /Active Assessment \(manual\)/);
  // Annotation values land in the row
  assert.match(csv, /"Alice","a@x","2024-01-01","1","2026-04-15","active"/);
});

test('buildTabCsv: empty sections without alwaysIncludeHeader are skipped from the output', () => {
  const tab = getTabs().find((t) => t.id === 'incidents');
  const csv = buildTabCsv(tab, {
    inventory: {},
    analysis: { incidents: { active_details: [] } },
    customer: '',
    annotations: {}
  });
  // Should still have the header preamble but no Active Incidents body rows.
  assert.match(csv, /# Tab: Incidents/);
  // The CSV column header should NOT appear when the section has no rows.
  assert.equal(csv.includes('"Server","Incident ID"'), false);
});

// =============================================================================
// Combined ZIP download (FMN-133 operator feedback)
// =============================================================================

test('combinedZipFilename: pattern is {customer}_best-practice-assessment_{YYYYMMDD}.zip', () => {
  assert.match(combinedZipFilename('Acme Corp'), /^acme-corp_best-practice-assessment_\d{8}\.zip$/);
});

test('combinedZipFilename: blank customer falls back to generic prefix', () => {
  assert.match(combinedZipFilename(''), /^best-practice-assessment_best-practice-assessment_\d{8}\.zip$/);
});

test('buildCombinedZipEntries: emits one CSV per tab + a README, all 12 entries', () => {
  const ctx = {
    inventory: { servers: [{ id: 1, status: 'active' }] },
    analysis: { incidents: { active_details: [], top_by_instance: [], top_by_type: [], noisy_metrics: [], trending: {} }, users: { details: [] } },
    customer: 'Acme',
    annotations: {}
  };
  const entries = buildCombinedZipEntries(ctx, { generatedAt: '2026-05-01T00:00:00Z', customer: 'Acme' });
  assert.equal(entries.length, getTabs().length + 1, 'expected 11 tabs + 1 README');
  // README is first
  assert.equal(entries[0].filename, 'README.txt');
  assert.match(entries[0].content, /Best-Practice Assessment/);
  assert.match(entries[0].content, /Customer: Acme/);
  // Every tab is represented by exactly one CSV
  const csvNames = entries.slice(1).map((e) => e.filename);
  for (const tab of getTabs()) {
    assert.ok(csvNames.includes(`${tab.filenamePart}.csv`), `expected ${tab.filenamePart}.csv in zip`);
  }
});

test('buildCombinedZipEntries: README lists every tab with its label', () => {
  const entries = buildCombinedZipEntries({ inventory: {}, analysis: {}, customer: '', annotations: {} });
  const readme = entries[0].content;
  for (const tab of getTabs()) {
    assert.match(readme, new RegExp(`${tab.filenamePart}\\.csv\\s+-\\s+${tab.label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`));
  }
});

test('buildTabCsv: Recommendations tab serializes priority + text rows', () => {
  const tab = getTabs().find((t) => t.id === 'recommendations');
  const csv = buildTabCsv(tab, {
    inventory: { contact_groups: [], compound_services: [] },
    analysis: {},
    customer: 'Acme',
    annotations: {}
  });
  assert.match(csv, /"Priority","Recommendation"/);
  assert.match(csv, /^"CRITICAL","Create Contact Groups: No groups exist to route alerts to teams\."$/m);
});
