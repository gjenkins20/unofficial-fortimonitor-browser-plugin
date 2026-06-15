import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeleteSet, defaultKeepMap, buildDuplicatesCsv, KEEP_ALL } from '../src/lib/find-delete-duplicates/delete-set.js';

function intentionalSet(axis, value, ...members) { return { axis, value, count: members.length, likely_intentional: true, members }; }

// Duplicate sets in the shape analyzeDuplicates().groups produces.
function nameSet(value, ...members) { return { axis: 'name', value, count: members.length, members }; }
function addrSet(value, ...members) { return { axis: 'address', value, count: members.length, members }; }
const m = (id, name = `s${id}`, address = '', created = '', location = '') => ({ id: String(id), name, address, created, location });

test('defaultKeepMap keeps the lowest/oldest id per set', () => {
  const groups = [nameSet('dup', m(7), m(3), m(9))];
  assert.deepEqual(defaultKeepMap(groups), { 0: '3' });
});

test('buildDeleteSet: deletes all but the kept member of each set', () => {
  const groups = [nameSet('dup', m(3), m(7), m(9))];
  const r = buildDeleteSet(groups, defaultKeepMap(groups));
  assert.equal(r.perSet[0].keptId, '3');
  assert.deepEqual(r.deleteIds.sort(), ['7', '9']);
  assert.deepEqual(r.deleteTargets.map((t) => t.id).sort(), ['7', '9']);
});

test('keep->=1 always holds: each set retains exactly one survivor', () => {
  const groups = [nameSet('a', m(1), m(2)), addrSet('x', m(3), m(4))];
  const r = buildDeleteSet(groups, { 0: '2', 1: '4' });
  // survivors 2 and 4 are not in the delete list
  assert.equal(r.deleteIds.includes('2'), false);
  assert.equal(r.deleteIds.includes('4'), false);
  assert.deepEqual(r.deleteIds.sort(), ['1', '3']);
});

test('operator keep override is honored', () => {
  const groups = [nameSet('dup', m(3), m(7), m(9))];
  const r = buildDeleteSet(groups, { 0: '9' });
  assert.equal(r.perSet[0].keptId, '9');
  assert.deepEqual(r.deleteIds.sort(), ['3', '7']);
});

test('invalid/missing keep falls back to lowest id', () => {
  const groups = [nameSet('dup', m(3), m(7))];
  assert.equal(buildDeleteSet(groups, { 0: '999' }).perSet[0].keptId, '3'); // not a member
  assert.equal(buildDeleteSet(groups, {}).perSet[0].keptId, '3');           // unset
});

test('conservative: a keep in one set is never deleted by another set', () => {
  // id 2 is shared: kept in the name set, a delete-candidate in the address set.
  const groups = [
    nameSet('shared-name', m(1), m(2)),        // keep 1 -> would delete 2
    addrSet('shared-addr', m(2), m(3))         // keep 2 -> would delete 3
  ];
  // Operator keeps 2 in the address set; default-keep (lowest) in the name set is 1.
  const r = buildDeleteSet(groups, { 0: '1', 1: '2' });
  // 2 is kept in set 1, so even though set 0 marks it for deletion it is spared.
  assert.equal(r.deleteIds.includes('2'), false);
  assert.ok(r.sparedByKeepElsewhere.includes('2'));
  assert.deepEqual(r.deleteIds.sort(), ['3']);
});

test('final delete list is deduped by id across overlapping sets', () => {
  // id 5 is a delete-candidate in BOTH sets; must appear once.
  const groups = [
    nameSet('n', m(1), m(5)),     // keep 1 -> delete 5
    addrSet('a', m(2), m(5))      // keep 2 -> delete 5
  ];
  const r = buildDeleteSet(groups, { 0: '1', 1: '2' });
  assert.deepEqual(r.deleteIds.sort(), ['5']);
  assert.equal(r.deleteTargets.length, 1);
});

test('delete targets carry name for the preview/commit', () => {
  const groups = [nameSet('dup', m(3, 'keep-me'), m(7, 'delete-me'))];
  const r = buildDeleteSet(groups, { 0: '3' });
  assert.deepEqual(r.deleteTargets, [{ id: '7', name: 'delete-me' }]);
});

test('empty input is safe', () => {
  const r = buildDeleteSet([], {});
  assert.deepEqual(r.deleteIds, []);
  assert.deepEqual(r.deleteTargets, []);
  assert.deepEqual(defaultKeepMap(undefined), {});
});

test('no over-deletion: union of per-set deleteIds equals deduped delete list (minus spared)', () => {
  const groups = [
    nameSet('n', m(1), m(2), m(3)),
    addrSet('a', m(3), m(4))
  ];
  const keep = { 0: '1', 1: '3' };
  const r = buildDeleteSet(groups, keep);
  // set0 keep 1 -> {2,3}; set1 keep 3 -> {4}; but 3 is kept in set1 -> spared.
  assert.deepEqual(r.deleteIds.sort(), ['2', '4']);
  assert.ok(r.sparedByKeepElsewhere.includes('3'));
});

// ---- likely-intentional sets default to KEEP_ALL (FMN-274) ----

test('defaultKeepMap: likely-intentional set defaults to KEEP_ALL, accidental to oldest', () => {
  const groups = [
    nameSet('acc', m(3), m(7)),                          // accidental
    intentionalSet('name', 'intent', m(5), m(9))         // intentional
  ];
  const km = defaultKeepMap(groups);
  assert.equal(km['0'], '3');          // oldest
  assert.equal(km['1'], KEEP_ALL);     // keep all
});

test('buildDeleteSet: a KEEP_ALL set deletes nothing and keeps every member', () => {
  const groups = [intentionalSet('name', 'intent', m(5), m(9), m(2))];
  const r = buildDeleteSet(groups, defaultKeepMap(groups));
  assert.deepEqual(r.deleteIds, []);
  assert.deepEqual(r.keptIds.sort(), ['2', '5', '9']);
  assert.equal(r.perSet[0].keepAll, true);
  assert.equal(r.perSet[0].likely_intentional, true);
});

test('intentional members are protected from deletion by an overlapping accidental set', () => {
  // id 2 is in an accidental name set (would be deleted) AND an intentional
  // address set (keep-all) -> the keep-all wins, 2 is never deleted.
  const groups = [
    nameSet('n', m(1), m(2)),                            // accidental: keep 1, delete 2
    intentionalSet('address', 'addr', m(2), m(3))        // intentional: keep all (2,3)
  ];
  const r = buildDeleteSet(groups, defaultKeepMap(groups));
  assert.equal(r.deleteIds.includes('2'), false);
  assert.ok(r.sparedByKeepElsewhere.includes('2'));
});

test('operator can override a KEEP_ALL set by picking a survivor', () => {
  const groups = [intentionalSet('name', 'intent', m(5), m(9))];
  const r = buildDeleteSet(groups, { 0: '5' }); // operator overrides keep-all
  assert.deepEqual(r.deleteIds, ['9']);
});

// ---- buildDuplicatesCsv (FMN-271 report export) ----

test('buildDuplicatesCsv: header + one row per member with classification, location, created, disposition', () => {
  const groups = [
    nameSet('fw-a', m(1, 'fw-a', '10.0.0.1', '2024-12-12', 'Chicago 10'), m(2, 'FW-A', '10.0.0.2', '2025-01-03', 'Chicago 10')),
    addrSet('10.0.0.9', m(3, 'b', '10.0.0.9'), m(4, 'c', '10.0.0.9'))
  ];
  const csv = buildDuplicatesCsv(groups, defaultKeepMap(groups));
  const lines = csv.split('\n');
  assert.equal(lines[0], 'match_on,shared_value,duplicate_set_size,classification,instance_id,instance_name,ip_address,monitoring_location,created,disposition');
  assert.equal(lines.length, 5); // header + 4 members
  // both sets share one location (or none) -> likely accidental; columns carried, blank when absent
  assert.ok(lines.some((l) => l === 'Name,fw-a,2,likely accidental,1,fw-a,10.0.0.1,Chicago 10,2024-12-12,keep'));
  assert.ok(lines.some((l) => l === 'Name,fw-a,2,likely accidental,2,FW-A,10.0.0.2,Chicago 10,2025-01-03,delete'));
  assert.ok(lines.some((l) => l === 'IP address,10.0.0.9,2,likely accidental,3,b,10.0.0.9,,,keep'));
  assert.ok(lines.some((l) => l === 'IP address,10.0.0.9,2,likely accidental,4,c,10.0.0.9,,,delete'));
});

test('buildDuplicatesCsv: a likely-intentional set (different locations) reports keep for all members', () => {
  const groups = [nameSet('x', m(1, 'x', 'a', '', 'Chicago 10'), m(2, 'x', 'b', '', 'Sydney 2'))];
  groups[0].likely_intentional = true;
  const csv = buildDuplicatesCsv(groups, defaultKeepMap(groups));
  const rows = csv.split('\n').slice(1);
  assert.ok(rows.every((r) => r.endsWith(',keep'))); // keep-all default -> nothing deleted
  assert.ok(rows.some((r) => r.includes(',likely intentional,')));
});

test('buildDuplicatesCsv: a member spared by keep-elsewhere is reported as keep', () => {
  const groups = [nameSet('n', m(1), m(2)), addrSet('a', m(2), m(3))];
  // keep 1 in name set, keep 2 in address set -> 2 is spared from the name set.
  const csv = buildDuplicatesCsv(groups, { 0: '1', 1: '2' });
  const rows = csv.split('\n').slice(1);
  // every row for id 2 must say keep
  for (const r of rows.filter((l) => l.split(',')[3] === '2')) {
    assert.equal(r.split(',').pop(), 'keep');
  }
});

test('buildDuplicatesCsv: quotes fields containing commas', () => {
  const groups = [nameSet('a,b', m(1, 'has,comma', 'x'), m(2, 'plain', 'y'))];
  const csv = buildDuplicatesCsv(groups, { 0: '1' });
  assert.ok(csv.includes('"a,b"'));
  assert.ok(csv.includes('"has,comma"'));
});

test('buildDuplicatesCsv: empty input is header-only', () => {
  assert.equal(buildDuplicatesCsv([], {}).split('\n').length, 1);
});
