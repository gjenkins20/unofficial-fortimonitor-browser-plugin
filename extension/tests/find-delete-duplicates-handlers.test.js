import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFindDeleteDuplicatesHandlers } from '../src/background/find-delete-duplicates-handlers.js';

function fakeClient(pages, nodes = [], onsights = [], collectors = {}) {
  // pages: array of server_list arrays, returned by ascending offset.
  // nodes/onsights: list responses for /monitoring_node and /onsight.
  // collectors: { '/<type>/<id>': { name } } for the direct GET-fallback.
  return {
    calls: [],
    async getJson(path) {
      this.calls.push(path);
      if (path.startsWith('/monitoring_node?')) return { monitoring_node_list: nodes };
      if (path.startsWith('/onsight?')) return { onsight_list: onsights };
      if (path.startsWith('/server?')) {
        const m = /offset=(\d+)/.exec(path);
        const idx = (m ? Number(m[1]) : 0) / 100;
        return { server_list: pages[idx] || [] };
      }
      // GET-fallback for an arbitrary collector resource (e.g. /fortimanager/9)
      if (collectors[path]) return collectors[path];
      const e = new Error('not found'); e.status = 404; throw e;
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
  const serverCalls = client.calls.filter((p) => p.startsWith('/server?'));
  assert.equal(serverCalls.length, 2); // offset=0 then offset=100, then short page stops
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

test('find: emits find-progress per page with scanned count + total from meta', async () => {
  // Two pages: 100 then 1; total_count from meta = 101.
  const page0 = Array.from({ length: 100 }, (_, i) => ({ url: `/v2/server/${i + 1}/`, name: `s${i + 1}`, fqdn: '' }));
  const page1 = [{ url: '/v2/server/101/', name: 's101', fqdn: '' }];
  const client = fakeClient([page0, page1]);
  client.getJson = async function (path) {
    this.calls.push(path);
    const m = /offset=(\d+)/.exec(path);
    const idx = (m ? Number(m[1]) : 0) / 100;
    return { meta: { total_count: 101 }, server_list: [page0, page1][idx] || [] };
  };
  const events = [];
  const h = createFindDeleteDuplicatesHandlers({
    getClient: async () => client,
    events: { emit: (name, payload) => events.push({ name, payload }) }
  });
  await h['find-delete-duplicates:find']();
  const progress = events.filter((e) => e.name === 'find-delete-duplicates:find-progress');
  assert.equal(progress.length, 2); // one per page
  assert.deepEqual(progress.map((e) => e.payload.scanned), [100, 101]);
  assert.ok(progress.every((e) => e.payload.total === 101));
});

test('find: resolves monitoring locations and classifies intentional vs accidental', async () => {
  const servers = [
    { url: '/v2/server/1/', name: 'acc', fqdn: '1.1.1.1', primary_monitoring_node: 'https://api2/v2/monitoring_node/10' },
    { url: '/v2/server/2/', name: 'acc', fqdn: '1.1.1.2', primary_monitoring_node: 'https://api2/v2/monitoring_node/10' },
    { url: '/v2/server/3/', name: 'intent', fqdn: '2.2.2.1', primary_monitoring_node: 'https://api2/v2/monitoring_node/10' },
    { url: '/v2/server/4/', name: 'intent', fqdn: '2.2.2.2', primary_monitoring_node: 'https://api2/v2/monitoring_node/20' }
  ];
  const nodes = [{ url: '/v2/monitoring_node/10', name: 'Chicago 10' }, { url: '/v2/monitoring_node/20', name: 'Sydney 2' }];
  const h = createFindDeleteDuplicatesHandlers({ getClient: async () => fakeClient([servers], nodes) });
  const r = await h['find-delete-duplicates:find']();
  const acc = r.groups.find((g) => g.value === 'acc');
  const intent = r.groups.find((g) => g.value === 'intent');
  assert.equal(acc.likely_intentional, false);                 // both in Chicago 10
  assert.equal(intent.likely_intentional, true);               // Chicago vs Sydney
  assert.deepEqual(acc.members.map((m) => m.location).sort(), ['Chicago 10', 'Chicago 10']);
  assert.deepEqual(intent.members.map((m) => m.location).sort(), ['Chicago 10', 'Sydney 2']);
});

test('find: resolves OnSight + cloud + FortiManager(GET-fallback) collector locations', async () => {
  const servers = [
    { url: '/v2/server/1/', name: 'a', fqdn: 'x', primary_monitoring_node: 'https://api2/v2/monitoring_node/632' },
    { url: '/v2/server/2/', name: 'a', fqdn: 'y', primary_monitoring_node: 'https://api2/v2/onsight/17887' },
    { url: '/v2/server/3/', name: 'b', fqdn: 'z', primary_monitoring_node: 'https://api2/v2/fortimanager/9' },
    { url: '/v2/server/4/', name: 'b', fqdn: 'w', primary_monitoring_node: 'https://api2/v2/fortimanager/9' }
  ];
  const nodes = [{ url: 'https://api2/v2/monitoring_node/632', name: 'Chicago 10' }];
  const onsights = [{ url: 'https://api2/v2/onsight/17887', name: 'fm-onsight-01' }];
  const collectors = { '/fortimanager/9': { name: 'FortiManager-HQ' } }; // GET-fallback target
  const client = fakeClient([servers], nodes, onsights, collectors);
  const h = createFindDeleteDuplicatesHandlers({ getClient: async () => client });
  const r = await h['find-delete-duplicates:find']();
  const a = r.groups.find((g) => g.value === 'a');     // cloud vs onsight -> intentional
  const bset = r.groups.find((g) => g.value === 'b');  // both FortiManager -> accidental
  assert.deepEqual(a.members.map((m) => m.location).sort(), ['Chicago 10', 'fm-onsight-01']);
  assert.equal(a.likely_intentional, true);
  assert.deepEqual(bset.members.map((m) => m.location), ['FortiManager-HQ', 'FortiManager-HQ']);
  assert.equal(bset.likely_intentional, false);
  // the GET-fallback hit /fortimanager/9 exactly once (deduped)
  assert.equal(client.calls.filter((p) => p === '/fortimanager/9').length, 1);
});

test('find: total is null when meta omits total_count (UI falls back to indeterminate)', async () => {
  const client = fakeClient([[{ url: '/v2/server/1/', name: 'a', fqdn: '' }]]);
  const events = [];
  const h = createFindDeleteDuplicatesHandlers({
    getClient: async () => client,
    events: { emit: (name, payload) => events.push({ name, payload }) }
  });
  await h['find-delete-duplicates:find']();
  const progress = events.filter((e) => e.name === 'find-delete-duplicates:find-progress');
  assert.equal(progress.length, 1);
  assert.equal(progress[0].payload.total, null);
  assert.equal(progress[0].payload.scanned, 1);
});
