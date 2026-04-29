// FMN-120 followup: stripNulls projection helper used by handwritten
// + hand-port tools. The helper exists so open-source models don't
// see explicit null fields and re-query for "missing data."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripNulls } from '../src/lib/claude-tools/handwritten/util.js';

test('stripNulls drops null and undefined keys', () => {
  assert.deepEqual(
    stripNulls({ id: 1, name: 'x', start: null, end: undefined }),
    { id: 1, name: 'x' }
  );
});

test('stripNulls drops empty strings', () => {
  assert.deepEqual(
    stripNulls({ id: 1, name: '', tag: 'prod' }),
    { id: 1, tag: 'prod' }
  );
});

test('stripNulls preserves 0 and false', () => {
  assert.deepEqual(
    stripNulls({ id: 0, active: false, count: 0 }),
    { id: 0, active: false, count: 0 }
  );
});

test('stripNulls preserves empty arrays', () => {
  // Empty arrays carry meaning ("no tags") that nulls do not.
  assert.deepEqual(
    stripNulls({ id: 1, tags: [] }),
    { id: 1, tags: [] }
  );
});

test('stripNulls recurses into nested objects', () => {
  assert.deepEqual(
    stripNulls({ id: 1, server: { name: 'x', extra: null }, end: null }),
    { id: 1, server: { name: 'x' } }
  );
});

test('stripNulls recurses into arrays of objects', () => {
  assert.deepEqual(
    stripNulls([{ id: 1, end: null }, { id: 2, start: null }]),
    [{ id: 1 }, { id: 2 }]
  );
});

test('stripNulls passes through primitives unchanged', () => {
  assert.equal(stripNulls(42), 42);
  assert.equal(stripNulls('x'), 'x');
  assert.equal(stripNulls(true), true);
  assert.equal(stripNulls(false), false);
  assert.equal(stripNulls(null), null);
  assert.equal(stripNulls(undefined), undefined);
});
