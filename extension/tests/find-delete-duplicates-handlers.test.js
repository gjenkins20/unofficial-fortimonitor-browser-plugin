import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFindDeleteDuplicatesHandlers } from '../src/background/find-delete-duplicates-handlers.js';

function fakeClient(pages) {
  // pages: array of server_list arrays, returned by ascending offset
  return {
    calls: [],
    async getJson(path) {
      this.calls.push(path);
      const m = /offset=(\d+)/.exec(path);
      const offset = m ? Number(m[1]) : 0;
      const idx = offset / 100;
      return { server_list: pages[idx] || [] };
    }
  };
}

test('find handler registers the find key', () => {
  const h = createFindDeleteDuplicatesHandlers({ getClient: async () => fakeClient([[]]) });
  assert.ok(typeof h['find-delete-duplicates:find'] === 'function');
});

test('find: runs analyzeDuplicates over the live servers and returns scanned count', async () => {
  const client = fakeClient([[
    { url: '/v2/server/1/', name: 'fw-a', fqdn: '10.0.0.1' },
    { url: '/v2/server/2/', name: 'FW-A', fqdn: '10.0.0.2' },
    { url: '/v2/server/3/', name: 'unique', fqdn: '10.0.0.9' }
  ]]);
  const h = createFindDeleteDuplicatesHandlers({ getClient: async () => client });
  const r = await h['find-delete-duplicates:find']();
  assert.equal(r.scanned, 3);
  assert.equal(r.available, true);
  const nameSet = r.groups.find((g) => g.axis === 'name');
  assert.equal(nameSet.count, 2);
  assert.deepEqual(nameSet.members.map((m) => m.id).sort(), ['1', '2']);
});

test('find: pages through the full server list until a short page', async () => {
  const page0 = Array.from({ length: 100 }, (_, i) => ({ url: `/v2/server/${i + 1}/`, name: `s${i + 1}`, fqdn: '' }));
  const page1 = [{ url: '/v2/server/101/', name: 's1', fqdn: '' }]; // name collides with id 1
  const client = fakeClient([page0, page1]);
  const h = createFindDeleteDuplicatesHandlers({ getClient: async () => client });
  const r = await h['find-delete-duplicates:find']();
  assert.equal(r.scanned, 101);
  assert.equal(client.calls.length, 2); // offset=0 then offset=100, then short page stops
  const nameSet = r.groups.find((g) => g.axis === 'name' && g.value.toLowerCase() === 's1');
  assert.ok(nameSet, 's1 should be a duplicate set across pages');
  assert.deepEqual(nameSet.members.map((m) => m.id).sort(), ['1', '101']);
});

test('find: empty tenant -> available:false with scanned 0', async () => {
  const h = createFindDeleteDuplicatesHandlers({ getClient: async () => fakeClient([[]]) });
  const r = await h['find-delete-duplicates:find']();
  assert.equal(r.scanned, 0);
  assert.equal(r.available, false);
});
