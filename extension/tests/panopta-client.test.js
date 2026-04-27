import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PanoptaClient,
  PanoptaError,
  buildFabricConnectionPayload,
  parseListResponse,
  PANOPTA_BASE
} from '../src/lib/panopta-client.js';
import { createFetchMock, jsonResponse, errorResponse } from './fixtures/chrome-mocks.js';

// ----- buildFabricConnectionPayload ----------------------------

test('buildFabricConnectionPayload sets required CSF tunnel fields', () => {
  const p = buildFabricConnectionPayload({
    serial: 'FGVM01TM24006844',
    ip: '10.0.0.94',
    port: 8013,
    onsightUrl: 'https://api2.panopta.com/v2/onsight/16966',
    serverGroupUrl: 'https://api2.panopta.com/v2/server_group/617692'
  });
  assert.equal(p.integration_type, 'onsight_csf_tunnel');
  assert.equal(p.upstream_sn, 'FGVM01TM24006844');
  assert.equal(p.upstream_host, '10.0.0.94');
  assert.equal(p.upstream_port, 8013);
  assert.equal(p.onsight, 'https://api2.panopta.com/v2/onsight/16966');
  assert.equal(p.server_group, 'https://api2.panopta.com/v2/server_group/617692');
  assert.equal(p.label, '10.0.0.94'); // defaults to ip
});

test('buildFabricConnectionPayload omits appliance_group when not provided', () => {
  const p = buildFabricConnectionPayload({
    serial: 'X', ip: '1.1.1.1', port: 1,
    onsightUrl: 'A', serverGroupUrl: 'B'
  });
  assert.ok(!('appliance_group' in p), 'appliance_group should be absent');
});

test('buildFabricConnectionPayload includes appliance_group when provided', () => {
  const p = buildFabricConnectionPayload({
    serial: 'X', ip: '1.1.1.1', port: 1,
    onsightUrl: 'A', serverGroupUrl: 'B',
    applianceGroupUrl: 'https://api2.panopta.com/v2/onsight_group/12345'
  });
  assert.equal(p.appliance_group, 'https://api2.panopta.com/v2/onsight_group/12345');
});

test('buildFabricConnectionPayload uses custom label when provided', () => {
  const p = buildFabricConnectionPayload({
    serial: 'X', ip: '1.1.1.1', port: 1,
    onsightUrl: 'A', serverGroupUrl: 'B',
    label: 'Branch-Office-001'
  });
  assert.equal(p.label, 'Branch-Office-001');
});

test('buildFabricConnectionPayload requires core fields', () => {
  assert.throws(() => buildFabricConnectionPayload({ ip: '1.1.1.1', port: 1, onsightUrl: 'A', serverGroupUrl: 'B' }), TypeError);
  assert.throws(() => buildFabricConnectionPayload({ serial: 'X', port: 1, onsightUrl: 'A', serverGroupUrl: 'B' }), TypeError);
  assert.throws(() => buildFabricConnectionPayload({ serial: 'X', ip: '1.1.1.1', port: 'abc', onsightUrl: 'A', serverGroupUrl: 'B' }), TypeError);
  assert.throws(() => buildFabricConnectionPayload({ serial: 'X', ip: '1.1.1.1', port: 1, serverGroupUrl: 'B' }), TypeError);
  assert.throws(() => buildFabricConnectionPayload({ serial: 'X', ip: '1.1.1.1', port: 1, onsightUrl: 'A' }), TypeError);
});

// ----- parseListResponse ----------------------------

test('parseListResponse returns id/name/resourceUrl per item', () => {
  const items = parseListResponse({
    objects: [
      { id: 16966, name: 'OnSight A', resource_uri: '/v2/onsight/16966' },
      { id: 16967, name: 'OnSight B', resource_uri: '/v2/onsight/16967' }
    ]
  });
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: 16966,
    name: 'OnSight A',
    resourceUrl: 'https://api2.panopta.com/v2/onsight/16966'
  });
});

test('parseListResponse falls back to "#id" when name is missing', () => {
  const items = parseListResponse({
    objects: [{ id: 99, resource_uri: '/v2/onsight/99' }]
  });
  assert.equal(items[0].name, '#99');
});

test('parseListResponse throws on missing objects array', () => {
  assert.throws(() => parseListResponse({}), PanoptaError);
  assert.throws(() => parseListResponse(null), PanoptaError);
});

// ----- PanoptaClient construction ----------------------------

test('PanoptaClient requires apiKey + fetch', () => {
  assert.throws(() => new PanoptaClient({ fetch: () => {} }), TypeError);
  assert.throws(() => new PanoptaClient({ apiKey: 'k' }), TypeError);
});

// ----- PanoptaClient.createFabricConnection ----------------------------

test('createFabricConnection POSTs JSON with ApiKey header', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse(
    { id: 98765, status: 'created' },
    { status: 201, headers: { location: 'https://api2.panopta.com/v2/fabric_connection/98765', id: '98765' } }
  ));
  const client = new PanoptaClient({ apiKey: 'rw_test_key', fetch: fetchMock });
  const result = await client.createFabricConnection({
    serial: 'FGVM01TM24006844',
    ip: '10.0.0.94',
    port: 8013,
    onsightUrl: 'https://api2.panopta.com/v2/onsight/16966',
    serverGroupUrl: 'https://api2.panopta.com/v2/server_group/617692'
  });
  assert.equal(fetchMock.calls.length, 1);
  const { url, init } = fetchMock.calls[0];
  assert.equal(url, `${PANOPTA_BASE}/fabric_connection`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Authorization'], 'ApiKey rw_test_key');
  assert.equal(init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(init.body);
  assert.equal(body.upstream_sn, 'FGVM01TM24006844');
  assert.equal(result.status, 201);
  assert.equal(result.location, 'https://api2.panopta.com/v2/fabric_connection/98765');
  assert.equal(result.resourceId, '98765');
});

test('createFabricConnection throws PanoptaError with phase=auth on 401', async () => {
  const fetchMock = createFetchMock(async () => errorResponse(401, { message: 'Invalid API key' }));
  const client = new PanoptaClient({ apiKey: 'bad', fetch: fetchMock });
  await assert.rejects(
    () => client.createFabricConnection({
      serial: 'X', ip: '1.1.1.1', port: 1,
      onsightUrl: 'A', serverGroupUrl: 'B'
    }),
    (err) => err instanceof PanoptaError && err.status === 401 && err.phase === 'auth'
  );
});

test('createFabricConnection throws PanoptaError with phase=write on 500', async () => {
  const fetchMock = createFetchMock(async () => errorResponse(500, { message: 'Internal' }));
  const client = new PanoptaClient({ apiKey: 'k', fetch: fetchMock });
  await assert.rejects(
    () => client.createFabricConnection({
      serial: 'X', ip: '1.1.1.1', port: 1,
      onsightUrl: 'A', serverGroupUrl: 'B'
    }),
    (err) => err instanceof PanoptaError && err.status === 500 && err.phase === 'write'
  );
});

// FMN-90: friendly RO-key hint on auth-like write failures.

test('write-method 403 surfaces RO-key hint and phase=auth', async () => {
  const fetchMock = createFetchMock(async () => errorResponse(403, { message: 'forbidden' }));
  const client = new PanoptaClient({ apiKey: 'ro', fetch: fetchMock });
  await assert.rejects(
    () => client.createFabricConnection({
      serial: 'X', ip: '1.1.1.1', port: 1,
      onsightUrl: 'A', serverGroupUrl: 'B'
    }),
    (err) => err instanceof PanoptaError
      && err.status === 403
      && err.phase === 'auth'
      && err.message.startsWith('Your API key may be read-only')
  );
});

test('write-method 405 surfaces RO-key hint and phase=auth', async () => {
  const fetchMock = createFetchMock(async () => errorResponse(405, {}));
  const client = new PanoptaClient({ apiKey: 'ro', fetch: fetchMock });
  await assert.rejects(
    () => client.deleteServerAttribute('https://api2.panopta.com/v2/server/1/server_attribute/2'),
    (err) => err instanceof PanoptaError
      && err.status === 405
      && err.phase === 'auth'
      && err.message.startsWith('Your API key may be read-only')
  );
});

test('GET 403 is not translated as RO-key hint (read endpoints stay untouched)', async () => {
  const fetchMock = createFetchMock(async () => errorResponse(403, { message: 'forbidden read' }));
  const client = new PanoptaClient({ apiKey: 'k', fetch: fetchMock });
  await assert.rejects(
    () => client.listOnsight(),
    (err) => err instanceof PanoptaError
      && err.status === 403
      && err.phase === 'write'
      && !err.message.startsWith('Your API key may be read-only')
  );
});

test('createFabricConnection wraps fetch network errors', async () => {
  const fetchMock = createFetchMock(async () => { throw new Error('ENOTFOUND'); });
  const client = new PanoptaClient({ apiKey: 'k', fetch: fetchMock });
  await assert.rejects(
    () => client.createFabricConnection({
      serial: 'X', ip: '1.1.1.1', port: 1,
      onsightUrl: 'A', serverGroupUrl: 'B'
    }),
    (err) => err instanceof PanoptaError && err.phase === 'network'
  );
});

// ----- PanoptaClient list endpoints ----------------------------

test('listOnsight returns parsed items', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({
    objects: [{ id: 1, name: 'OS-1', resource_uri: '/v2/onsight/1' }]
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch: fetchMock });
  const items = await client.listOnsight();
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'OS-1');
  assert.match(fetchMock.calls[0].url, /\/onsight\?limit=100$/);
});

test('listServerGroups + listOnsightGroups hit correct paths', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ objects: [] }));
  const client = new PanoptaClient({ apiKey: 'k', fetch: fetchMock });
  await client.listServerGroups();
  await client.listOnsightGroups();
  assert.match(fetchMock.calls[0].url, /\/server_group\?limit=100$/);
  assert.match(fetchMock.calls[1].url, /\/onsight_group\?limit=100$/);
});

// ----- PanoptaClient.testConnection ----------------------------

test('testConnection returns ok=true on 200', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ objects: [] }));
  const client = new PanoptaClient({ apiKey: 'k', fetch: fetchMock });
  const result = await client.testConnection();
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.match(fetchMock.calls[0].url, /\/onsight\?limit=1$/);
});

test('testConnection throws on 401 (bad key)', async () => {
  const fetchMock = createFetchMock(async () => errorResponse(401));
  const client = new PanoptaClient({ apiKey: 'bad', fetch: fetchMock });
  await assert.rejects(() => client.testConnection(), PanoptaError);
});
