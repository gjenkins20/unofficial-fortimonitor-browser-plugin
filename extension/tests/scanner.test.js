import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDevices, groupByFingerprint, resolveServerNames } from '../src/background/scanner.js';

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

// ----- resolveServerNames (FMN-61) --------------------------------

function nameClient(namesById) {
  return {
    async getServerName(id) {
      return Object.prototype.hasOwnProperty.call(namesById, id) ? namesById[id] : null;
    }
  };
}

test('resolveServerNames returns an empty map for empty input', async () => {
  const out = await resolveServerNames([], { client: nameClient({}) });
  assert.deepEqual(out, {});
});

test('resolveServerNames maps input ids to resolved names', async () => {
  const client = nameClient({ 1: 'alpha', 2: 'bravo', 3: 'charlie' });
  const out = await resolveServerNames([1, 2, 3], { client, concurrency: 2 });
  assert.deepEqual(out, { '1': 'alpha', '2': 'bravo', '3': 'charlie' });
});

test('resolveServerNames omits ids whose name could not be resolved', async () => {
  const client = nameClient({ 1: 'alpha', 3: 'charlie' });
  const out = await resolveServerNames([1, 2, 3], { client });
  assert.deepEqual(out, { '1': 'alpha', '3': 'charlie' });
  assert.equal('2' in out, false);
});

test('resolveServerNames treats client errors the same as null (silent failure)', async () => {
  const client = {
    async getServerName(id) {
      if (id === 2) throw new Error('network');
      return id === 1 ? 'alpha' : null;
    }
  };
  const out = await resolveServerNames([1, 2, 3], { client });
  assert.deepEqual(out, { '1': 'alpha' });
});

test('resolveServerNames requires a client', async () => {
  await assert.rejects(() => resolveServerNames([1]), TypeError);
});

test('resolveServerNames requires an array', async () => {
  await assert.rejects(() => resolveServerNames('not-array', { client: nameClient({}) }), TypeError);
});

test('resolveServerNames respects concurrency cap', async () => {
  let inFlight = 0, peak = 0;
  const client = {
    async getServerName(id) {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return `name-${id}`;
    }
  };
  await resolveServerNames([1, 2, 3, 4, 5, 6, 7, 8], { client, concurrency: 3 });
  assert.ok(peak <= 3, `peak in-flight ${peak} exceeded concurrency 3`);
});
