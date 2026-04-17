import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDevices, groupByFingerprint } from '../src/background/scanner.js';

function fakeClient(perServerPorts) {
  return {
    async getDevicePorts(serverId) {
      const ports = perServerPorts[serverId];
      if (!ports) throw new Error(`no mock for ${serverId}`);
      return {
        filterType: 'all',
        portFilters: { searchTerm: '', filters: [] },
        ports
      };
    }
  };
}

test('scanDevices returns fingerprints for each device', async () => {
  const client = fakeClient({
    1001: [{ name: 'wan2', admin_status: 'up', oper_status: 'down' }],
    1002: [{ name: 'wan2', admin_status: 'up', oper_status: 'down' }],
    1003: [{ name: 'wan2', admin_status: 'up', oper_status: 'up' }]
  });
  const results = await scanDevices([1001, 1002, 1003], { client, concurrency: 2 });
  assert.equal(results.length, 3);
  assert.equal(results[0].fingerprint, results[1].fingerprint, 'same port state → same fp');
  assert.notEqual(results[0].fingerprint, results[2].fingerprint, 'different state → different fp');
});

test('scanDevices captures per-device errors without failing the batch', async () => {
  const client = {
    async getDevicePorts(id) {
      if (id === 'bad') throw new Error('HTTP 404');
      return { ports: [{ name: 'wan2', admin_status: 'up', oper_status: 'down' }] };
    }
  };
  const results = await scanDevices([1001, 'bad', 1002], { client });
  assert.equal(results[1].error.message, 'HTTP 404');
  assert.equal(results[1].fingerprint, null);
  assert.ok(results[0].fingerprint);
  assert.ok(results[2].fingerprint);
});

test('scanDevices preserves input order', async () => {
  const client = fakeClient({
    A: [{ name: 'a', admin_status: 'up', oper_status: 'up' }],
    B: [{ name: 'b', admin_status: 'up', oper_status: 'down' }],
    C: [{ name: 'c', admin_status: 'down', oper_status: 'down' }]
  });
  const results = await scanDevices(['A', 'B', 'C'], { client });
  assert.deepEqual(results.map((r) => r.serverId), ['A', 'B', 'C']);
});

test('scanDevices fires onProgress for each device', async () => {
  const client = fakeClient({
    1: [{ name: 'a', admin_status: 'up', oper_status: 'up' }],
    2: [{ name: 'a', admin_status: 'up', oper_status: 'up' }]
  });
  const progress = [];
  await scanDevices([1, 2], { client, concurrency: 1, onProgress: (done, total) => progress.push({ done, total }) });
  assert.deepEqual(progress.map((p) => p.done), [1, 2]);
  assert.equal(progress[0].total, 2);
});

test('groupByFingerprint collapses devices with identical state', async () => {
  const client = fakeClient({
    1: [{ name: 'wan2', admin_status: 'up', oper_status: 'down' }],
    2: [{ name: 'wan2', admin_status: 'up', oper_status: 'down' }],
    3: [{ name: 'wan2', admin_status: 'up', oper_status: 'up' }]
  });
  const results = await scanDevices([1, 2, 3], { client });
  const { groups, errored } = groupByFingerprint(results);
  assert.equal(groups.length, 2, 'two unique port shapes');
  assert.equal(errored.length, 0);
  const sizes = groups.map((g) => g.devices.length).sort();
  assert.deepEqual(sizes, [1, 2]);
});

test('groupByFingerprint routes errored scans to the errored bucket', async () => {
  const client = {
    async getDevicePorts(id) {
      if (id === 'bad') throw new Error('boom');
      return { ports: [{ name: 'x', admin_status: 'up', oper_status: 'up' }] };
    }
  };
  const results = await scanDevices([1, 'bad'], { client });
  const { groups, errored } = groupByFingerprint(results);
  assert.equal(groups.length, 1);
  assert.equal(errored.length, 1);
  assert.equal(errored[0].serverId, 'bad');
});

test('scanDevices requires a client', async () => {
  await assert.rejects(() => scanDevices([1]), TypeError);
});
