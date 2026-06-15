import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDuplicates } from '../src/lib/observation-analyzers/duplicate.js';

// =====================================================================
// DuplicateAnalyzer - flags instances sharing a normalized name or fqdn
// =====================================================================

test('returns available:false with a note when there are no servers', () => {
  const r = analyzeDuplicates({});
  assert.equal(r.available, false);
  assert.match(r.note, /No instances/i);
  assert.equal(analyzeDuplicates({ servers: [] }).available, false);
});

test('no duplicates -> available with empty groups', () => {
  const r = analyzeDuplicates({ servers: [
    { url: '/v2/server/1/', name: 'alpha', fqdn: '10.0.0.1' },
    { url: '/v2/server/2/', name: 'beta', fqdn: '10.0.0.2' }
  ] });
  assert.equal(r.available, true);
  assert.equal(r.groups.length, 0);
  assert.equal(r.summary.total_groups, 0);
  assert.equal(r.summary.instances_involved, 0);
  assert.equal(r.summary.servers_scanned, 2);
});

test('groups by case-insensitive, trimmed name', () => {
  const r = analyzeDuplicates({ servers: [
    { url: '/v2/server/1/', name: 'FGVM-A', fqdn: '10.0.0.1' },
    { url: '/v2/server/2/', name: ' fgvm-a ', fqdn: '10.0.0.2' },
    { url: '/v2/server/3/', name: 'other', fqdn: '10.0.0.3' }
  ] });
  const nameGroups = r.groups.filter((g) => g.axis === 'name');
  assert.equal(nameGroups.length, 1);
  assert.equal(nameGroups[0].count, 2);
  assert.equal(nameGroups[0].value, 'FGVM-A'); // display casing from first member
  assert.deepEqual(nameGroups[0].members.map((m) => m.id).sort(), ['1', '2']);
});

test('groups by address (fqdn) across different names', () => {
  const r = analyzeDuplicates({ servers: [
    { url: '/v2/server/1/', name: 'name-one', fqdn: '192.168.1.1' },
    { url: '/v2/server/2/', name: 'name-two', fqdn: '192.168.1.1' }
  ] });
  const addrGroups = r.groups.filter((g) => g.axis === 'address');
  assert.equal(addrGroups.length, 1);
  assert.equal(addrGroups[0].count, 2);
  assert.equal(addrGroups[0].value, '192.168.1.1');
});

test('empty names / empty fqdns never form a group', () => {
  const r = analyzeDuplicates({ servers: [
    { url: '/v2/server/1/', name: '', fqdn: '' },
    { url: '/v2/server/2/', name: '', fqdn: '' },
    { url: '/v2/server/3/', name: '   ', fqdn: '   ' }
  ] });
  assert.equal(r.available, true);
  assert.equal(r.groups.length, 0);
});

test('derives id from url when no inline id; dedupes members by id', () => {
  // Same record id appearing twice must not fabricate a duplicate.
  const r = analyzeDuplicates({ servers: [
    { url: '/v2/server/10/', name: 'dup', fqdn: 'a' },
    { url: '/v2/server/10/', name: 'dup', fqdn: 'a' }
  ] });
  assert.equal(r.groups.length, 0); // only one distinct id
});

test('carries a normalized created date (YYYY-MM-DD) onto each member', () => {
  const r = analyzeDuplicates({ servers: [
    { id: 1, name: 'dup', fqdn: 'a', created: 'Thu, 12 Dec 2024 01:33:48 -0000' },
    { id: 2, name: 'dup', fqdn: 'b', created: '2025-01-03 10:00:00' },
    { id: 3, name: 'dup', fqdn: 'c' } // no created -> ''
  ] });
  const set = r.groups.find((g) => g.axis === 'name');
  const byId = new Map(set.members.map((m) => [m.id, m.created]));
  assert.equal(byId.get('1'), '2024-12-12');
  assert.equal(byId.get('2'), '2025-01-03');
  assert.equal(byId.get('3'), '');
});

test('resolves monitoring location from inventory.monitoring_nodes and classifies sets', () => {
  const inv = {
    monitoring_nodes: [
      { url: '/v2/monitoring_node/10', name: 'Chicago 10' },
      { url: '/v2/monitoring_node/20', name: 'Sydney 2' }
    ],
    servers: [
      { id: 1, name: 'same-loc', fqdn: 'a', primary_monitoring_node: 'https://x/v2/monitoring_node/10' },
      { id: 2, name: 'same-loc', fqdn: 'b', primary_monitoring_node: 'https://x/v2/monitoring_node/10' },
      { id: 3, name: 'diff-loc', fqdn: 'c', primary_monitoring_node: 'https://x/v2/monitoring_node/10' },
      { id: 4, name: 'diff-loc', fqdn: 'd', primary_monitoring_node: 'https://x/v2/monitoring_node/20' }
    ]
  };
  const r = analyzeDuplicates(inv);
  const same = r.groups.find((g) => g.value === 'same-loc');
  const diff = r.groups.find((g) => g.value === 'diff-loc');
  assert.equal(same.likely_intentional, false);       // both Chicago 10
  assert.equal(diff.likely_intentional, true);         // Chicago vs Sydney
  assert.equal(same.members.find((m) => m.id === '1').location, 'Chicago 10');
  assert.equal(diff.members.find((m) => m.id === '4').location, 'Sydney 2');
});

test('resolves Monitoring Location from OnSight (primary_monitoring_node is polymorphic)', () => {
  // The real bug: primary_monitoring_node can be an /onsight/{id} URL, not just
  // /monitoring_node/{id}. OnSight-proxied instances must resolve their location.
  const inv = {
    monitoring_nodes: [{ url: 'https://api2.panopta.com/v2/monitoring_node/632', name: 'Chicago 10' }],
    onsights: [{ url: 'https://api2.panopta.com/v2/onsight/17887', name: 'fm-onsight-01' }],
    servers: [
      { id: 1, name: 'ons', fqdn: 'a', primary_monitoring_node: 'https://api2.panopta.com/v2/onsight/17887' },
      { id: 2, name: 'ons', fqdn: 'b', primary_monitoring_node: 'https://api2.panopta.com/v2/onsight/17887' }
    ]
  };
  const set = analyzeDuplicates(inv).groups.find((g) => g.axis === 'name');
  assert.deepEqual(set.members.map((m) => m.location), ['fm-onsight-01', 'fm-onsight-01']);
  assert.equal(set.likely_intentional, false); // same OnSight -> accidental
});

test('different collector kinds (cloud node vs OnSight) classify as intentional', () => {
  const inv = {
    monitoring_nodes: [{ url: 'https://x/v2/monitoring_node/632', name: 'Chicago 10' }],
    onsights: [{ url: 'https://x/v2/onsight/17887', name: 'fm-onsight-01' }],
    servers: [
      { id: 1, name: 'dup', fqdn: 'a', primary_monitoring_node: 'https://x/v2/monitoring_node/632' },
      { id: 2, name: 'dup', fqdn: 'b', primary_monitoring_node: 'https://x/v2/onsight/17887' }
    ]
  };
  const set = analyzeDuplicates(inv).groups.find((g) => g.axis === 'name');
  assert.deepEqual(set.members.map((m) => m.location).sort(), ['Chicago 10', 'fm-onsight-01']);
  assert.equal(set.likely_intentional, true);
});

test('resolves an arbitrary collector type via the pre-resolved monitoring_source_names map', () => {
  // FortiManager / custom proxies have no list endpoint; the find handler GETs
  // them and passes a pre-resolved map keyed by "<type>/<id>" (or URL).
  const inv = {
    monitoring_source_names: { 'fortimanager/9': 'FortiManager-HQ' },
    servers: [
      { id: 1, name: 'fmg', fqdn: 'a', primary_monitoring_node: 'https://x/v2/fortimanager/9' },
      { id: 2, name: 'fmg', fqdn: 'b', primary_monitoring_node: 'https://x/v2/fortimanager/9' }
    ]
  };
  const set = analyzeDuplicates(inv).groups.find((g) => g.axis === 'name');
  assert.deepEqual(set.members.map((m) => m.location), ['FortiManager-HQ', 'FortiManager-HQ']);
});

test('likely_intentional is false when locations are unknown (no monitoring_nodes)', () => {
  const r = analyzeDuplicates({ servers: [
    { id: 1, name: 'dup', fqdn: 'a', primary_monitoring_node: 'https://x/v2/monitoring_node/10' },
    { id: 2, name: 'dup', fqdn: 'b', primary_monitoring_node: 'https://x/v2/monitoring_node/20' }
  ] });
  // No monitoring_nodes map -> locations unresolved ('') -> cannot prove intentional.
  const set = r.groups.find((g) => g.axis === 'name');
  assert.equal(set.likely_intentional, false);
  assert.equal(set.members.every((m) => m.location === ''), true);
});

test('inline id is preferred and stringified', () => {
  const r = analyzeDuplicates({ servers: [
    { id: 100, name: 'shared', fqdn: 'x1' },
    { id: 200, name: 'shared', fqdn: 'x2' }
  ] });
  const g = r.groups.find((x) => x.axis === 'name');
  assert.deepEqual(g.members.map((m) => m.id).sort(), ['100', '200']);
});

test('summary tallies and ordering: larger groups first, name axis before address', () => {
  const r = analyzeDuplicates({ servers: [
    { id: 1, name: 'big', fqdn: 'addr-z' },
    { id: 2, name: 'big', fqdn: 'addr-y' },
    { id: 3, name: 'big', fqdn: 'addr-x' },
    { id: 4, name: 'pair-a', fqdn: 'shared-addr' },
    { id: 5, name: 'pair-b', fqdn: 'shared-addr' }
  ] });
  assert.equal(r.summary.by_name, 1);
  assert.equal(r.summary.by_address, 1);
  assert.equal(r.summary.total_groups, 2);
  assert.equal(r.summary.instances_involved, 5);
  // 3-member name group sorts ahead of the 2-member address group
  assert.equal(r.groups[0].axis, 'name');
  assert.equal(r.groups[0].count, 3);
  assert.equal(r.groups[1].axis, 'address');
});

test('records missing both id and url are dropped, not crashed on', () => {
  const r = analyzeDuplicates({ servers: [
    { name: 'no-id-1', fqdn: 'q' },
    { name: 'no-id-2', fqdn: 'q' },
    { id: 1, name: 'real', fqdn: 'q' },
    { id: 2, name: 'real', fqdn: 'q' }
  ] });
  // The two no-id records are dropped; only the two real ids form groups.
  assert.equal(r.summary.servers_scanned, 2);
  assert.ok(r.groups.every((g) => g.members.every((m) => m.id === '1' || m.id === '2')));
});
