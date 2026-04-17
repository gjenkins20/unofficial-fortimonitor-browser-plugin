import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue, __test__ } from '../src/lib/queue.js';
import { createStorageMock } from './fixtures/chrome-mocks.js';

function freshQueue(initial = {}) {
  const storage = createStorageMock(initial);
  const q = new Queue({ storage });
  return { q, storage };
}

test('new Queue on empty storage returns an empty list', async () => {
  const { q } = freshQueue();
  assert.deepEqual(await q.list(), []);
});

test('Queue requires a storage adapter', () => {
  assert.throws(() => new Queue({ storage: {} }), TypeError);
});

test('add appends a new entry with generated id and attempts array', async () => {
  const { q } = freshQueue();
  const entry = await q.add({ serverId: 42024060, deviceName: 'FGT-001' });
  assert.equal(typeof entry.id, 'string');
  assert.ok(entry.id.length > 0);
  assert.deepEqual(entry.attempts, []);
  assert.equal(entry.serverId, 42024060);

  const list = await q.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, entry.id);
});

test('addMany appends many entries in order', async () => {
  const { q } = freshQueue();
  await q.addMany([
    { serverId: 1, deviceName: 'A' },
    { serverId: 2, deviceName: 'B' },
    { serverId: 3, deviceName: 'C' }
  ]);
  const list = await q.list();
  assert.deepEqual(list.map((e) => e.deviceName), ['A', 'B', 'C']);
});

test('add is persistent across fresh Queue instances sharing storage', async () => {
  const { q, storage } = freshQueue();
  await q.add({ serverId: 1 });
  const q2 = new Queue({ storage });
  const list = await q2.list();
  assert.equal(list.length, 1);
});

test('update mutates an entry matched by id', async () => {
  const { q } = freshQueue();
  const e = await q.add({ serverId: 1, status: 'pending' });
  await q.update(e.id, { status: 'succeeded' });
  const list = await q.list();
  assert.equal(list[0].status, 'succeeded');
});

test('update returns null when id is not found', async () => {
  const { q } = freshQueue();
  const result = await q.update('nope', { status: 'succeeded' });
  assert.equal(result, null);
});

test('recordAttempt appends to attempts array with timestamp', async () => {
  const { q } = freshQueue();
  const e = await q.add({ serverId: 1 });
  await q.recordAttempt(e.id, { error: 'HTTP 500' });
  const list = await q.list();
  assert.equal(list[0].attempts.length, 1);
  assert.equal(list[0].attempts[0].error, 'HTTP 500');
  assert.match(list[0].attempts[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('remove deletes entries matching predicate and returns them', async () => {
  const { q } = freshQueue();
  await q.addMany([
    { serverId: 1, status: 'succeeded' },
    { serverId: 2, status: 'failed' },
    { serverId: 3, status: 'failed' }
  ]);
  const removed = await q.remove((e) => e.status === 'failed');
  assert.equal(removed.length, 2);
  const remaining = await q.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].serverId, 1);
});

test('clear empties the queue', async () => {
  const { q } = freshQueue();
  await q.addMany([{ serverId: 1 }, { serverId: 2 }]);
  await q.clear();
  assert.deepEqual(await q.list(), []);
});

test('replaceAll overwrites the entire queue', async () => {
  const { q } = freshQueue();
  await q.addMany([{ serverId: 1 }, { serverId: 2 }]);
  await q.replaceAll([{ id: 'x', serverId: 99 }]);
  const list = await q.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].serverId, 99);
});

test('storage key is scoped (not colliding with unrelated keys)', () => {
  assert.match(__test__.STORAGE_KEY, /fm-cleanup-queue/);
});
