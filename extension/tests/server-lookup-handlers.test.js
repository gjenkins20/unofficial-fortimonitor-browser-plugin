import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRetryable,
  lookupOne,
  lookupBatch,
  createServerLookupHandlers
} from '../src/background/server-lookup-handlers.js';
import { PanoptaError } from '../src/lib/panopta-client.js';

// Synthetic client. lookupServersByName returns whatever the per-name impl
// returns; tests substitute the impl per scenario.
function makeClient(impl) {
  return { lookupServersByName: impl };
}

// ----- isRetryable ---------------------------------------------------

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

test('isRetryable: true for transient HTTP statuses', () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryable(new PanoptaError('x', { phase: 'read', status: s })), true, `status ${s}`);
  }
});

test('isRetryable: false for permanent HTTP statuses', () => {
  for (const s of [400, 404, 422]) {
    assert.equal(isRetryable(new PanoptaError('x', { phase: 'read', status: s })), false, `status ${s}`);
  }
});

// ----- lookupOne -----------------------------------------------------

test('lookupOne: 1 match → status=found with serverId', async () => {
  const client = makeClient(async () => [{ id: 42, name: 'x', resourceUrl: 'u' }]);
  const r = await lookupOne(client, 'x');
  assert.equal(r.status, 'found');
  assert.equal(r.serverId, 42);
  assert.equal(r.matches.length, 1);
});

test('lookupOne: 0 matches → status=not_found', async () => {
  const client = makeClient(async () => []);
  const r = await lookupOne(client, 'x');
  assert.equal(r.status, 'not_found');
  assert.equal(r.matches.length, 0);
  assert.equal(r.serverId, undefined);
});

test('lookupOne: 2+ matches → status=ambiguous with all candidates', async () => {
  const client = makeClient(async () => [
    { id: 1, name: 'x', resourceUrl: 'u1' },
    { id: 2, name: 'x', resourceUrl: 'u2' }
  ]);
  const r = await lookupOne(client, 'x');
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.matches.length, 2);
  assert.equal(r.serverId, undefined);
});

// ----- lookupBatch ---------------------------------------------------

test('lookupBatch: dedupes input - one API call per unique name, fans out to original order', async () => {
  let calls = 0;
  const client = makeClient(async (name) => {
    calls++;
    return name === 'a' ? [{ id: 1, name: 'a', resourceUrl: 'ua' }] : [];
  });
  const results = await lookupBatch({ names: ['a', 'b', 'a', 'a'], client, concurrency: 2 });
  assert.equal(calls, 2, 'one call per unique name');
  assert.equal(results.length, 4, 'one result per original input');
  assert.equal(results[0].status, 'found');
  assert.equal(results[1].status, 'not_found');
  assert.equal(results[2].status, 'found');
  assert.equal(results[3].status, 'found');
  assert.equal(results[0].serverId, 1);
  assert.equal(results[2].serverId, 1);
});

test('lookupBatch: error on one name does not break the others', async () => {
  const client = makeClient(async (name) => {
    if (name === 'bad') throw new PanoptaError('boom', { phase: 'read', status: 422 });
    return [{ id: 99, name, resourceUrl: 'u' }];
  });
  const results = await lookupBatch({ names: ['ok', 'bad', 'ok2'], client, concurrency: 1 });
  assert.equal(results.length, 3);
  assert.equal(results[0].status, 'found');
  assert.equal(results[1].status, 'error');
  assert.equal(results[1].error, 'boom');
  assert.equal(results[2].status, 'found');
});

test('lookupBatch: empty names → empty results', async () => {
  const client = makeClient(async () => { throw new Error('should not be called'); });
  const results = await lookupBatch({ names: [], client });
  assert.deepEqual(results, []);
});

test('lookupBatch: emits onEntryStart/onEntryDone per unique name', async () => {
  const client = makeClient(async () => [{ id: 1, name: 'x', resourceUrl: 'u' }]);
  const startCalls = [];
  const doneCalls = [];
  await lookupBatch({
    names: ['x', 'y', 'x'],
    client,
    onEntryStart: (i, n) => startCalls.push([i, n]),
    onEntryDone: (i, r) => doneCalls.push([i, r.status])
  });
  // Two unique names → two emit pairs (not three).
  assert.equal(startCalls.length, 2);
  assert.equal(doneCalls.length, 2);
});

test('lookupBatch: requires array names + client', async () => {
  await assert.rejects(() => lookupBatch({ names: 'nope', client: makeClient(async () => []) }), TypeError);
  await assert.rejects(() => lookupBatch({ names: [] }), TypeError);
});

// ----- createServerLookupHandlers ------------------------------------

test('createServerLookupHandlers exposes lookup:server-ids and lookup:abort', () => {
  const handlers = createServerLookupHandlers({
    getClient: async () => makeClient(async () => [])
  });
  assert.equal(typeof handlers['lookup:server-ids'], 'function');
  assert.equal(typeof handlers['lookup:abort'], 'function');
});

test("lookup:server-ids end-to-end via factory client", async () => {
  const handlers = createServerLookupHandlers({
    getClient: async () => makeClient(async (name) =>
      name === 'a' ? [{ id: 7, name: 'a', resourceUrl: 'u' }] : []
    )
  });
  const out = await handlers['lookup:server-ids']({ names: ['a', 'b'] });
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].status, 'found');
  assert.equal(out.results[0].serverId, 7);
  assert.equal(out.results[1].status, 'not_found');
  assert.ok(out.startedAt);
  assert.ok(out.finishedAt);
});

test('lookup:abort with no active run returns aborted=false', async () => {
  const handlers = createServerLookupHandlers({
    getClient: async () => makeClient(async () => [])
  });
  const r = await handlers['lookup:abort']();
  assert.equal(r.aborted, false);
});

test('lookup:server-ids rejects concurrent runs', async () => {
  // Slow client so the first run is still in flight when we kick off the second.
  let resolveFirst;
  const slow = new Promise((res) => { resolveFirst = res; });
  const handlers = createServerLookupHandlers({
    getClient: async () => makeClient(async () => { await slow; return []; })
  });
  const inFlight = handlers['lookup:server-ids']({ names: ['a'] });
  await assert.rejects(
    () => handlers['lookup:server-ids']({ names: ['b'] }),
    /already running/
  );
  resolveFirst();
  await inFlight;
});
