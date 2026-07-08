import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMappingText, classifyToken, flattenGroups,
  setRowStatus, removeRowStatus, isChangeStatus
} from '../src/lib/parent-child-mapping.js';

// ---------- parseMappingText ----------

test('parseMappingText: parent: child, child lines -> groups', () => {
  const { groups, errors } = parseMappingText('core-router: switch-01, switch-02, switch-03\ndmz-fw: edge-01');
  assert.equal(errors.length, 0);
  assert.deepEqual(groups, [
    { parent: 'core-router', children: ['switch-01', 'switch-02', 'switch-03'] },
    { parent: 'dmz-fw', children: ['edge-01'] }
  ]);
});

test('parseMappingText: ignores blank lines; reports malformed ones', () => {
  const { groups, errors } = parseMappingText('\ncore-router: a, b\n\nno-colon-line\nonlyparent:\n: orphan');
  assert.deepEqual(groups, [{ parent: 'core-router', children: ['a', 'b'] }]);
  assert.equal(errors.length, 3);
  assert.match(errors[0].error, /Expected "parent: child/);
  assert.match(errors[1].error, /No children/);
  assert.match(errors[2].error, /Missing parent/);
});

test('parseMappingText: tolerates extra whitespace + trailing commas', () => {
  const { groups } = parseMappingText('  P :  a , , b ,  ');
  assert.deepEqual(groups, [{ parent: 'P', children: ['a', 'b'] }]);
});

// ---------- classifyToken ----------

test('classifyToken: numeric -> id, else name (IDs and names both supported)', () => {
  assert.deepEqual(classifyToken('44218437'), { kind: 'id', value: '44218437' });
  assert.deepEqual(classifyToken('  fgt-ha '), { kind: 'name', value: 'fgt-ha' });
  assert.deepEqual(classifyToken(''), { kind: 'empty', value: '' });
});

// ---------- flattenGroups ----------

test('flattenGroups: dedups children; last parent wins; reports conflicts', () => {
  const { rows, conflicts } = flattenGroups([
    { parent: 'P1', children: ['a', 'b'] },
    { parent: 'P2', children: ['b', 'c'] }   // b re-assigned P1 -> P2
  ]);
  assert.deepEqual(rows, [
    { childToken: 'a', parentToken: 'P1' },
    { childToken: 'b', parentToken: 'P2' },
    { childToken: 'c', parentToken: 'P2' }
  ]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0], { childToken: 'b', from: 'P1', to: 'P2' });
});

test('flattenGroups: same child same parent twice is not a conflict', () => {
  const { rows, conflicts } = flattenGroups([
    { parent: 'P', children: ['a'] },
    { parent: 'P', children: ['a'] }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(conflicts.length, 0);
});

test('flattenGroups: skips empty parent/child tokens', () => {
  const { rows } = flattenGroups([{ parent: '  ', children: ['a'] }, { parent: 'P', children: ['', 'b'] }]);
  assert.deepEqual(rows, [{ childToken: 'b', parentToken: 'P' }]);
});

// ---------- setRowStatus ----------

const CH = { id: 1, name: 'child', url: 'u/1' };
const PAR = { id: 2, name: 'parent', url: 'u/2' };

test('setRowStatus: will set when parent differs from current', () => {
  assert.equal(setRowStatus({ child: CH, parent: PAR, currentParentUrl: null }), 'set');
  assert.equal(setRowStatus({ child: CH, parent: PAR, currentParentUrl: 'u/9' }), 'set');
});

test('setRowStatus: skip-already when current === chosen parent', () => {
  assert.equal(setRowStatus({ child: CH, parent: PAR, currentParentUrl: 'u/2' }), 'skip-already');
});

test('setRowStatus: skip-self when child === parent', () => {
  assert.equal(setRowStatus({ child: CH, parent: { id: 1, url: 'u/1' }, currentParentUrl: null }), 'skip-self');
});

test('setRowStatus: error branches when unresolved', () => {
  assert.equal(setRowStatus({ child: null, parent: PAR, currentParentUrl: null }), 'error-child');
  assert.equal(setRowStatus({ child: CH, parent: null, currentParentUrl: null }), 'error-parent');
});

// ---------- removeRowStatus ----------

test('removeRowStatus: remove when a parent exists, skip-none otherwise', () => {
  assert.equal(removeRowStatus({ child: CH, currentParentUrl: 'u/2' }), 'remove');
  assert.equal(removeRowStatus({ child: CH, currentParentUrl: null }), 'skip-none');
  assert.equal(removeRowStatus({ child: null, currentParentUrl: 'u/2' }), 'error-child');
});

test('isChangeStatus', () => {
  assert.equal(isChangeStatus('set'), true);
  assert.equal(isChangeStatus('remove'), true);
  assert.equal(isChangeStatus('skip-already'), false);
  assert.equal(isChangeStatus('skip-self'), false);
  assert.equal(isChangeStatus('error-child'), false);
});
