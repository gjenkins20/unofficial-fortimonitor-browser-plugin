import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers, dispatch } from '../src/background/message-handlers.js';
import { Queue } from '../src/lib/queue.js';
import { createStorageMock } from './fixtures/chrome-mocks.js';
import { FortimonitorError } from '../src/lib/fortimonitor-client.js';

function freshQueue() {
  return new Queue({ storage: createStorageMock() });
}

function fakeClient({ portsByServer = {}, saveImpl } = {}) {
  return {
    async getDevicePorts(id) {
      const ports = portsByServer[id];
      if (!ports) throw new FortimonitorError('not found', { status: 404, phase: 'read' });
      return { filterType: 'all', portFilters: { searchTerm: '', filters: [] }, ports };
    },
    async savePortSelection(args) {
      return (saveImpl ?? (async () => ({ success: true })))(args);
    }
  };
}

test('createHandlers requires client and queue', () => {
  assert.throws(() => createHandlers({}), TypeError);
  assert.throws(() => createHandlers({ client: fakeClient() }), TypeError);
});

test('scan-devices returns fingerprint groups', async () => {
  const handlers = createHandlers({
    client: fakeClient({
      portsByServer: {
        1: [{ name: 'wan2', admin_status: 'up', oper_status: 'down' }],
        2: [{ name: 'wan2', admin_status: 'up', oper_status: 'down' }]
      }
    }),
    queue: freshQueue()
  });
  const out = await handlers['scan-devices']({ serverIds: [1, 2] });
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].devices.length, 2);
});

test('scan-devices emits scan:progress events', async () => {
  const events = [];
  const handlers = createHandlers({
    client: fakeClient({ portsByServer: { 1: [{ name: 'a', admin_status: 'up', oper_status: 'up' }] } }),
    queue: freshQueue(),
    events: { emit: (name, payload) => events.push({ name, payload }) }
  });
  await handlers['scan-devices']({ serverIds: [1] });
  assert.ok(events.some((e) => e.name === 'scan:progress'));
});

test('queue:add-many and queue:list roundtrip', async () => {
  const handlers = createHandlers({ client: fakeClient(), queue: freshQueue() });
  await handlers['queue:add-many']({
    entries: [{ serverId: 1, intendedAction: { portSelectionType: 'manual', selectedIndices: [], totalPortCount: 0 } }]
  });
  const list = await handlers['queue:list']();
  assert.equal(list.length, 1);
});

test('queue:clear empties', async () => {
  const q = freshQueue();
  const handlers = createHandlers({ client: fakeClient(), queue: q });
  await handlers['queue:add-many']({ entries: [{ serverId: 1 }] });
  await handlers['queue:clear']();
  const list = await q.list();
  assert.equal(list.length, 0);
});

test('execute-queue runs each entry and updates its status in the queue', async () => {
  const q = freshQueue();
  await q.addMany([
    { serverId: 1, status: 'pending', intendedAction: { portSelectionType: 'manual', selectedIndices: ['0'], totalPortCount: 1 } },
    { serverId: 2, status: 'pending', intendedAction: { portSelectionType: 'manual', selectedIndices: ['0'], totalPortCount: 1 } }
  ]);
  const handlers = createHandlers({
    client: fakeClient({ saveImpl: async () => ({ success: true }) }),
    queue: q
  });
  const { results } = await handlers['execute-queue']({});
  assert.equal(results.length, 2);
  for (const r of results) assert.equal(r.status, 'succeeded');
  const list = await q.list();
  for (const e of list) assert.equal(e.status, 'succeeded');
});

test('execute-queue marks failing entries and records lastError', async () => {
  const q = freshQueue();
  await q.addMany([{ serverId: 1, status: 'pending', intendedAction: { portSelectionType: 'manual', selectedIndices: ['0'], totalPortCount: 1 } }]);
  const handlers = createHandlers({
    client: fakeClient({ saveImpl: async () => { throw new FortimonitorError('forbidden', { status: 403, phase: 'write' }); } }),
    queue: q
  });
  await handlers['execute-queue']({});
  const list = await q.list();
  assert.equal(list[0].status, 'failed');
  assert.match(list[0].lastError, /forbidden/);
});

test('execute-queue refuses to start while a run is active', async () => {
  const q = freshQueue();
  await q.addMany([{ serverId: 1, status: 'pending', intendedAction: { portSelectionType: 'manual', selectedIndices: ['0'], totalPortCount: 1 } }]);
  let release;
  const gate = new Promise((r) => { release = r; });
  const handlers = createHandlers({
    client: fakeClient({ saveImpl: async () => { await gate; return { success: true }; } }),
    queue: q
  });
  const first = handlers['execute-queue']({});
  await assert.rejects(handlers['execute-queue']({}), /already running/);
  release();
  await first;
});

test('run-status reflects idle/active transitions', async () => {
  const q = freshQueue();
  await q.addMany([{ serverId: 1, status: 'pending', intendedAction: { portSelectionType: 'manual', selectedIndices: ['0'], totalPortCount: 1 } }]);
  const handlers = createHandlers({ client: fakeClient(), queue: q });
  const idle = await handlers['run-status']();
  assert.equal(idle.running, false);
  await handlers['execute-queue']({});
  const after = await handlers['run-status']();
  assert.equal(after.running, false);
});

test('dispatch routes by message type', async () => {
  const handlers = createHandlers({ client: fakeClient(), queue: freshQueue() });
  const result = await dispatch(handlers, { type: 'queue:list', payload: {} });
  assert.deepEqual(result, []);
});

test('dispatch throws on unknown message type', async () => {
  const handlers = createHandlers({ client: fakeClient(), queue: freshQueue() });
  await assert.rejects(dispatch(handlers, { type: 'nope' }), /Unknown message type/);
});
