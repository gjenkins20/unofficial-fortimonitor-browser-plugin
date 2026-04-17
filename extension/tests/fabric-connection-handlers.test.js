import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeFabricBatch,
  isRetryable,
  createFabricHandlers
} from '../src/background/fabric-connection-handlers.js';
import { PanoptaError } from '../src/lib/panopta-client.js';

// Synthetic client for tests — doesn't touch fetch.
function makeClient(impl) {
  return {
    createFabricConnection: impl,
    listOnsight: async () => [{ id: 1, name: 'A', resourceUrl: 'A' }],
    listServerGroups: async () => [{ id: 2, name: 'B', resourceUrl: 'B' }],
    listOnsightGroups: async () => [],
    testConnection: async () => ({ ok: true, status: 200 })
  };
}

// ----- isRetryable -------------------------------------------------

test('isRetryable: false for null/undefined', () => {
  assert.equal(isRetryable(null), false);
  assert.equal(isRetryable(undefined), false);
});

test('isRetryable: false for AbortError', () => {
  const err = new Error('aborted'); err.name = 'AbortError';
  assert.equal(isRetryable(err), false);
});

test('isRetryable: false for PanoptaError with phase=auth', () => {
  assert.equal(isRetryable(new PanoptaError('bad key', { phase: 'auth', status: 401 })), false);
});

test('isRetryable: true for 500/502/503/504/429/408/425', () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryable(new PanoptaError('x', { phase: 'write', status: s })), true, `status ${s}`);
  }
});

test('isRetryable: false for 400/422/404', () => {
  for (const s of [400, 404, 422]) {
    assert.equal(isRetryable(new PanoptaError('x', { phase: 'write', status: s })), false, `status ${s}`);
  }
});

test('isRetryable: true for unknown error type (network blip)', () => {
  assert.equal(isRetryable(new Error('boom')), true);
});

// ----- executeFabricBatch ----------------------------------------

test('executeFabricBatch happy path: 1 device', async () => {
  const client = makeClient(async () => ({ status: 201, location: 'L', resourceId: '99', body: {} }));
  const results = await executeFabricBatch({
    devices: [{ serial: 'FG1', ip: '10.0.0.1', port: 8013 }],
    onsightUrl: 'A', serverGroupUrl: 'B',
    client
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'succeeded');
  assert.equal(results[0].value.resourceId, '99');
});

test('executeFabricBatch: dry-run does not invoke client', async () => {
  let called = false;
  const client = makeClient(async () => { called = true; return {}; });
  const results = await executeFabricBatch({
    devices: [{ serial: 'FG1', ip: '10.0.0.1', port: 8013 }],
    onsightUrl: 'A', serverGroupUrl: 'B',
    client,
    dryRun: true
  });
  assert.equal(called, false);
  assert.equal(results[0].status, 'succeeded');
  assert.equal(results[0].dryRun, true);
  assert.equal(results[0].preview.upstream_sn, 'FG1');
});

test('executeFabricBatch: per-device failure does not stop batch', async () => {
  let n = 0;
  const client = makeClient(async () => {
    n++;
    if (n === 2) throw new PanoptaError('500 boom', { phase: 'write', status: 500 });
    return { status: 201, resourceId: String(n), body: {} };
  });
  const results = await executeFabricBatch({
    devices: [
      { serial: 'FG1', ip: '10.0.0.1', port: 8013 },
      { serial: 'FG2', ip: '10.0.0.2', port: 8013 },
      { serial: 'FG3', ip: '10.0.0.3', port: 8013 }
    ],
    onsightUrl: 'A', serverGroupUrl: 'B',
    client,
    maxAttempts: 1, // don't retry, fail-fast for this test
    sleep: async () => {}
  });
  assert.equal(results.length, 3);
  assert.equal(results[0].status, 'succeeded');
  assert.equal(results[1].status, 'failed');
  assert.equal(results[2].status, 'succeeded');
});

test('executeFabricBatch: emits onEntryStart + onEntryDone for each device', async () => {
  const client = makeClient(async () => ({ status: 201, resourceId: 'X', body: {} }));
  const starts = [];
  const dones = [];
  await executeFabricBatch({
    devices: [
      { serial: 'FG1', ip: '10.0.0.1', port: 8013 },
      { serial: 'FG2', ip: '10.0.0.2', port: 8013 }
    ],
    onsightUrl: 'A', serverGroupUrl: 'B',
    client,
    onEntryStart: (i, d) => starts.push(d.serial),
    onEntryDone: (i, r) => dones.push(r.device.serial)
  });
  assert.deepEqual(starts.sort(), ['FG1', 'FG2']);
  assert.deepEqual(dones.sort(), ['FG1', 'FG2']);
});

test('executeFabricBatch: retries transient errors then succeeds', async () => {
  let n = 0;
  const client = makeClient(async () => {
    n++;
    if (n < 3) throw new PanoptaError('503', { phase: 'write', status: 503 });
    return { status: 201, resourceId: 'OK', body: {} };
  });
  const results = await executeFabricBatch({
    devices: [{ serial: 'FG1', ip: '10.0.0.1', port: 8013 }],
    onsightUrl: 'A', serverGroupUrl: 'B',
    client,
    maxAttempts: 5,
    sleep: async () => {}
  });
  assert.equal(results[0].status, 'succeeded');
  assert.equal(results[0].attempts, 3);
});

test('executeFabricBatch: requires devices array', async () => {
  await assert.rejects(() => executeFabricBatch({ onsightUrl: 'A', serverGroupUrl: 'B', client: makeClient(async () => {}) }), TypeError);
});

test('executeFabricBatch: requires onsightUrl + serverGroupUrl', async () => {
  await assert.rejects(() => executeFabricBatch({ devices: [], serverGroupUrl: 'B', client: makeClient(async () => {}) }), TypeError);
  await assert.rejects(() => executeFabricBatch({ devices: [], onsightUrl: 'A', client: makeClient(async () => {}) }), TypeError);
});

// ----- createFabricHandlers --------------------------------------

test('createFabricHandlers: panopta:test-connection forwards to client', async () => {
  const handlers = createFabricHandlers({
    getClient: async () => makeClient(async () => ({}))
  });
  const result = await handlers['panopta:test-connection']({});
  assert.equal(result.ok, true);
});

test('createFabricHandlers: panopta:list-onsight returns items', async () => {
  const handlers = createFabricHandlers({
    getClient: async () => makeClient(async () => ({}))
  });
  const items = await handlers['panopta:list-onsight']({});
  assert.equal(items[0].id, 1);
});

test('createFabricHandlers: fc:create-batch dry-run returns previews', async () => {
  const handlers = createFabricHandlers({
    getClient: async () => makeClient(async () => ({}))
  });
  const result = await handlers['fc:create-batch']({
    devices: [{ serial: 'FGABCDEF12', ip: '10.0.0.1', port: 8013 }],
    onsightUrl: 'A', serverGroupUrl: 'B',
    dryRun: true
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].dryRun, true);
});

test('createFabricHandlers: fc:create-batch live mode invokes client', async () => {
  let posted = 0;
  const handlers = createFabricHandlers({
    getClient: async () => makeClient(async () => { posted++; return { status: 201, resourceId: 'X', body: {} }; })
  });
  const result = await handlers['fc:create-batch']({
    devices: [{ serial: 'FGABCDEF12', ip: '10.0.0.1', port: 8013 }],
    onsightUrl: 'A', serverGroupUrl: 'B',
    dryRun: false
  });
  assert.equal(posted, 1);
  assert.equal(result.results[0].status, 'succeeded');
});

test('createFabricHandlers: fc:abort with no active run returns aborted=false', async () => {
  const handlers = createFabricHandlers({
    getClient: async () => makeClient(async () => ({}))
  });
  const result = await handlers['fc:abort']({});
  assert.equal(result.aborted, false);
});
