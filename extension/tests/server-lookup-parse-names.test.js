import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNameList } from '../src/ui/server-lookup/parse-names.js';

test('parseNameList: empty input yields empty result', () => {
  assert.deepEqual(parseNameList(''), { names: [], warnings: [], totalLines: 0 });
  assert.deepEqual(parseNameList(null), { names: [], warnings: [], totalLines: 0 });
});

test('parseNameList: one name per line', () => {
  const r = parseNameList('alpha\nbeta\ngamma');
  assert.deepEqual(r.names, ['alpha', 'beta', 'gamma']);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.totalLines, 3);
});

test('parseNameList: header row "name" is skipped', () => {
  const r = parseNameList('name\nFGVM01\nFGVM02');
  assert.deepEqual(r.names, ['FGVM01', 'FGVM02']);
  assert.equal(r.totalLines, 2);
});

test('parseNameList: header detection is case-insensitive', () => {
  assert.deepEqual(parseNameList('NAME\nx').names, ['x']);
  assert.deepEqual(parseNameList('Name\nx').names, ['x']);
});

test('parseNameList: a non-header first line is kept', () => {
  const r = parseNameList('FGVM01\nFGVM02');
  assert.deepEqual(r.names, ['FGVM01', 'FGVM02']);
});

test('parseNameList: comments stripped', () => {
  const r = parseNameList('# top comment\nalpha\nbeta # inline\ngamma');
  assert.deepEqual(r.names, ['alpha', 'beta', 'gamma']);
});

test('parseNameList: blank lines ignored', () => {
  const r = parseNameList('alpha\n\n\nbeta\n   \n');
  assert.deepEqual(r.names, ['alpha', 'beta']);
  assert.equal(r.totalLines, 2);
});

test('parseNameList: deduplicates and warns', () => {
  const r = parseNameList('alpha\nalpha\nbeta\nalpha');
  assert.deepEqual(r.names, ['alpha', 'beta']);
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /Duplicate name "alpha"/);
});

test('parseNameList: CSV first cell is taken when extra columns present', () => {
  const r = parseNameList('alpha,extra,stuff\nbeta,more');
  assert.deepEqual(r.names, ['alpha', 'beta']);
});

test('parseNameList: surrounding double quotes stripped from a cell', () => {
  const r = parseNameList('"alpha"\n"beta"');
  assert.deepEqual(r.names, ['alpha', 'beta']);
});

test('parseNameList: CRLF and CR line endings handled', () => {
  assert.deepEqual(parseNameList('a\r\nb\r\nc').names, ['a', 'b', 'c']);
  assert.deepEqual(parseNameList('a\rb\rc').names, ['a', 'b', 'c']);
});

test('parseNameList: literal "name" as first non-header row is preserved', () => {
  // "name" as a header is skipped, but if the user *intends* a server
  // literally called "name" they would have a header above it. Document
  // the boundary case: the first occurrence of "name" is always treated
  // as a header - there's no way to escape it. This is an accepted
  // limitation given the rarity.
  const r = parseNameList('name\nname');
  // First "name" is consumed as header, second is the only candidate but
  // also called "name" - it goes through.
  assert.deepEqual(r.names, ['name']);
});

test('parseNameList: case-sensitive - "Alpha" and "alpha" are distinct', () => {
  const r = parseNameList('Alpha\nalpha');
  assert.deepEqual(r.names, ['Alpha', 'alpha']);
  assert.equal(r.warnings.length, 0);
});
