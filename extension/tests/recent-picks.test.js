import { test } from 'node:test';
import assert from 'node:assert/strict';

import { saveRecentPick, loadRecentPicks, clearRecentPicks, humanizeAge, MAX_ENTRIES } from '../src/lib/recent-picks.js';

// =====================================================================
// FMN-235: Bulk Action Composer recent-picks ring buffer
// =====================================================================

function installStorageStub() {
  let store = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') {
            return key in store ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        async set(entries) {
          Object.assign(store, entries);
        },
        async remove(key) {
          delete store[key];
        },
      },
    },
  };
  return {
    reset() { store = {}; },
    snapshot() { return { ...store }; },
  };
}

const harness = installStorageStub();

test('saveRecentPick stores newest-first', async (t) => {
  t.beforeEach(() => harness.reset());

  await saveRecentPick([{ id: 1, name: 'alpha' }]);
  await saveRecentPick([{ id: 2, name: 'beta' }]);
  const entries = await loadRecentPicks();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].targets[0].id, 2);
  assert.equal(entries[1].targets[0].id, 1);
});

test('saveRecentPick caps at MAX_ENTRIES (5)', async () => {
  harness.reset();
  for (let i = 1; i <= MAX_ENTRIES + 3; i++) {
    await saveRecentPick([{ id: i, name: `host-${i}` }]);
  }
  const entries = await loadRecentPicks();
  assert.equal(entries.length, MAX_ENTRIES);
  // Most recent first; older entries dropped.
  assert.equal(entries[0].targets[0].id, MAX_ENTRIES + 3);
  assert.equal(entries[entries.length - 1].targets[0].id, 4);
});

test('saveRecentPick dedupes when id set matches an existing entry', async () => {
  harness.reset();
  await saveRecentPick([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
  await saveRecentPick([{ id: 3, name: 'c' }]);
  await saveRecentPick([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]); // same set as first save
  const entries = await loadRecentPicks();
  assert.equal(entries.length, 2);
  // The deduped entry surfaces at the front with the new timestamp.
  const front = entries[0];
  assert.equal(front.targets.length, 2);
  assert.deepEqual(front.targets.map((t) => t.id).sort(), [1, 2]);
});

test('saveRecentPick is a noop when targets is empty / invalid', async () => {
  harness.reset();
  await saveRecentPick([]);
  await saveRecentPick(null);
  await saveRecentPick(undefined);
  await saveRecentPick([{ id: 'not-a-number' }]);
  const entries = await loadRecentPicks();
  assert.equal(entries.length, 0);
});

test('saveRecentPick sanitizes: drops non-numeric ids, coerces id, dedupes within snapshot', async () => {
  harness.reset();
  await saveRecentPick([
    { id: '42', name: 'forty-two' },
    { id: 42, name: 'duplicate' },
    { id: 'NaN', name: 'bogus' },
    { id: 43, name: null },
    { id: 44 },
  ]);
  const [entry] = await loadRecentPicks();
  assert.equal(entry.targets.length, 3);
  assert.deepEqual(entry.targets.map((t) => t.id).sort((a, b) => a - b), [42, 43, 44]);
});

test('loadRecentPicks returns empty array on fresh storage', async () => {
  harness.reset();
  const entries = await loadRecentPicks();
  assert.deepEqual(entries, []);
});

test('loadRecentPicks tolerates malformed stored entries', async () => {
  harness.reset();
  await chrome.storage.local.set({
    'bulk-composer:recent-picks': [
      { savedAt: '2026-05-21T12:00:00Z', targets: [{ id: 1, name: 'good' }] },
      { savedAt: null, targets: [{ id: 2 }] }, // malformed: no savedAt
      { savedAt: '2026-05-22T12:00:00Z', targets: [] }, // empty targets
      'not-an-object',
    ],
  });
  const entries = await loadRecentPicks();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].targets[0].id, 1);
});

test('clearRecentPicks empties the ring buffer', async () => {
  harness.reset();
  await saveRecentPick([{ id: 1, name: 'a' }]);
  await clearRecentPicks();
  const entries = await loadRecentPicks();
  assert.equal(entries.length, 0);
});

// ---------- humanizeAge ----------

test('humanizeAge: just now / minutes / hours / yesterday / days / weeks / date fallback', () => {
  const base = new Date('2026-05-22T12:00:00Z').getTime();
  const at = (offsetSeconds) => new Date(base - offsetSeconds * 1000).toISOString();

  assert.equal(humanizeAge(at(10), base), 'just now');
  assert.equal(humanizeAge(at(30), base), 'just now');
  assert.equal(humanizeAge(at(120), base), '2 min ago');
  assert.equal(humanizeAge(at(3600 * 3), base), '3 hr ago');
  assert.equal(humanizeAge(at(86400), base), 'yesterday');
  assert.equal(humanizeAge(at(86400 * 3), base), '3 days ago');
  assert.equal(humanizeAge(at(86400 * 14), base), '2 wk ago');
  // > 5 weeks falls back to ISO date.
  assert.match(humanizeAge(at(86400 * 60), base), /^\d{4}-\d{2}-\d{2}$/);
});

test('humanizeAge: invalid input yields empty string', () => {
  assert.equal(humanizeAge('not-a-date'), '');
  assert.equal(humanizeAge(null), '');
});
