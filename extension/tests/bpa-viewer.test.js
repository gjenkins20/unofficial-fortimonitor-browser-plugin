import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTabs, getVisibleTabs, buildTabCsv, csvEscape, tabFilename, buildCombinedZipEntries, combinedZipFilename } from '../src/ui/bpa-audit/viewer.js';

// =============================================================================
// Tab definitions sanity
// =============================================================================

test('getVisibleTabs(["all"]) returns all 10 tabs (FMN-149, FMN-218)', () => {
  assert.equal(getVisibleTabs(['all']).length, 10);
});

test('getVisibleTabs(undefined) returns all 10 tabs (FMN-149, FMN-218)', () => {
  assert.equal(getVisibleTabs(undefined).length, 10);
});

test('getVisibleTabs(["user-activity"]) returns only User Activity + Raw Counts (FMN-149)', () => {
  const ids = getVisibleTabs(['user-activity']).map((t) => t.id);
  assert.deepEqual(ids, ['user-activity', 'raw-counts']);
});

test('getVisibleTabs(["incidents"]) returns Incident Summary + Incidents + Raw Counts (FMN-149)', () => {
  const ids = getVisibleTabs(['incidents']).map((t) => t.id);
  assert.deepEqual(ids, ['incident-summary', 'incidents', 'raw-counts']);
});

test('getVisibleTabs(["template-recommendations","monitoring-policy"]) returns both analyzer-scoped tabs + Raw Counts (FMN-149)', () => {
  const ids = getVisibleTabs(['template-recommendations', 'monitoring-policy']).map((t) => t.id);
  assert.deepEqual(ids, ['template-recommendations', 'monitoring-policy', 'raw-counts']);
});

test('getVisibleTabs hides cross-cutting tabs in non-all mode (FMN-149)', () => {
  const ids = getVisibleTabs(['user-activity']).map((t) => t.id);
  for (const crossCutting of ['executive-summary', 'feature-utilization', 'recommended-labs']) {
    assert.equal(ids.includes(crossCutting), false, `${crossCutting} must be hidden in non-all mode`);
  }
});

test('buildCombinedZipEntries: sections=["user-activity"] produces only the 1 active tab CSV + README (FMN-149)', () => {
  const ctx = { inventory: {}, analysis: { users: { details: [] } }, customer: 'Acme' };
  const entries = buildCombinedZipEntries(ctx, { sections: ['user-activity'] });
  // README + user-activity + raw-counts = 3 entries.
  const filenames = entries.map((e) => e.filename).sort();
  assert.deepEqual(filenames, ['README.txt', 'raw-counts.csv', 'user-activity.csv']);
});

test('getTabs: returns the 10 tabs FMN-218 spec calls for, in order', () => {
  // FMN-156 rework: noise analysis folded into Incident Summary.
  // FMN-218 rework: 'recommendations' tab removed when the BPA shifted
  // to observation-only output; the prior tab #10 (Recommended Labs,
  // now relabelled Quick Labs) is tab #9.
  const tabs = getTabs();
  assert.equal(tabs.length, 10);
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

test('User Activity tab: last_login is read-only with N/A fallback, active_assessment is derived (FMN-143)', () => {
  const ua = getTabs().find((t) => t.id === 'user-activity');
  const cols = ua.sections[0].columns;
  const lastLogin = cols.find((c) => c.key === 'last_login');
  const assess = cols.find((c) => c.key === 'active_assessment');
  // Last Login is read-only - no annotation / manual-entry input.
  assert.equal(lastLogin?.annotation, undefined);
  assert.equal(typeof lastLogin.getter, 'function');
  // When the analyzer produced an empty last_login (frontend fetch
  // unavailable), the column renders 'N/A' rather than blank or '-'.
  assert.equal(lastLogin.getter({ last_login: '' }), 'N/A');
  assert.equal(lastLogin.getter({ last_login: null }), 'N/A');
  assert.equal(lastLogin.getter({ last_login: '2026-04-30 12:00 UTC' }), '2026-04-30 12:00 UTC');
  // Active Assessment is derived (no annotation).
  assert.equal(assess?.annotation, undefined);
  assert.equal(typeof assess.getter, 'function');
  assert.equal(assess.header, 'Active Assessment');
});

test('User Activity tab: Active Assessment legend section enumerates all five buckets (FMN-143)', () => {
  const ua = getTabs().find((t) => t.id === 'user-activity');
  const legend = ua.sections.find((s) => s.label === 'Active Assessment Legend');
  assert.ok(legend, 'expected legend section');
  const rows = legend.rows();
  const statuses = rows.map((r) => r.status);
  assert.deepEqual(statuses, ['Active', 'Stale', 'Inactive', 'Never', 'Unknown']);
  for (const r of rows) {
    assert.ok(r.definition && r.definition.length > 0, `${r.status} should have a definition`);
  }
});

test('Template Recommendations: every analyzer-driven section exposes an ID column (FMN-147)', () => {
  const tr = getTabs().find((t) => t.id === 'template-recommendations');
  // Sections that target a single template (skip Manual Threshold
  // Candidates - those rows are server-side patterns, not templates).
  const idHavingLabels = [
    'Custom Templates Without Thresholds',
    'Custom Templates Cleanup Candidates',
    'Default Templates (FortiMonitor stock)'
  ];
  for (const label of idHavingLabels) {
    const s = tr.sections.find((x) => x.label === label);
    assert.ok(s, `expected section "${label}"`);
    const idCol = s.columns.find((c) => c.key === 'id');
    assert.ok(idCol, `${label} should expose an ID column`);
    assert.equal(idCol.header, 'ID');
    assert.equal(idCol.getter({ id: '42' }), '42');
  }
});

test('Template Recommendations: overlap section exposes BOTH template IDs (FMN-147)', () => {
  const tr = getTabs().find((t) => t.id === 'template-recommendations');
  const overlap = tr.sections.find((s) => s.label === 'Custom Template Overlap');
  assert.ok(overlap);
  const id1 = overlap.columns.find((c) => c.key === 'id_1');
  const id2 = overlap.columns.find((c) => c.key === 'id_2');
  assert.ok(id1 && id2, 'overlap should have id_1 and id_2 columns');
  assert.equal(id1.header, 'ID 1');
  assert.equal(id2.header, 'ID 2');
  assert.equal(id1.getter({ id_1: '7', id_2: '8' }), '7');
  assert.equal(id2.getter({ id_1: '7', id_2: '8' }), '8');
});

test('Template Recommendations: template-name columns carry a cellRenderer for HTML linking (FMN-147)', () => {
  const tr = getTabs().find((t) => t.id === 'template-recommendations');
  const labels = [
    'Custom Templates Without Thresholds',
    'Custom Templates Cleanup Candidates',
    'Default Templates (FortiMonitor stock)',
    'Custom Template Overlap'
  ];
  for (const label of labels) {
    const s = tr.sections.find((x) => x.label === label);
    const nameCols = s.columns.filter((c) => typeof c.cellRenderer === 'function');
    assert.ok(nameCols.length > 0, `${label} should have at least one cellRenderer column`);
    // CSV path still goes through getter (text-only); renderer is HTML-only.
    for (const col of nameCols) {
      assert.equal(typeof col.getter, 'function');
    }
  }
});

test('buildTabCsv: template ID column flows into CSV output (FMN-147, FMN-218)', () => {
  const tab = getTabs().find((t) => t.id === 'template-recommendations');
  const ctx = {
    inventory: {},
    analysis: {
      templates: {
        available: true,
        default_only_templates: [
          { id: '99', template: 'Custom-Linux', resource_count: 4, observation: 'Custom template carries 4 metric definitions and no alerting thresholds.' }
        ],
        manual_threshold_candidates: [],
        cleanup_candidates: [],
        overlapping_templates: [
          { id_1: '1', id_2: '2', template_1: 'A', template_2: 'B',
            overlap_pct: '75%', shared_metrics: 3,
            observation: '3 of 4 metric names overlap between these two templates.' }
        ],
        default_templates: []
      }
    },
    customer: '',
    annotations: {}
  };
  const csv = buildTabCsv(tab, ctx);
  // Without-Thresholds section: ID column header + value present.
  assert.match(csv, /"ID","Template","Metric Count","Observation"/);
  assert.match(csv, /^"99","Custom-Linux","4","Custom template carries 4 metric definitions and no alerting thresholds\."$/m);
  // Overlap section: both ID headers + values aligned with their templates.
  assert.match(csv, /"ID 1","Template 1","ID 2","Template 2","Overlap %","Shared","Observation"/);
  assert.match(csv, /^"1","A","2","B","75%","3","3 of 4 metric names overlap between these two templates\."$/m);
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
    customer: 'Acme'
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

test('buildTabCsv: User Activity renders N/A for missing last_login, real value when populated (FMN-143)', () => {
  const tab = getTabs().find((t) => t.id === 'user-activity');
  const ctx = {
    inventory: {},
    analysis: {
      users: {
        total: 2,
        details: [
          {
            id: 7, name: 'Alice', email: 'a@x', created: '2024-01-01',
            contact_methods: 1, last_login: '', active_assessment: 'Never', created_on: ''
          },
          {
            id: 8, name: 'Bob', email: 'b@x', created: '2024-02-01',
            contact_methods: 2, last_login: '2026-04-30 12:00 UTC',
            active_assessment: 'Active', created_on: 'Jan 1, 2024'
          }
        ],
        primary_user: null,
        issues: []
      }
    },
    customer: ''
  };
  const csv = buildTabCsv(tab, ctx);
  assert.match(csv, /Last Login/);
  assert.match(csv, /Active Assessment/);
  // Alice has no last_login - N/A in the column.
  assert.match(csv, /"Alice","a@x","2024-01-01","","1","N\/A","Never"/);
  // Bob has a last_login - verbatim value, no N/A.
  assert.match(csv, /"Bob","b@x","2024-02-01","Jan 1, 2024","2","2026-04-30 12:00 UTC","Active"/);
  // Legend section appears in the CSV with a comment header + table.
  assert.match(csv, /# Active Assessment Legend/);
  assert.match(csv, /"Status","Definition"/);
  assert.match(csv, /"Active","Logged in within the last 90 days\."/);
  assert.match(csv, /"Never","No login on record, or upstream data unavailable\."/);
});

test('buildTabCsv: empty sections without alwaysIncludeHeader are skipped from the output', () => {
  const tab = getTabs().find((t) => t.id === 'incidents');
  const csv = buildTabCsv(tab, {
    inventory: {},
    analysis: { incidents: { active_details: [] } },
    customer: ''
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

test('buildCombinedZipEntries: emits one CSV per visible tab + a README (FMN-218: 10 tabs + 1 README)', () => {
  const ctx = {
    inventory: { servers: [{ id: 1, status: 'active' }] },
    analysis: { incidents: { active_details: [], top_by_instance: [], top_by_type: [], noisy_metrics: [], trending: {} }, users: { details: [] } },
    customer: 'Acme'
  };
  const entries = buildCombinedZipEntries(ctx, { generatedAt: '2026-05-01T00:00:00Z', customer: 'Acme' });
  // FMN-218: 10 native tabs + 1 README = 11. The post-FMN-218 contract is
  // "visible tabs + README", not "all tabs + README".
  const visible = getVisibleTabs(['all']);
  assert.equal(entries.length, visible.length + 1, 'expected (visible tabs) + 1 README');
  // README is first
  assert.equal(entries[0].filename, 'README.txt');
  assert.match(entries[0].content, /Best-Practice Assessment/);
  assert.match(entries[0].content, /Customer: Acme/);
  // Every visible tab is represented by exactly one CSV
  const csvNames = entries.slice(1).map((e) => e.filename);
  for (const tab of visible) {
    assert.ok(csvNames.includes(`${tab.filenamePart}.csv`), `expected ${tab.filenamePart}.csv in zip`);
  }
});

test('buildCombinedZipEntries: README lists every visible tab with its label', () => {
  const entries = buildCombinedZipEntries({ inventory: {}, analysis: {}, customer: '' });
  const readme = entries[0].content;
  for (const tab of getVisibleTabs(['all'])) {
    assert.match(readme, new RegExp(`${tab.filenamePart}\\.csv\\s+-\\s+${tab.label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`));
  }
});

// FMN-218: the prior "Recommendations" tab was removed when the BPA
// shifted to observation-only output. Each analyzer's per-row findings
// already carry an "Observation" column; there is no synthesized
// recommendations tab above them.
