import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRetryable,
  lookupOne,
  lookupBatch,
  confirmServerId,
  createServerLookupHandlers
} from '../src/background/server-lookup-handlers.js';
import { PanoptaError } from '../src/lib/panopta-client.js';

// Synthetic client. Each test wires up only what it needs.
function makeClient(impl = {}) {
  return {
    lookupServersByName: impl.lookupServersByName ?? (async () => { throw new Error('not stubbed'); }),
    getServer: impl.getServer ?? (async () => { throw new Error('not stubbed'); })
  };
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

test('lookupOne: 1 match -> status=found with serverId', async () => {
  const client = makeClient({ lookupServersByName: async () => [{ id: 42, name: 'x', resourceUrl: 'u' }] });
  const r = await lookupOne(client, 'x');
  assert.equal(r.status, 'found');
  assert.equal(r.serverId, 42);
  assert.equal(r.matches.length, 1);
});

test('lookupOne: 0 matches -> status=not_found', async () => {
  const client = makeClient({ lookupServersByName: async () => [] });
  const r = await lookupOne(client, 'x');
  assert.equal(r.status, 'not_found');
  assert.equal(r.matches.length, 0);
});

test('lookupOne: 2+ matches -> status=ambiguous with all candidates', async () => {
  const client = makeClient({ lookupServersByName: async () => [
    { id: 1, name: 'x', resourceUrl: 'u1' },
    { id: 2, name: 'x', resourceUrl: 'u2' }
  ]});
  const r = await lookupOne(client, 'x');
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.matches.length, 2);
});

// ----- confirmServerId (FMN-113) -------------------------------------

test('confirmServerId: 200 -> found with server payload', async () => {
  const client = makeClient({ getServer: async (id) => ({ id, name: `srv-${id}` }) });
  const r = await confirmServerId(client, 7);
  assert.equal(r.status, 'found');
  assert.equal(r.serverId, 7);
  assert.equal(r.server.name, 'srv-7');
});

test('confirmServerId: 404 -> not_found (caller surfaces, does not throw)', async () => {
  const client = makeClient({ getServer: async () => {
    throw new PanoptaError('not found', { phase: 'read', status: 404 });
  }});
  const r = await confirmServerId(client, 42);
  assert.equal(r.status, 'not_found');
  assert.equal(r.serverId, 42);
});

test('confirmServerId: non-404 errors propagate', async () => {
  const client = makeClient({ getServer: async () => {
    throw new PanoptaError('boom', { phase: 'read', status: 500 });
  }});
  await assert.rejects(() => confirmServerId(client, 42), /boom/);
});

// ----- lookupBatch (FMN-113 entries shape) ---------------------------

test('lookupBatch: name entries hit lookupServersByName; URL/ID entries always confirm via getServer; all hits use status=found', async () => {
  let nameCalls = 0;
  let getServerCalls = 0;
  const client = makeClient({
    lookupServersByName: async (name) => {
      nameCalls++;
      return name === 'a' ? [{ id: 1, name: 'a', resourceUrl: 'ua' }] : [];
    },
    getServer: async (id) => { getServerCalls++; return { id, name: `srv-${id}` }; }
  });
  const entries = [
    { kind: 'name', raw: 'a', name: 'a' },
    { kind: 'url', raw: 'https://fortimonitor.forticloud.com/instance/42/x', serverId: 42 },
    { kind: 'id', raw: '99', serverId: 99 }
  ];
  const results = await lookupBatch({ entries, client, concurrency: 2 });
  assert.equal(nameCalls, 1, 'one call for the one name entry');
  assert.equal(getServerCalls, 2, 'one getServer call per URL/ID entry');
  assert.equal(results.length, 3);
  // All three are status=found; the kind field carries the input source.
  assert.equal(results[0].status, 'found');
  assert.equal(results[0].serverId, 1);
  assert.equal(results[1].status, 'found');
  assert.equal(results[1].serverId, 42);
  assert.equal(results[1].kind, 'url');
  assert.equal(results[2].status, 'found');
  assert.equal(results[2].serverId, 99);
  assert.equal(results[2].kind, 'id');
});

test('lookupBatch: skipConfirm bypasses getServer (test-only escape hatch)', async () => {
  let getServerCalls = 0;
  const client = makeClient({
    getServer: async () => { getServerCalls++; return { id: 1 }; }
  });
  const entries = [
    { kind: 'url', raw: '/instance/42/x', serverId: 42 },
    { kind: 'id', raw: '99', serverId: 99 }
  ];
  const results = await lookupBatch({ entries, client, skipConfirm: true });
  assert.equal(getServerCalls, 0);
  assert.equal(results[0].status, 'found');
  assert.equal(results[1].status, 'found');
});

test('lookupBatch: URL/ID entries fire getServer; 404 surfaces as not_found', async () => {
  let getServerCalls = 0;
  const client = makeClient({
    getServer: async (id) => {
      getServerCalls++;
      if (id === 99) throw new PanoptaError('nope', { phase: 'read', status: 404 });
      return { id, name: `srv-${id}` };
    }
  });
  const entries = [
    { kind: 'url', raw: '/instance/42/x', serverId: 42 },
    { kind: 'id', raw: '99', serverId: 99 }
  ];
  const results = await lookupBatch({ entries, client });
  assert.equal(getServerCalls, 2);
  assert.equal(results[0].status, 'found');
  assert.equal(results[1].status, 'not_found');
});

test('lookupBatch: dedupes URL+ID for the same server (one confirm, fans out)', async () => {
  let getServerCalls = 0;
  const client = makeClient({ getServer: async (id) => { getServerCalls++; return { id }; } });
  const entries = [
    { kind: 'url', raw: '/instance/42/x', serverId: 42 },
    { kind: 'id', raw: '42', serverId: 42 },
    { kind: 'id', raw: '99', serverId: 99 }
  ];
  const results = await lookupBatch({ entries, client });
  // Both 42 entries share one resolve; 99 gets its own. Output preserves
  // the original input order, with the shared result fanning out.
  assert.equal(getServerCalls, 2);
  assert.equal(results.length, 3);
  assert.equal(results[0].serverId, 42);
  assert.equal(results[1].serverId, 42);
  assert.equal(results[2].serverId, 99);
});

test('lookupBatch: error on one name entry does not break the others', async () => {
  const client = makeClient({
    lookupServersByName: async (name) => {
      if (name === 'bad') throw new PanoptaError('boom', { phase: 'read', status: 422 });
      return [{ id: 99, name, resourceUrl: 'u' }];
    }
  });
  const entries = [
    { kind: 'name', raw: 'ok', name: 'ok' },
    { kind: 'name', raw: 'bad', name: 'bad' },
    { kind: 'name', raw: 'ok2', name: 'ok2' }
  ];
  const results = await lookupBatch({ entries, client, concurrency: 1 });
  assert.equal(results[0].status, 'found');
  assert.equal(results[1].status, 'error');
  assert.equal(results[1].error, 'boom');
  assert.equal(results[2].status, 'found');
});

test('lookupBatch: empty entries -> empty results', async () => {
  const client = makeClient();
  const results = await lookupBatch({ entries: [], client });
  assert.deepEqual(results, []);
});

test('lookupBatch: emits onEntryStart/onEntryDone per unique entry, kind-aware', async () => {
  const client = makeClient({
    lookupServersByName: async () => [{ id: 1, name: 'x', resourceUrl: 'u' }]
  });
  const startCalls = [];
  const doneCalls = [];
  await lookupBatch({
    entries: [
      { kind: 'name', raw: 'x', name: 'x' },
      { kind: 'name', raw: 'y', name: 'y' },
      { kind: 'name', raw: 'x', name: 'x' }      // dedup'd
    ],
    client,
    onEntryStart: (i, label, kind) => startCalls.push([i, label, kind]),
    onEntryDone: (i, r) => doneCalls.push([i, r.status])
  });
  assert.equal(startCalls.length, 2);
  assert.equal(startCalls[0][2], 'name');
  assert.equal(doneCalls.length, 2);
});

test('lookupBatch: requires array entries + client', async () => {
  await assert.rejects(() => lookupBatch({ entries: 'nope', client: makeClient() }), TypeError);
  await assert.rejects(() => lookupBatch({ entries: [] }), TypeError);
});

// ----- createServerLookupHandlers ------------------------------------

test('createServerLookupHandlers exposes lookup:server-ids and lookup:abort', () => {
  const handlers = createServerLookupHandlers({
    getClient: async () => makeClient()
  });
  assert.equal(typeof handlers['lookup:server-ids'], 'function');
  assert.equal(typeof handlers['lookup:abort'], 'function');
});

test('lookup:server-ids end-to-end with structured entries', async () => {
  const handlers = createServerLookupHandlers({
    getClient: async () => makeClient({
      lookupServersByName: async (name) =>
        name === 'a' ? [{ id: 7, name: 'a', resourceUrl: 'u' }] : [],
      // ID entries always confirm; provide a getServer stub.
      getServer: async (id) => ({ id, name: `srv-${id}` })
    })
  });
  const out = await handlers['lookup:server-ids']({
    entries: [
      { kind: 'name', raw: 'a', name: 'a' },
      { kind: 'name', raw: 'b', name: 'b' },
      { kind: 'id', raw: '99', serverId: 99 }
    ]
  });
  assert.equal(out.results.length, 3);
  assert.equal(out.results[0].status, 'found');
  assert.equal(out.results[0].serverId, 7);
  assert.equal(out.results[1].status, 'not_found');
  assert.equal(out.results[2].status, 'found');
  assert.equal(out.results[2].serverId, 99);
  assert.ok(out.startedAt);
  assert.ok(out.finishedAt);
});

test('lookup:server-ids legacy {names} payload still works (string-list shim)', async () => {
  const handlers = createServerLookupHandlers({
    getClient: async () => makeClient({
      lookupServersByName: async (name) =>
        name === 'a' ? [{ id: 7, name: 'a', resourceUrl: 'u' }] : []
    })
  });
  const out = await handlers['lookup:server-ids']({ names: ['a', 'b'] });
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].status, 'found');
  assert.equal(out.results[1].status, 'not_found');
});

test('lookup:server-ids unconditionally fires getServer for URL/ID entries', async () => {
  let getServerCalls = 0;
  const handlers = createServerLookupHandlers({
    getClient: async () => makeClient({
      getServer: async (id) => { getServerCalls++; return { id }; }
    })
  });
  const out = await handlers['lookup:server-ids']({
    entries: [
      { kind: 'url', raw: '/instance/42/x', serverId: 42 },
      { kind: 'id', raw: '99', serverId: 99 }
    ]
  });
  assert.equal(getServerCalls, 2);
  assert.equal(out.results[0].status, 'found');
  assert.equal(out.results[1].status, 'found');
});

test('lookup:abort with no active run returns aborted=false', async () => {
  const handlers = createServerLookupHandlers({
    getClient: async () => makeClient()
  });
  const r = await handlers['lookup:abort']();
  assert.equal(r.aborted, false);
});

test('lookup:server-ids rejects concurrent runs', async () => {
  let resolveFirst;
  const slow = new Promise((res) => { resolveFirst = res; });
  const handlers = createServerLookupHandlers({
    getClient: async () => makeClient({
      lookupServersByName: async () => { await slow; return []; }
    })
  });
  const inFlight = handlers['lookup:server-ids']({
    entries: [{ kind: 'name', raw: 'a', name: 'a' }]
  });
  await assert.rejects(
    () => handlers['lookup:server-ids']({
      entries: [{ kind: 'name', raw: 'b', name: 'b' }]
    }),
    /already running/
  );
  resolveFirst();
  await inFlight;
});
