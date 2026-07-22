import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMonitoringTree, unionMembers, buildTemplateSliceFromTree } from '../src/lib/monitoring-tree.js';
import { analyzeTemplates } from '../src/lib/observation-analyzers/template.js';

// Captured shape from /util/monitoring_tree?include_templates=1 (FMN-199
// capture 2026-05-13, trimmed). Mirrors the real response structure: nested
// groups, server / template / OnSight / compound-service leaves all live
// under group.children with discriminators 'node-type' and id prefix.
function buildTree() {
  return {
    userHash: '258624-308609-1778644138-fcc01242dadeb5caefd1d362f5a84e79',
    nodes: [
      {
        id: 'grp-0',
        'node-type': 'group',
        text: 'All Instances',
        children: [
          {
            id: 'grp-617598',
            'node-type': 'group',
            text: 'Default Monitoring Templates',
            children: [
              { id: 's-41913280', 'node-type': 'template', text: 'Linux - Core' },
              { id: 's-41914033', 'node-type': 'template', text: 'EC2' }
            ]
          },
          {
            id: 'grp-928375',
            'node-type': 'group',
            text: 'Digital_Experience_Monitoring',
            children: [
              {
                id: 'grp-929056',
                'node-type': 'group',
                text: 'us-east-1',
                children: [
                  { id: 's-42154820', 'node-type': 'server', text: 'DEM_Lab-A' }
                ]
              },
              {
                id: 'grp-928463',
                'node-type': 'group',
                text: 'us-east-2',
                children: [
                  { id: 's-42154830', 'node-type': 'server', text: 'DEM_Lab-01' }
                ]
              },
              { id: 's-42157265', 'node-type': 'server', text: 'www.office.com' },
              { id: 'a-91001', 'node-type': 'server', text: 'OnSight-DEM' },
              { id: 'cs-77001', 'node-type': 'server', text: 'CompoundService-A' }
            ]
          },
          {
            id: 'grp-624266',
            'node-type': 'group',
            text: 'INCOMING CLOUD',
            children: []
          }
        ]
      }
    ]
  };
}

test('parseMonitoringTree: flattens nested groups + assigns parentId/depth', () => {
  const { groups } = parseMonitoringTree(buildTree());
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));

  // All groups discovered.
  assert.deepEqual(
    groups.map((g) => g.id).sort((a, b) => a - b),
    [0, 617598, 624266, 928375, 928463, 929056]
  );

  // Root depth/parent.
  assert.equal(byId[0].depth, 0);
  assert.equal(byId[0].parentId, null);
  assert.equal(byId[0].name, 'All Instances');

  // Top-level groups attach to root.
  assert.equal(byId[928375].parentId, 0);
  assert.equal(byId[928375].depth, 1);

  // Nested groups carry the right parent + depth.
  assert.equal(byId[929056].parentId, 928375);
  assert.equal(byId[929056].depth, 2);
  assert.equal(byId[928463].parentId, 928375);
});

test('parseMonitoringTree: directMemberIds vs allMemberIds (recursive)', () => {
  const { groups } = parseMonitoringTree(buildTree());
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));

  // us-east-1 has exactly one direct server.
  assert.deepEqual(byId[929056].directMemberIds, [42154820]);
  assert.deepEqual(byId[929056].allMemberIds, [42154820]);

  // DEM parent has one direct server (www.office.com) plus all descendants.
  assert.deepEqual(byId[928375].directMemberIds, [42157265]);
  assert.deepEqual(
    byId[928375].allMemberIds.slice().sort((a, b) => a - b),
    [42154820, 42154830, 42157265]
  );

  // Root rolls up everything (templates excluded, OnSight/compound excluded).
  assert.deepEqual(
    byId[0].allMemberIds.slice().sort((a, b) => a - b),
    [42154820, 42154830, 42157265]
  );
});

test('parseMonitoringTree: templates (node-type=template) skipped from members', () => {
  const { groups } = parseMonitoringTree(buildTree());
  const defaults = groups.find((g) => g.id === 617598);
  assert.deepEqual(defaults.directMemberIds, []);
  assert.deepEqual(defaults.allMemberIds, []);
  // Default Monitoring Templates has 2 template children; they should be
  // counted in the skippedTemplateCount, not the membership.
  assert.equal(defaults.skippedTemplateCount, 2);
});

test('parseMonitoringTree: OnSight (a-) and compound-service (cs-) skipped', () => {
  const { groups } = parseMonitoringTree(buildTree());
  const dem = groups.find((g) => g.id === 928375);
  // OnSight + CS leaves are visible at the parent but excluded from members.
  assert.equal(dem.skippedOnsightCount, 1);
  assert.equal(dem.skippedCompoundCount, 1);
  assert.ok(!dem.allMemberIds.includes(91001));
  assert.ok(!dem.allMemberIds.includes(77001));
});

test('parseMonitoringTree: empty / malformed input returns no groups and empty nameById', () => {
  assert.deepEqual(parseMonitoringTree(null), { groups: [], nameById: {} });
  assert.deepEqual(parseMonitoringTree({}), { groups: [], nameById: {} });
  assert.deepEqual(parseMonitoringTree({ nodes: 'not-an-array' }), { groups: [], nameById: {} });
  assert.deepEqual(
    parseMonitoringTree({ nodes: [{ id: 'broken-id', 'node-type': 'group' }] }),
    { groups: [], nameById: {} }
  );
});

test('parseMonitoringTree: harvests server names into a tenant-wide nameById', () => {
  const out = parseMonitoringTree(buildTree());
  assert.equal(out.nameById[42154820], 'DEM_Lab-A');
  assert.equal(out.nameById[42154830], 'DEM_Lab-01');
  assert.equal(out.nameById[42157265], 'www.office.com');
  // OnSight + compound + template leaves are NOT in nameById even though
  // they have text - we only track real-server ids.
  assert.equal(out.nameById[91001], undefined);
  assert.equal(out.nameById[77001], undefined);
  assert.equal(out.nameById[41913280], undefined);
});

test('unionMembers: dedupes across overlapping group picks, preserves first-seen', () => {
  const { groups } = parseMonitoringTree(buildTree());
  // Pick DEM parent + one of its children: child member already in parent's
  // allMemberIds, so the union is the parent's set (no dupes), by-group map
  // still shows the child's contribution.
  const out = unionMembers(groups, [928375, 929056]);
  assert.deepEqual(out.serverIds.sort((a, b) => a - b), [42154820, 42154830, 42157265]);
  assert.deepEqual(out.byGroupId[929056], [42154820]);
  assert.deepEqual(out.byGroupId[928375].sort((a, b) => a - b), [42154820, 42154830, 42157265]);
});

test('unionMembers: empty pick returns no servers', () => {
  const { groups } = parseMonitoringTree(buildTree());
  assert.deepEqual(unionMembers(groups, []), { serverIds: [], byGroupId: {} });
});

test('unionMembers: unknown group ids silently skipped', () => {
  const { groups } = parseMonitoringTree(buildTree());
  const out = unionMembers(groups, [99999, 929056]);
  assert.deepEqual(out.serverIds, [42154820]);
  assert.deepEqual(out.byGroupId, { 929056: [42154820] });
});

// ---- FMN-299: buildTemplateSliceFromTree (session-only template source) ----

test('buildTemplateSliceFromTree: extracts templates, maps to immediate group, ignores non-templates', () => {
  const { server_templates, server_group_details } = buildTemplateSliceFromTree(buildTree());
  // Only the two node-type:"template" leaves (both under the stock group).
  assert.deepEqual(server_templates.map((t) => t.id).sort(), ['41913280', '41914033']);
  const ids = new Set(server_templates.map((t) => t.id));
  assert.equal(ids.has('42154820'), false);   // a server
  assert.equal(ids.has('42157265'), false);   // a server that shares the s- prefix
  // Each template maps to its immediate parent group.
  for (const t of server_templates) assert.equal(t.server_group, '/server_group/617598');
  // Stock group name preserved verbatim for the analyzer's exemption.
  assert.equal(server_group_details['617598'].name, 'Default Monitoring Templates');
});

test('buildTemplateSliceFromTree: nested template maps to its NEAREST group, not an ancestor', () => {
  const tree = { nodes: [
    { id: 'grp-1', 'node-type': 'group', text: 'Acme Prod', children: [
      { id: 's-100', 'node-type': 'template', text: 'Edge' },
      { id: 'grp-2', 'node-type': 'group', text: 'Site A', children: [
        { id: 's-101', 'node-type': 'template', text: 'Core' }
      ] }
    ] }
  ] };
  const byId = Object.fromEntries(buildTemplateSliceFromTree(tree).server_templates.map((t) => [t.id, t]));
  assert.equal(byId['100'].server_group, '/server_group/1');
  assert.equal(byId['101'].server_group, '/server_group/2');   // immediate parent, not grp-1
});

test('tree-sourced slice drives analyzeTemplates with correct stock exemption', () => {
  const tree = { nodes: [
    { id: 'grp-10', 'node-type': 'group', text: 'Default Monitoring Templates', children: [
      { id: 's-1', 'node-type': 'template', text: 'Stock FGT' }
    ] },
    { id: 'grp-20', 'node-type': 'group', text: 'Acme', children: [
      { id: 's-2', 'node-type': 'template', text: 'Acme FGT' }
    ] }
  ] };
  const slice = buildTemplateSliceFromTree(tree);
  slice.template_monitoring_configs = {
    '1': { total_metrics: 3, alerts_count: 0, metric_names: ['A', 'B', 'C'], metrics_without_alerts: ['A', 'B', 'C'] },
    '2': { total_metrics: 3, alerts_count: 0, metric_names: ['A', 'B', 'C'], metrics_without_alerts: ['A', 'B', 'C'] }
  };
  const r = analyzeTemplates(slice);
  // Stock template exempted from the custom default-only analysis; only the custom one flagged.
  assert.equal(r.default_only_templates.length, 1);
  assert.equal(r.default_only_templates[0].id, '2');
  // Stock template appears in the stock overview instead.
  assert.equal(r.default_templates.length, 1);
  assert.equal(r.default_templates[0].id, '1');
});

test('buildTemplateSliceFromTree: handles empty / missing input', () => {
  assert.deepEqual(buildTemplateSliceFromTree({}).server_templates, []);
  assert.deepEqual(buildTemplateSliceFromTree(null).server_templates, []);
  assert.deepEqual(buildTemplateSliceFromTree({ nodes: [] }).server_group_details, {});
});

test('buildTemplateSliceFromTree: dedupes a template listed under multiple groups', () => {
  // The tree can list one leaf under several groups; emitting it twice would
  // produce a duplicate synthetic template and a fabricated 100%-overlap
  // finding downstream (FMN-299 review).
  const tree = { nodes: [
    { id: 'grp-1', 'node-type': 'group', text: 'A', children: [
      { id: 's-100', 'node-type': 'template', text: 'Edge' }
    ] },
    { id: 'grp-2', 'node-type': 'group', text: 'B', children: [
      { id: 's-100', 'node-type': 'template', text: 'Edge' }   // same template id, 2nd group
    ] }
  ] };
  const { server_templates } = buildTemplateSliceFromTree(tree);
  assert.equal(server_templates.length, 1, 'template emitted exactly once');
  assert.equal(server_templates[0].id, '100');
  assert.equal(server_templates[0].server_group, '/server_group/1', 'first occurrence wins');
});

test('buildTemplateSliceFromTree: stock occurrence wins so exemption survives multi-group listing', () => {
  // A template listed under a CUSTOM group first, then the stock group, must
  // map to the stock group so analyzeTemplates keeps exempting it (FMN-299 N1).
  const tree = { nodes: [
    { id: 'grp-1', 'node-type': 'group', text: 'Acme Custom', children: [
      { id: 's-100', 'node-type': 'template', text: 'FortiGate' }        // custom group FIRST
    ] },
    { id: 'grp-10', 'node-type': 'group', text: 'Default Monitoring Templates', children: [
      { id: 's-100', 'node-type': 'template', text: 'FortiGate' }        // stock group SECOND
    ] }
  ] };
  const { server_templates, server_group_details } = buildTemplateSliceFromTree(tree);
  assert.equal(server_templates.length, 1);
  assert.equal(server_templates[0].server_group, '/server_group/10', 'maps to the stock group');
  assert.equal(server_group_details['10'].name, 'Default Monitoring Templates');
});
