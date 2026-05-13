import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOmniSearchHandlers } from '../src/background/omni-search-handlers.js';

// =====================================================================
// FMN-206: lookup-by-ids handler
// =====================================================================
//
// The handler reads exclusively from the warm omni-search cache. To
// exercise it we first prime the cache via omni-search:refresh with a
// stubbed PanoptaClient factory that returns the servers we want
// cached, then assert lookup-by-ids returns the expected subset.
//
// Each test uses a unique tenantOrigin so the module-level memCache
// doesn't bleed across tests.

// Minimal chrome.storage.session stub. The handler's storage I/O is
// wrapped in try/catch so missing chrome would also work, but providing
// a real stub exercises the cache-write path too.
const sessionStore = new Map();
globalThis.chrome = globalThis.chrome ?? {
  storage: {
    session: {
      async get(key) {
        if (typeof key === 'string') {
          return sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {};
        }
        return {};
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
      }
    }
  }
};

function makeServersWithTags() {
  return [
    {
      url: 'https://api2.panopta.com/v2/server/100',
      name: 'fgt-branch-001',
      tags: ['prod', 'firewall']
    },
    {
      url: 'https://api2.panopta.com/v2/server/101',
      name: 'fgt-branch-002',
      tags: ['prod']
    },
    {
      url: 'https://api2.panopta.com/v2/server/102',
      name: 'no-tags-server',
      tags: []
    }
  ];
}

function makeOmniSearchHandlers(servers, origin) {
  const stubClient = {
    async listAllServers() { return servers; },
    async _paginatedList() { return []; }
  };
  return createOmniSearchHandlers({
    getClient: async () => stubClient
  });
}

async function primeCache(handlers, tenantOrigin) {
  await handlers['omni-search:refresh']({ tenantOrigin });
}

// ---------- omni-search:lookup-by-ids ----------

test('lookup-by-ids returns name + tags for cached IDs', async () => {
  const origin = 'test-lookup-1.example.com';
  const handlers = makeOmniSearchHandlers(makeServersWithTags(), origin);
  await primeCache(handlers, origin);

  const out = await handlers['omni-search:lookup-by-ids']({
    serverIds: [100, 101, 102],
    tenantOrigin: origin
  });

  assert.deepEqual(out.byServerId[100], { name: 'fgt-branch-001', tags: ['prod', 'firewall'] });
  assert.deepEqual(out.byServerId[101], { name: 'fgt-branch-002', tags: ['prod'] });
  assert.deepEqual(out.byServerId[102], { name: 'no-tags-server', tags: [] });
});

test('lookup-by-ids omits IDs not present in the cache', async () => {
  const origin = 'test-lookup-2.example.com';
  const handlers = makeOmniSearchHandlers(makeServersWithTags(), origin);
  await primeCache(handlers, origin);

  const out = await handlers['omni-search:lookup-by-ids']({
    serverIds: [100, 999, 1000],
    tenantOrigin: origin
  });

  assert.ok(out.byServerId[100], 'cached ID present');
  assert.equal(out.byServerId[999], undefined, 'unknown ID omitted');
  assert.equal(out.byServerId[1000], undefined, 'unknown ID omitted');
});

test('lookup-by-ids accepts string IDs (coerced to numbers)', async () => {
  const origin = 'test-lookup-3.example.com';
  const handlers = makeOmniSearchHandlers(makeServersWithTags(), origin);
  await primeCache(handlers, origin);

  const out = await handlers['omni-search:lookup-by-ids']({
    serverIds: ['100', '101'],
    tenantOrigin: origin
  });

  assert.ok(out.byServerId[100]);
  assert.ok(out.byServerId[101]);
});

test('lookup-by-ids returns empty map for empty input', async () => {
  const origin = 'test-lookup-4.example.com';
  const handlers = makeOmniSearchHandlers(makeServersWithTags(), origin);
  await primeCache(handlers, origin);

  const out = await handlers['omni-search:lookup-by-ids']({
    serverIds: [],
    tenantOrigin: origin
  });
  assert.deepEqual(out.byServerId, {});
});

test('lookup-by-ids ignores non-array serverIds', async () => {
  const origin = 'test-lookup-5.example.com';
  const handlers = makeOmniSearchHandlers(makeServersWithTags(), origin);
  await primeCache(handlers, origin);

  const out = await handlers['omni-search:lookup-by-ids']({ tenantOrigin: origin });
  assert.deepEqual(out.byServerId, {});
});

test('lookup-by-ids returns empty map when cache is cold (no refresh has run)', async () => {
  // Fresh, unique tenantOrigin nobody has primed.
  const origin = 'test-lookup-cold-' + Math.random().toString(36).slice(2);
  // Build handlers but DON'T call refresh.
  const handlers = createOmniSearchHandlers({
    getClient: async () => {
      throw new Error('lookup-by-ids must never call the client factory');
    }
  });
  const out = await handlers['omni-search:lookup-by-ids']({
    serverIds: [100, 101],
    tenantOrigin: origin
  });
  assert.deepEqual(out.byServerId, {});
});

test('lookup-by-ids never triggers a cache build (no network fetch)', async () => {
  // Even with serverIds and a cold cache, lookup-by-ids must not invoke
  // the factory. Verified by giving it a factory that throws.
  const origin = 'test-lookup-no-build-' + Math.random().toString(36).slice(2);
  let factoryCalled = 0;
  const handlers = createOmniSearchHandlers({
    getClient: async () => {
      factoryCalled += 1;
      throw new Error('factory must not be called');
    }
  });
  const out = await handlers['omni-search:lookup-by-ids']({
    serverIds: [1, 2, 3],
    tenantOrigin: origin
  });
  assert.equal(factoryCalled, 0);
  assert.deepEqual(out.byServerId, {});
});

test('lookup-by-ids tags field is a copy (caller mutation does not leak into cache)', async () => {
  const origin = 'test-lookup-copy.example.com';
  const handlers = makeOmniSearchHandlers(makeServersWithTags(), origin);
  await primeCache(handlers, origin);

  const out1 = await handlers['omni-search:lookup-by-ids']({
    serverIds: [100],
    tenantOrigin: origin
  });
  out1.byServerId[100].tags.push('mutated');

  const out2 = await handlers['omni-search:lookup-by-ids']({
    serverIds: [100],
    tenantOrigin: origin
  });
  assert.deepEqual(out2.byServerId[100].tags, ['prod', 'firewall'], 'second lookup unchanged');
});
