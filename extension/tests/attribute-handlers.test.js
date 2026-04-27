import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planBatch,
  executeBatch,
  isRetryable
} from '../src/background/attribute-handlers.js';
import { PanoptaError } from '../src/lib/panopta-client.js';

const TYPE_A = 'https://api2.panopta.com/v2/server_attribute_type/1';
const TYPE_B = 'https://api2.panopta.com/v2/server_attribute_type/2';

function fakeClient({ snapshots = {}, snapshotErrors = {}, createImpl, deleteImpl } = {}) {
  return {
    async listServerAttributes(serverId) {
      if (snapshotErrors[serverId]) throw snapshotErrors[serverId];
      return snapshots[serverId] ?? [];
    },
    async createServerAttribute(serverId, { typeUrl, value }) {
      if (createImpl) return createImpl(serverId, { typeUrl, value });
      return { resourceId: `new-${serverId}-${typeUrl.split('/').pop()}` };
    },
    async deleteServerAttribute(refOrIds) {
      if (deleteImpl) return deleteImpl(refOrIds);
      return { status: 204 };
    }
  };
}

const RESOLVED_A = { input: '1', status: 'resolved', serverId: 1, displayName: '1' };
const RESOLVED_B = { input: '2', status: 'resolved', serverId: 2, displayName: '2' };
const UNRESOLVED = { input: 'missing', status: 'error', error: 'Name not found' };

// ----- planBatch with multiple attributes -------------------------------

test('planBatch: cross-product produces N×M rows tagged with attrIndex', async () => {
  const client = fakeClient({
    snapshots: {
      1: [{ typeUrl: TYPE_A, value: 'old', resourceUrl: 'r1', id: 11 }],
      2: []
    }
  });
  const plan = await planBatch({
    targets: [RESOLVED_A, RESOLVED_B],
    attributes: [
      { operation: 'set', typeUrl: TYPE_A, typeName: 'A', value: 'new' },
      { operation: 'set', typeUrl: TYPE_B, typeName: 'B', value: 'fresh' }
    ],
    client
  });
  // 2 servers × 2 attrs = 4 plan rows.
  assert.equal(plan.length, 4);
  // Server 1 × Attr A: existing=old, new=new → replace.
  assert.equal(plan[0].serverId, 1);
  assert.equal(plan[0].attrIndex, 0);
  assert.equal(plan[0].plan, 'replace');
  assert.equal(plan[0].typeUrl, TYPE_A);
  // Server 1 × Attr B: no existing → add.
  assert.equal(plan[1].serverId, 1);
  assert.equal(plan[1].attrIndex, 1);
  assert.equal(plan[1].plan, 'add');
  // Server 2 × Attr A: no existing → add.
  assert.equal(plan[2].serverId, 2);
  assert.equal(plan[2].attrIndex, 0);
  assert.equal(plan[2].plan, 'add');
  // Server 2 × Attr B: no existing → add.
  assert.equal(plan[3].plan, 'add');
});

test('planBatch: skip when set value already matches', async () => {
  const client = fakeClient({
    snapshots: {
      1: [{ typeUrl: TYPE_A, value: 'same', resourceUrl: 'r1', id: 11 }]
    }
  });
  const plan = await planBatch({
    targets: [RESOLVED_A],
    attributes: [{ operation: 'set', typeUrl: TYPE_A, typeName: 'A', value: 'same' }],
    client
  });
  assert.equal(plan[0].plan, 'skip');
});

test('planBatch: remove on missing attribute is skip', async () => {
  const client = fakeClient({ snapshots: { 1: [] } });
  const plan = await planBatch({
    targets: [RESOLVED_A],
    attributes: [{ operation: 'remove', typeUrl: TYPE_A, typeName: 'A' }],
    client
  });
  assert.equal(plan[0].plan, 'skip');
});

test('planBatch: remove on present attribute is remove', async () => {
  const client = fakeClient({
    snapshots: {
      1: [{ typeUrl: TYPE_A, value: 'x', resourceUrl: 'r1', id: 11 }]
    }
  });
  const plan = await planBatch({
    targets: [RESOLVED_A],
    attributes: [{ operation: 'remove', typeUrl: TYPE_A, typeName: 'A' }],
    client
  });
  assert.equal(plan[0].plan, 'remove');
});

test('planBatch: unresolved targets fan out as error rows for each attribute', async () => {
  const client = fakeClient({});
  const plan = await planBatch({
    targets: [UNRESOLVED, RESOLVED_A],
    attributes: [
      { operation: 'set', typeUrl: TYPE_A, typeName: 'A', value: 'a' },
      { operation: 'set', typeUrl: TYPE_B, typeName: 'B', value: 'b' }
    ],
    client
  });
  assert.equal(plan.length, 4);
  // Both rows for the unresolved target are error.
  assert.equal(plan[0].plan, 'error');
  assert.equal(plan[0].attrIndex, 0);
  assert.equal(plan[1].plan, 'error');
  assert.equal(plan[1].attrIndex, 1);
  // The resolved target's rows plan normally.
  assert.equal(plan[2].plan, 'add');
  assert.equal(plan[3].plan, 'add');
});

test('planBatch: snapshot fetch failure becomes error rows for that server', async () => {
  const err = new PanoptaError('boom', { status: 500, phase: 'write' });
  const client = fakeClient({ snapshotErrors: { 1: err } });
  const plan = await planBatch({
    targets: [RESOLVED_A],
    attributes: [{ operation: 'set', typeUrl: TYPE_A, typeName: 'A', value: 'a' }],
    client
  });
  assert.equal(plan[0].plan, 'error');
  assert.equal(plan[0].error, 'boom');
});

test('planBatch: rejects empty attributes array', async () => {
  await assert.rejects(
    () => planBatch({ targets: [], attributes: [], client: fakeClient() }),
    /attributes must be a non-empty array/
  );
});

test('planBatch: rejects bad operation', async () => {
  await assert.rejects(
    () => planBatch({
      targets: [],
      attributes: [{ operation: 'foo', typeUrl: TYPE_A, value: 'x' }],
      client: fakeClient()
    }),
    /operation must be 'set' or 'remove'/
  );
});

test('planBatch: rejects missing typeUrl', async () => {
  await assert.rejects(
    () => planBatch({
      targets: [],
      attributes: [{ operation: 'set', value: 'x' }],
      client: fakeClient()
    }),
    /typeUrl is required/
  );
});

test('planBatch: rejects set without value', async () => {
  await assert.rejects(
    () => planBatch({
      targets: [],
      attributes: [{ operation: 'set', typeUrl: TYPE_A }],
      client: fakeClient()
    }),
    /value is required/
  );
});

// ----- executeBatch reads typeUrl from each row -------------------------

test('executeBatch: writes use row.typeUrl, not a shared parameter', async () => {
  const calls = [];
  const client = fakeClient({
    createImpl: (serverId, { typeUrl, value }) => {
      calls.push({ serverId, typeUrl, value });
      return { resourceId: 99 };
    }
  });
  const plan = [
    { serverId: 1, attrIndex: 0, typeUrl: TYPE_A, plan: 'add', newValue: 'a', input: '1' },
    { serverId: 1, attrIndex: 1, typeUrl: TYPE_B, plan: 'add', newValue: 'b', input: '1' }
  ];
  const out = await executeBatch({ plan, client, concurrency: 1 });
  assert.equal(out.length, 2);
  assert.equal(out[0].status, 'succeeded');
  assert.equal(out[1].status, 'succeeded');
  assert.deepEqual(calls.map((c) => c.typeUrl), [TYPE_A, TYPE_B]);
  assert.deepEqual(calls.map((c) => c.value), ['a', 'b']);
});

test('executeBatch: row missing typeUrl becomes failed without throwing', async () => {
  const plan = [{ serverId: 1, attrIndex: 0, plan: 'add', newValue: 'x', input: '1' }];
  const out = await executeBatch({ plan, client: fakeClient(), concurrency: 1 });
  assert.equal(out[0].status, 'failed');
  assert.match(out[0].error, /missing typeUrl/);
});

test('executeBatch: skip and error rows pass through', async () => {
  const plan = [
    { serverId: 1, attrIndex: 0, typeUrl: TYPE_A, plan: 'skip', input: '1' },
    { serverId: 1, attrIndex: 1, typeUrl: TYPE_B, plan: 'error', error: 'gone', input: '1' }
  ];
  const out = await executeBatch({ plan, client: fakeClient(), concurrency: 1 });
  assert.equal(out[0].status, 'skipped');
  assert.equal(out[1].status, 'error');
});

test('executeBatch: replace deletes existing then creates new', async () => {
  const calls = [];
  const client = fakeClient({
    createImpl: (serverId, { typeUrl, value }) => {
      calls.push({ kind: 'create', serverId, typeUrl, value });
      return { resourceId: 'new-id' };
    },
    deleteImpl: (refOrIds) => {
      calls.push({ kind: 'delete', refOrIds });
      return { status: 204 };
    }
  });
  const plan = [{
    serverId: 1, attrIndex: 0, typeUrl: TYPE_A,
    plan: 'replace', newValue: 'new', input: '1',
    existing: { resourceUrl: 'old-resource-url', id: 42, value: 'old' }
  }];
  const out = await executeBatch({ plan, client, concurrency: 1 });
  assert.equal(out[0].status, 'succeeded');
  assert.equal(out[0].deleted, 42);
  assert.equal(out[0].created, 'new-id');
  assert.deepEqual(calls.map((c) => c.kind), ['delete', 'create']);
});

// ----- isRetryable boundaries unchanged --------------------------------

test('isRetryable: auth phase is not retryable', () => {
  const err = new PanoptaError('nope', { status: 405, phase: 'auth' });
  assert.equal(isRetryable(err), false);
});

test('isRetryable: 500 retryable', () => {
  const err = new PanoptaError('boom', { status: 500, phase: 'write' });
  assert.equal(isRetryable(err), true);
});
