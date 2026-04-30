// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-115: unit tests for the cross-tool selection handoff.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
  DEFAULT_TTL_MS,
  RECEIVERS,
  listReceivers,
  getReceiver,
  writeSelection,
  readSelection,
  consumeSelection,
  consumeSelectionFor,
  clearSelection
} from '../src/lib/selection-handoff.js';
import { createStorageMock } from './fixtures/chrome-mocks.js';

function fixedClock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  return {
    now,
    advance(ms) { t += ms; },
    set(v) { t = v; }
  };
}

test('listReceivers exposes all three registered receivers', () => {
  const list = listReceivers();
  const ids = list.map((r) => r.id).sort();
  assert.deepEqual(ids, ['manage-attributes', 'manage-templates-attach', 'manage-templates-detach']);
});

test('getReceiver returns hint copies, not the frozen reference', () => {
  const r = getReceiver('manage-templates-attach');
  assert.ok(r);
  assert.equal(r.hint.operation, 'attach');
  assert.equal(getReceiver('does-not-exist'), null);
});

test('writeSelection rejects unknown receiver', async () => {
  const storage = createStorageMock();
  await assert.rejects(
    () => writeSelection({ receiverId: 'nope', ids: [1], source: 'test', storage }),
    /unknown receiver/
  );
});

test('writeSelection rejects empty ids array', async () => {
  const storage = createStorageMock();
  await assert.rejects(
    () => writeSelection({ receiverId: 'manage-attributes', ids: [], source: 'test', storage }),
    /non-empty array/
  );
});

test('writeSelection rejects ids that all coerce to invalid', async () => {
  const storage = createStorageMock();
  await assert.rejects(
    () => writeSelection({ receiverId: 'manage-attributes', ids: ['abc', null, 0, -3], source: 'test', storage }),
    /reduced to empty/
  );
});

test('writeSelection persists a normalized blob with default hint', async () => {
  const storage = createStorageMock();
  const clock = fixedClock();
  await writeSelection({
    receiverId: 'manage-templates-detach',
    ids: ['1001', 1002, 1003.0],
    names: ['edge-01', '', null, 'edge-02'],
    source: 'find-servers',
    storage,
    now: clock.now
  });
  const raw = storage.__raw()[STORAGE_KEY];
  assert.equal(raw.receiverId, 'manage-templates-detach');
  assert.deepEqual(raw.ids, [1001, 1002, 1003]);
  assert.deepEqual(raw.names, ['edge-01', 'edge-02']);
  assert.equal(raw.source, 'find-servers');
  assert.deepEqual(raw.hint, { operation: 'detach' });
  assert.equal(raw.expiresAt, clock.now() + DEFAULT_TTL_MS);
});

test('writeSelection accepts caller-supplied hint override', async () => {
  const storage = createStorageMock();
  const blob = await writeSelection({
    receiverId: 'manage-templates-detach',
    ids: [1],
    source: 't',
    hint: { operation: 'detach', strategy: 'delete' },
    storage
  });
  assert.deepEqual(blob.hint, { operation: 'detach', strategy: 'delete' });
});

test('writeSelection accepts hint=null to clear receiver default', async () => {
  const storage = createStorageMock();
  const blob = await writeSelection({
    receiverId: 'manage-templates-attach',
    ids: [1],
    source: 't',
    hint: null,
    storage
  });
  assert.equal(blob.hint, null);
});

test('readSelection returns null when no slot is set', async () => {
  const storage = createStorageMock();
  assert.equal(await readSelection({ storage }), null);
});

test('readSelection returns null for an expired blob', async () => {
  const storage = createStorageMock();
  const clock = fixedClock();
  await writeSelection({
    receiverId: 'manage-attributes',
    ids: [1],
    source: 't',
    ttlMs: 1000,
    storage,
    now: clock.now
  });
  clock.advance(2000);
  assert.equal(await readSelection({ storage, now: clock.now }), null);
});

test('readSelection rejects shape-invalid blobs without throwing', async () => {
  const storage = createStorageMock();
  await storage.set({ [STORAGE_KEY]: { receiverId: 'unknown', ids: [1], expiresAt: Date.now() + 60_000 } });
  assert.equal(await readSelection({ storage }), null);
  await storage.set({ [STORAGE_KEY]: { receiverId: 'manage-attributes', ids: [], expiresAt: Date.now() + 60_000 } });
  assert.equal(await readSelection({ storage }), null);
});

test('consumeSelection clears the slot whether or not it matched', async () => {
  const storage = createStorageMock();
  await writeSelection({ receiverId: 'manage-attributes', ids: [1], source: 't', storage });
  const a = await consumeSelection({ storage });
  assert.equal(a.receiverId, 'manage-attributes');
  const b = await readSelection({ storage });
  assert.equal(b, null);
});

test('consumeSelectionFor only returns blobs whose receiverId matches', async () => {
  const storage = createStorageMock();
  await writeSelection({ receiverId: 'manage-templates-attach', ids: [1], source: 't', storage });
  // Wrong receiver: returns null AND clears the slot.
  const wrong = await consumeSelectionFor('manage-attributes', { storage });
  assert.equal(wrong, null);
  assert.equal(storage.__raw()[STORAGE_KEY] ?? null, null);
});

test('consumeSelectionFor returns the blob when receiverId matches', async () => {
  const storage = createStorageMock();
  await writeSelection({ receiverId: 'manage-templates-attach', ids: [1, 2], source: 't', storage });
  const got = await consumeSelectionFor('manage-templates-attach', { storage });
  assert.equal(got.receiverId, 'manage-templates-attach');
  assert.deepEqual(got.ids, [1, 2]);
});

test('consumeSelectionFor accepts an array of receiverIds (multi-receiver tool)', async () => {
  const storage = createStorageMock();
  await writeSelection({ receiverId: 'manage-templates-detach', ids: [9], source: 't', storage });
  const got = await consumeSelectionFor(['manage-templates-attach', 'manage-templates-detach'], { storage });
  assert.equal(got.receiverId, 'manage-templates-detach');
});

test('clearSelection wipes the slot via remove() when available', async () => {
  const storage = createStorageMock();
  await writeSelection({ receiverId: 'manage-attributes', ids: [1], source: 't', storage });
  await clearSelection({ storage });
  assert.equal(storage.__raw()[STORAGE_KEY] ?? null, null);
});

test('RECEIVERS registry is frozen', () => {
  assert.throws(() => { RECEIVERS['xyz'] = {}; }, /assign|extensible|read only/i);
});
