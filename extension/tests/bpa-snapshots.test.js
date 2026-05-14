// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-154 Phase 2.1: unit tests for the N-rotation primitives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeSnapshot,
  readSnapshots,
  setPreviousSnapshot,
  clearAllSnapshots,
  listAllSnapshots,
  getSnapshotById,
  getMaxSnapshots,
  setMaxSnapshots,
  DEFAULT_MAX_SNAPSHOTS,
  MIN_MAX_SNAPSHOTS,
  MAX_MAX_SNAPSHOTS,
} from '../src/lib/bpa-snapshots.js';
import { createStorageMock } from './fixtures/chrome-mocks.js';

function snap(takenAt, extras = {}) {
  return {
    schema: 1,
    takenAt,
    durationMs: 60_000,
    customer: { id: 1, name: 'Acme', subdomain: 'acme' },
    inventory: { servers: [], users: [], server_templates: [], server_groups: [] },
    ...extras,
  };
}

// =====================================================================
// writeSnapshot rotation -> current/previous/history
// =====================================================================

test('writeSnapshot: first write lands in current; previous + history empty', async () => {
  const local = createStorageMock();
  await writeSnapshot(snap('2026-05-14T10:00:00.000Z'), local);
  const { current, previous } = await readSnapshots(local);
  assert.equal(current.takenAt, '2026-05-14T10:00:00.000Z');
  assert.equal(previous, null);
  const all = await listAllSnapshots(local);
  assert.equal(all.length, 1);
  assert.equal(all[0].slot, 'current');
});

test('writeSnapshot: second write rotates current -> previous', async () => {
  const local = createStorageMock();
  await writeSnapshot(snap('2026-05-14T10:00:00.000Z'), local);
  await writeSnapshot(snap('2026-05-14T11:00:00.000Z'), local);
  const { current, previous } = await readSnapshots(local);
  assert.equal(current.takenAt, '2026-05-14T11:00:00.000Z');
  assert.equal(previous.takenAt, '2026-05-14T10:00:00.000Z');
  const all = await listAllSnapshots(local);
  assert.equal(all.length, 2);
});

test('writeSnapshot: third write rotates previous -> history[0]', async () => {
  const local = createStorageMock();
  await writeSnapshot(snap('T1'), local);
  await writeSnapshot(snap('T2'), local);
  await writeSnapshot(snap('T3'), local);
  const all = await listAllSnapshots(local);
  assert.deepEqual(all.map((s) => s.takenAt), ['T3', 'T2', 'T1']);
  assert.equal(all[0].slot, 'current');
  assert.equal(all[1].slot, 'previous');
  assert.equal(all[2].slot, 'history-0');
});

test('writeSnapshot: prunes history beyond maxSnapshots', async () => {
  const local = createStorageMock();
  await setMaxSnapshots(3, local);
  for (let i = 1; i <= 5; i++) {
    await writeSnapshot(snap(`T${i}`), local);
  }
  const all = await listAllSnapshots(local);
  // Max 3 means current + previous + 1 in history.
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((s) => s.takenAt), ['T5', 'T4', 'T3']);
});

test('writeSnapshot: assigns a stable id to new snapshots', async () => {
  const local = createStorageMock();
  await writeSnapshot(snap('T1'), local);
  const { current } = await readSnapshots(local);
  assert.equal(typeof current.id, 'string');
  assert.ok(current.id.length > 0);
});

// =====================================================================
// listAllSnapshots / getSnapshotById
// =====================================================================

test('listAllSnapshots: empty store returns empty list', async () => {
  const local = createStorageMock();
  assert.deepEqual(await listAllSnapshots(local), []);
});

test('listAllSnapshots: summary carries counts + customer + slot', async () => {
  const local = createStorageMock();
  await writeSnapshot(snap('T1', {
    inventory: {
      servers: [{ id: 1 }, { id: 2 }],
      users: [{ id: 5 }],
      server_templates: [],
      server_groups: [{ id: 9 }, { id: 10 }, { id: 11 }],
    },
  }), local);
  const [summary] = await listAllSnapshots(local);
  assert.equal(summary.counts.servers, 2);
  assert.equal(summary.counts.users, 1);
  assert.equal(summary.counts.server_templates, 0);
  assert.equal(summary.counts.server_groups, 3);
  assert.equal(summary.customer.subdomain, 'acme');
  assert.equal(summary.slot, 'current');
});

test('getSnapshotById: finds current/previous/history entries', async () => {
  const local = createStorageMock();
  await writeSnapshot(snap('T1'), local);
  await writeSnapshot(snap('T2'), local);
  await writeSnapshot(snap('T3'), local);
  const all = await listAllSnapshots(local);
  for (const summary of all) {
    const full = await getSnapshotById(summary.id, local);
    assert.ok(full, `expected to find snapshot for ${summary.id}`);
    assert.equal(full.takenAt, summary.takenAt);
  }
});

test('getSnapshotById: returns null for unknown id', async () => {
  const local = createStorageMock();
  await writeSnapshot(snap('T1'), local);
  assert.equal(await getSnapshotById('nope', local), null);
  assert.equal(await getSnapshotById('', local), null);
  assert.equal(await getSnapshotById(null, local), null);
});

// =====================================================================
// Legacy storage compatibility (snapshots without an `id` field)
// =====================================================================

test('listAllSnapshots: legacy data without ids gets stable synthesized ids', async () => {
  const local = createStorageMock({
    'fm:bpaSnapshots': {
      current: snap('2026-05-10T00:00:00.000Z'),
      previous: snap('2026-05-09T00:00:00.000Z'),
    },
  });
  const all = await listAllSnapshots(local);
  assert.equal(all.length, 2);
  // IDs are synthesized; we just need them present and stable.
  assert.equal(typeof all[0].id, 'string');
  assert.equal(typeof all[1].id, 'string');
  assert.notEqual(all[0].id, all[1].id);
  // Lookup by synthesized id resolves to the same data.
  const fetched = await getSnapshotById(all[0].id, local);
  assert.equal(fetched.takenAt, '2026-05-10T00:00:00.000Z');
});

test('writeSnapshot: legacy current rotates into previous on next write', async () => {
  const local = createStorageMock({
    'fm:bpaSnapshots': {
      current: snap('2026-05-10T00:00:00.000Z'),
      previous: null,
    },
  });
  await writeSnapshot(snap('2026-05-11T00:00:00.000Z'), local);
  const { current, previous } = await readSnapshots(local);
  assert.equal(current.takenAt, '2026-05-11T00:00:00.000Z');
  assert.equal(previous.takenAt, '2026-05-10T00:00:00.000Z');
});

// =====================================================================
// setMaxSnapshots clamping + prune
// =====================================================================

test('getMaxSnapshots: defaults to DEFAULT_MAX_SNAPSHOTS', async () => {
  const local = createStorageMock();
  assert.equal(await getMaxSnapshots(local), DEFAULT_MAX_SNAPSHOTS);
});

test('setMaxSnapshots: clamps below MIN and above MAX', async () => {
  const local = createStorageMock();
  assert.equal(await setMaxSnapshots(1, local), MIN_MAX_SNAPSHOTS);
  assert.equal(await getMaxSnapshots(local), MIN_MAX_SNAPSHOTS);
  assert.equal(await setMaxSnapshots(999, local), MAX_MAX_SNAPSHOTS);
  assert.equal(await getMaxSnapshots(local), MAX_MAX_SNAPSHOTS);
});

test('setMaxSnapshots: lowering the cap prunes history; current+previous stick', async () => {
  const local = createStorageMock();
  await setMaxSnapshots(5, local);
  for (let i = 1; i <= 5; i++) {
    await writeSnapshot(snap(`T${i}`), local);
  }
  assert.equal((await listAllSnapshots(local)).length, 5);
  await setMaxSnapshots(3, local);
  const all = await listAllSnapshots(local);
  assert.equal(all.length, 3);
  // current + previous untouched.
  assert.equal(all[0].takenAt, 'T5');
  assert.equal(all[1].takenAt, 'T4');
});

// =====================================================================
// clearAllSnapshots
// =====================================================================

test('clearAllSnapshots: wipes the entire store', async () => {
  const local = createStorageMock();
  await writeSnapshot(snap('T1'), local);
  await writeSnapshot(snap('T2'), local);
  await clearAllSnapshots(local);
  assert.deepEqual(await listAllSnapshots(local), []);
  const { current, previous } = await readSnapshots(local);
  assert.equal(current, null);
  assert.equal(previous, null);
});

// =====================================================================
// setPreviousSnapshot preserves the new shape's max + history
// =====================================================================

test('setPreviousSnapshot: leaves current + history intact', async () => {
  const local = createStorageMock();
  await writeSnapshot(snap('T1'), local);
  await writeSnapshot(snap('T2'), local);
  await writeSnapshot(snap('T3'), local);
  await setPreviousSnapshot(snap('IMPORTED'), local);
  const { current, previous } = await readSnapshots(local);
  assert.equal(current.takenAt, 'T3');
  assert.equal(previous.takenAt, 'IMPORTED');
  // history (containing T1) should remain.
  const all = await listAllSnapshots(local);
  assert.ok(all.find((s) => s.takenAt === 'T1'), 'T1 should still be in history');
});
