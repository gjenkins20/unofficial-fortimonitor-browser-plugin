import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeleteSet, defaultKeepMap } from '../src/lib/find-delete-duplicates/delete-set.js';

// Duplicate sets in the shape analyzeDuplicates().groups produces.
function nameSet(value, ...members) { return { axis: 'name', value, count: members.length, members }; }
function addrSet(value, ...members) { return { axis: 'address', value, count: members.length, members }; }
const m = (id, name = `s${id}`, address = '') => ({ id: String(id), name, address });

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
