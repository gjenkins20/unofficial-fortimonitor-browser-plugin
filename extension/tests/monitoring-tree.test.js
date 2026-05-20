import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMonitoringTree, unionMembers } from '../src/lib/monitoring-tree.js';

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
