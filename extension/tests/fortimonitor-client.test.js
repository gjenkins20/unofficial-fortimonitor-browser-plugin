import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FortimonitorClient,
  FortimonitorError,
  buildSavePortSelectionUrl,
  parseDevicePortsResponse,
  FM_ORIGIN
} from '../src/background/fortimonitor-client.js';
import { createFetchMock, createCookieMock, jsonResponse, errorResponse } from './fixtures/chrome-mocks.js';

// ----- buildSavePortSelectionUrl ---------------------------------

test('buildSavePortSelectionUrl produces captured parameter layout', () => {
  const url = buildSavePortSelectionUrl({
    serverId: 42024060,
    portSelectionType: 'manual',
    selectedIndices: ['0', '2', '1'],
    totalPortCount: 3
  });
  const qs = new URL(url).search;
  assert.ok(qs.startsWith('?serverId=42024060'));
  assert.ok(qs.includes('filters=%5B%5D'));
  assert.ok(qs.includes('portSelectionType=manual'));
  assert.ok(qs.includes('searchTerm='));
  assert.ok(qs.includes('totalPortCount=3'));
  const allSelected = [...new URL(url).searchParams.getAll('selectedPorts[]')];
  assert.deepEqual(allSelected, ['0', '2', '1']);
});

test('buildSavePortSelectionUrl emits one selectedPorts[] per index', () => {
  const url = buildSavePortSelectionUrl({
    serverId: 1,
    portSelectionType: 'manual',
    selectedIndices: ['0', '1', '2'],
    totalPortCount: 3
  });
  const all = new URL(url).searchParams.getAll('selectedPorts[]');
  assert.equal(all.length, 3);
});

test('buildSavePortSelectionUrl allows an empty selectedIndices list', () => {
  const url = buildSavePortSelectionUrl({
    serverId: 1,
    portSelectionType: 'none',
    selectedIndices: [],
    totalPortCount: 3
  });
  assert.deepEqual(new URL(url).searchParams.getAll('selectedPorts[]'), []);
});

test('buildSavePortSelectionUrl JSON-serializes filters', () => {
  const url = buildSavePortSelectionUrl({
    serverId: 1,
    portSelectionType: 'name',
    totalPortCount: 0,
    filters: [{ key: 'name', op: 'contains', value: 'wan' }]
  });
  const filters = new URL(url).searchParams.get('filters');
  assert.equal(filters, JSON.stringify([{ key: 'name', op: 'contains', value: 'wan' }]));
});

test('buildSavePortSelectionUrl rejects missing required args', () => {
  assert.throws(() => buildSavePortSelectionUrl({ portSelectionType: 'manual', totalPortCount: 3 }), TypeError);
  assert.throws(() => buildSavePortSelectionUrl({ serverId: 1, totalPortCount: 3 }), TypeError);
  assert.throws(() => buildSavePortSelectionUrl({ serverId: 1, portSelectionType: 'manual' }), TypeError);
});

// ----- parseDevicePortsResponse ----------------------------------

test('parseDevicePortsResponse handles production-shape response', () => {
  const parsed = parseDevicePortsResponse({
    data: {
      filter_type: 'all',
      portFilters: { searchTerm: '', filters: [] },
      ports: [
        { name: 'wan2', index: '15', alias: '', descr: null, admin_status: 'up', oper_status: 'down', isActive: true, isDisabled: false },
        { name: 'port1', index: '8', admin_status: 'up', oper_status: 'down', isActive: true, isDisabled: false }
      ]
    }
  });
  assert.equal(parsed.filterType, 'all');
  assert.equal(parsed.ports.length, 2);
  assert.equal(parsed.ports[0].name, 'wan2');
  assert.equal(parsed.ports[0].oper_status, 'down');
});

test('parseDevicePortsResponse defaults unknown statuses to "Unknown"', () => {
  const parsed = parseDevicePortsResponse({
    data: { ports: [{ name: 'port1', index: '0' }] }
  });
  assert.equal(parsed.ports[0].admin_status, 'Unknown');
  assert.equal(parsed.ports[0].oper_status, 'Unknown');
});

test('parseDevicePortsResponse throws on malformed input', () => {
  assert.throws(() => parseDevicePortsResponse(null), FortimonitorError);
  assert.throws(() => parseDevicePortsResponse({}), FortimonitorError);
  assert.throws(() => parseDevicePortsResponse({ data: null }), FortimonitorError);
});

// ----- FortimonitorClient.getDevicePorts -------------------------

test('getDevicePorts hits the expected URL with credentials and JSON Accept', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ data: { ports: [] } }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  await client.getDevicePorts(42024060);
  assert.equal(fetchMock.calls.length, 1);
  assert.equal(fetchMock.calls[0].url, `${FM_ORIGIN}/onboarding/getDevicePorts?server_id=42024060`);
  assert.equal(fetchMock.calls[0].init.method, 'GET');
  assert.equal(fetchMock.calls[0].init.credentials, 'include');
  assert.equal(fetchMock.calls[0].init.headers.Accept, 'application/json');
});

test('getDevicePorts throws FortimonitorError with status on HTTP failure', async () => {
  const fetchMock = createFetchMock(async () => errorResponse(404));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  await assert.rejects(client.getDevicePorts(999), (err) => {
    return err instanceof FortimonitorError && err.status === 404 && err.phase === 'read';
  });
});

// ----- FortimonitorClient.savePortSelection ----------------------

test('savePortSelection attaches X-XSRF-TOKEN header from cookie', async () => {
  let captured;
  const fetchMock = createFetchMock(async (url, init) => { captured = init; return jsonResponse({ success: true }); });
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'abc123' });
  await client.savePortSelection({ serverId: 1, totalPortCount: 3, selectedIndices: ['0'] });
  assert.equal(captured.headers['X-XSRF-TOKEN'], 'abc123');
  assert.equal(captured.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(captured.body, undefined);
});

test('savePortSelection throws when XSRF cookie is missing', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ success: true }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => null });
  await assert.rejects(
    client.savePortSelection({ serverId: 1, totalPortCount: 3 }),
    (err) => err instanceof FortimonitorError && err.phase === 'auth'
  );
  assert.equal(fetchMock.calls.length, 0, 'no fetch should happen if auth fails');
});

test('savePortSelection rejects on HTTP error with status on the error', async () => {
  const fetchMock = createFetchMock(async () => errorResponse(500));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  await assert.rejects(
    client.savePortSelection({ serverId: 1, totalPortCount: 3 }),
    (err) => err instanceof FortimonitorError && err.status === 500 && err.phase === 'write'
  );
});

test('savePortSelection rejects when server returns success:false', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ success: false, message: 'nope' }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  await assert.rejects(
    client.savePortSelection({ serverId: 1, totalPortCount: 3 }),
    (err) => err instanceof FortimonitorError && err.phase === 'write' && err.responseBody?.success === false
  );
});

// ----- constructor validation ------------------------------------

test('FortimonitorClient requires fetch and getCookie', () => {
  assert.throws(() => new FortimonitorClient({}), TypeError);
  assert.throws(() => new FortimonitorClient({ fetch: () => {} }), TypeError);
});
