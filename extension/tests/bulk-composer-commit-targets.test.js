import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommitTargets } from '../src/ui/bulk-composer/steps/commit.js';

// FMN-258: the commit payload builder must preserve the tags tri-state.
// array = known tags; null = chip-fetch confirmed not-found (skip downstream);
// undefined = tags not loaded yet (fast Configure -> Commit). Collapsing
// undefined to null made the SW treat "unknown" as "not found" and silently
// skip the write.

test('buildCommitTargets passes a known tag array through verbatim', () => {
  const [t] = buildCommitTargets([{ id: 1, name: 'a', tags: ['x', 'y'] }]);
  assert.deepEqual(t.tags, ['x', 'y']);
});

test('buildCommitTargets keeps null (confirmed not-found) as null', () => {
  const [t] = buildCommitTargets([{ id: 2, name: 'b', tags: null }]);
  assert.strictEqual(t.tags, null);
});

test('buildCommitTargets OMITS tags when unknown/undefined (FMN-258, not null)', () => {
  const [t] = buildCommitTargets([{ id: 3, name: 'c' }]); // no tags field
  assert.equal(Object.prototype.hasOwnProperty.call(t, 'tags'), false,
    'undefined tags must be omitted, not sent as null (which the SW reads as not-found -> skip)');
});

test('buildCommitTargets handles a mixed batch', () => {
  const out = buildCommitTargets([
    { id: 1, tags: ['a'] },
    { id: 2, tags: null },
    { id: 3 }
  ]);
  assert.deepEqual(out[0].tags, ['a']);
  assert.strictEqual(out[1].tags, null);
  assert.equal('tags' in out[2], false);
});

test('buildCommitTargets tolerates non-array input', () => {
  assert.deepEqual(buildCommitTargets(null), []);
  assert.deepEqual(buildCommitTargets(undefined), []);
});
