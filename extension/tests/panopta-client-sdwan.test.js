import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanoptaClient } from '../src/lib/panopta-client.js';
import { createFetchMock, jsonResponse } from './fixtures/chrome-mocks.js';

// FMN-129 paginated read methods. Each test wires a fetch mock that
// returns sequential pages, then asserts the client both flattens the
// records correctly and stops when the page is empty / total_count is
// reached / signal aborts.

function pageOf(records, key, total) {
  return jsonResponse({ [key]: records, meta: { total_count: total } });
}

test('listAllServers: pages through /server with default page size 25', async () => {
  const calls = [];
  const fetch = createFetchMock(async (url) => {
    calls.push(url);
    if (calls.length === 1) return pageOf(
      [{ id: 1 }, { id: 2 }],
      'server_list',
      3
    );
    return pageOf([{ id: 3 }], 'server_list', 3);
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const out = await client.listAllServers();
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((s) => s.id), [1, 2, 3]);
  assert.match(calls[0], /\/server\?limit=25&offset=0$/);
  assert.match(calls[1], /\/server\?limit=25&offset=2$/);
});

test('listAllServerGroups: probes "objects" envelope key', async () => {
  const fetch = createFetchMock(async () => jsonResponse({
    objects: [{ id: 7, name: 'g1' }],
    meta: { total_count: 1 }
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const out = await client.listAllServerGroups();
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'g1');
});

test('listSnmpResourcesForServer: probes snmp_resource_list envelope key', async () => {
  const fetch = createFetchMock(async () => jsonResponse({
    snmp_resource_list: [
      { id: 1, formatted_name: 'A - wan1' },
      { id: 2, formatted_name: 'B - vpn0' }
    ],
    meta: { total_count: 2 }
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const out = await client.listSnmpResourcesForServer(42);
  assert.equal(out.length, 2);
});

test('listAllAgentResourcesForServer: stops on empty page even if total is unknown', async () => {
  let pages = 0;
  const fetch = createFetchMock(async () => {
    pages += 1;
    if (pages === 1) return jsonResponse({ agent_resource_list: [{ id: 1 }] });
    return jsonResponse({ agent_resource_list: [] });
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const out = await client.listAllAgentResourcesForServer(99);
  assert.equal(out.length, 1);
  assert.equal(pages, 2);
});

test('listNetworkServicesForServer: handles "network_services" envelope (snake_case variant)', async () => {
  const fetch = createFetchMock(async () => jsonResponse({
    network_services: [{ id: 1, name: 'check', target: 'isp-a' }],
    meta: { total_count: 1 }
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const out = await client.listNetworkServicesForServer(7);
  assert.equal(out.length, 1);
});

test('paginated walk: AbortSignal stops between pages', async () => {
  let pages = 0;
  const ac = new AbortController();
  const fetch = createFetchMock(async () => {
    pages += 1;
    if (pages === 1) {
      // After the first page lands, the second page should be aborted
      // before its fetch starts.
      ac.abort();
      return jsonResponse({ snmp_resource_list: [{ id: 1 }], meta: { total_count: 100 } });
    }
    // If the abort check is missing, we'd return another page here.
    return jsonResponse({ snmp_resource_list: [{ id: 2 }] });
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(
    client.listSnmpResourcesForServer(1, { signal: ac.signal }),
    (err) => err.name === 'AbortError'
  );
  assert.equal(pages, 1, 'should not fetch a second page once aborted');
});

test('paginated walk: serverId is required', async () => {
  const client = new PanoptaClient({ apiKey: 'k', fetch: async () => jsonResponse({}) });
  await assert.rejects(client.listSnmpResourcesForServer(), /required/);
  await assert.rejects(client.listAllAgentResourcesForServer(), /required/);
  await assert.rejects(client.listNetworkServicesForServer(), /required/);
});
