// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155 unit tests: PanoptaClient.addServerTag / removeServerTag.
// Read-modify-write semantics against a stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanoptaClient } from '../../extension/src/lib/panopta-client.js';

function makeFetch(server) {
  let currentServer = { ...server };
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'PUT') {
      // Reflect the updated state back so a subsequent GET would see it.
      currentServer = { ...JSON.parse(init.body) };
      return {
        ok: true, status: 200, url,
        headers: { get: () => 'application/json' },
        json: async () => currentServer,
        text: async () => JSON.stringify(currentServer)
      };
    }
    return {
      ok: true, status: 200, url,
      headers: { get: () => 'application/json' },
      json: async () => currentServer,
      text: async () => JSON.stringify(currentServer)
    };
  };
  return { fetchFn, calls };
}

test('addServerTag merges new tag into existing list', async () => {
  const { fetchFn, calls } = makeFetch({ id: 1, name: 's1', tags: ['prod'] });
  const client = new PanoptaClient({ apiKey: 'X', fetch: fetchFn });
  const r = await client.addServerTag(1, ['needs-review']);
  // 1 GET + 1 PUT
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual(calls[1].body.tags, ['prod', 'needs-review']);
  assert.deepEqual(r.addedTags, ['needs-review']);
  assert.deepEqual(r.tagsAfter, ['prod', 'needs-review']);
});

test('addServerTag idempotent: already-present tag short-circuits (no PUT)', async () => {
  const { fetchFn, calls } = makeFetch({ id: 1, tags: ['needs-review'] });
  const client = new PanoptaClient({ apiKey: 'X', fetch: fetchFn });
  const r = await client.addServerTag(1, ['needs-review']);
  assert.equal(calls.length, 1); // GET only
  assert.deepEqual(r.addedTags, []);
});

test('addServerTag rejects empty list', async () => {
  const { fetchFn } = makeFetch({ id: 1, tags: [] });
  const client = new PanoptaClient({ apiKey: 'X', fetch: fetchFn });
  await assert.rejects(() => client.addServerTag(1, []), /at least one/i);
});

test('removeServerTag drops only matching tags', async () => {
  const { fetchFn, calls } = makeFetch({ id: 1, tags: ['a', 'b', 'c'] });
  const client = new PanoptaClient({ apiKey: 'X', fetch: fetchFn });
  const r = await client.removeServerTag(1, ['b']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.tags, ['a', 'c']);
  assert.deepEqual(r.removedTags, ['b']);
});

test('removeServerTag idempotent: missing tag short-circuits (no PUT)', async () => {
  const { fetchFn, calls } = makeFetch({ id: 1, tags: ['a'] });
  const client = new PanoptaClient({ apiKey: 'X', fetch: fetchFn });
  const r = await client.removeServerTag(1, ['nope']);
  assert.equal(calls.length, 1);
  assert.deepEqual(r.removedTags, []);
});

test('addServerTag accepts a single string tag', async () => {
  const { fetchFn, calls } = makeFetch({ id: 1, tags: [] });
  const client = new PanoptaClient({ apiKey: 'X', fetch: fetchFn });
  const r = await client.addServerTag(1, 'solo');
  assert.deepEqual(r.addedTags, ['solo']);
  assert.deepEqual(calls[1].body.tags, ['solo']);
});
