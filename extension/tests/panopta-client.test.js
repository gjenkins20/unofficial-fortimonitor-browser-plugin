import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PanoptaClient,
  PanoptaError,
  buildFabricConnectionPayload,
  parseListResponse,
  PANOPTA_BASE,
  sanitizeServerBodyForPut,
  extractApiErrorMessage
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

test('parseListResponse returns id/name/resourceUrl per item for onsight_list', () => {
  const items = parseListResponse({
    onsight_list: [
      { url: 'https://api2.panopta.com/v2/onsight/16966', name: 'OnSight A' },
      { url: 'https://api2.panopta.com/v2/onsight/16967', name: 'OnSight B' }
    ]
  }, 'onsight_list');
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: 16966,
    name: 'OnSight A',
    resourceUrl: 'https://api2.panopta.com/v2/onsight/16966'
  });
});

test('parseListResponse extracts id from url for server_group_list', () => {
  const items = parseListResponse({
    server_group_list: [
      { url: 'https://api2.panopta.com/v2/server_group/617573', name: 'FM_Training', id: null }
    ]
  }, 'server_group_list');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 617573);
  assert.equal(items[0].resourceUrl, 'https://api2.panopta.com/v2/server_group/617573');
});

test('parseListResponse falls back to "#id" when name is missing', () => {
  const items = parseListResponse({
    onsight_list: [{ url: 'https://api2.panopta.com/v2/onsight/99' }]
  }, 'onsight_list');
  assert.equal(items[0].id, 99);
  assert.equal(items[0].name, '#99');
});

test('parseListResponse honors legacy resource_uri when url is absent', () => {
  const items = parseListResponse({
    onsight_list: [{ id: 99, name: 'OnSight Legacy', resource_uri: '/v2/onsight/99' }]
  }, 'onsight_list');
  assert.equal(items[0].resourceUrl, 'https://api2.panopta.com/v2/onsight/99');
});

test('parseListResponse throws on missing wrapper array', () => {
  assert.throws(() => parseListResponse({}, 'onsight_list'), PanoptaError);
  assert.throws(() => parseListResponse(null, 'onsight_list'), PanoptaError);
});

test('parseListResponse requires wrapperKey', () => {
  assert.throws(() => parseListResponse({ onsight_list: [] }), TypeError);
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
    onsight_list: [{ url: 'https://api2.panopta.com/v2/onsight/1', name: 'OS-1' }]
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch: fetchMock });
  const items = await client.listOnsight();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 1);
  assert.equal(items[0].name, 'OS-1');
  assert.match(fetchMock.calls[0].url, /\/onsight\?limit=100$/);
});

test('listServerGroups + listOnsightGroups hit correct paths', async () => {
  const fetchMock = createFetchMock(async (url) => {
    if (/server_group/.test(url)) return jsonResponse({ server_group_list: [] });
    return jsonResponse({ onsight_group_list: [] });
  });
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

// ----- sanitizeServerBodyForPut (FMN-206) ----------------------

test('sanitizeServerBodyForPut coerces geo_latitude / geo_longitude strings to numbers', () => {
  const out = sanitizeServerBodyForPut({
    name: 'srv', tags: ['a'],
    geo_latitude: '61.217381', geo_longitude: '-149.863129'
  });
  assert.strictEqual(out.geo_latitude, 61.217381);
  assert.strictEqual(out.geo_longitude, -149.863129);
  assert.deepEqual(out.tags, ['a']);
});

test('sanitizeServerBodyForPut maps non-numeric lat/long to null', () => {
  const out = sanitizeServerBodyForPut({ geo_latitude: 'bogus', geo_longitude: '' });
  assert.strictEqual(out.geo_latitude, null);
  assert.strictEqual(out.geo_longitude, null);
});

test('sanitizeServerBodyForPut leaves numeric lat/long untouched', () => {
  const out = sanitizeServerBodyForPut({ geo_latitude: 12.5, geo_longitude: -77.1 });
  assert.strictEqual(out.geo_latitude, 12.5);
  assert.strictEqual(out.geo_longitude, -77.1);
});

test('sanitizeServerBodyForPut leaves null lat/long alone (does not coerce null to 0)', () => {
  const out = sanitizeServerBodyForPut({ geo_latitude: null, geo_longitude: null });
  assert.strictEqual(out.geo_latitude, null);
  assert.strictEqual(out.geo_longitude, null);
});

test('sanitizeServerBodyForPut disables snmp_heartbeat when snmp_scan_frequency is 0', () => {
  const out = sanitizeServerBodyForPut({
    snmp_heartbeat_enabled: true,
    snmp_scan_frequency: 0,
    snmp_heartbeat_notification_schedule: 'https://api2.panopta.com/v2/notification_schedule/-1'
  });
  assert.strictEqual(out.snmp_heartbeat_enabled, false);
  assert.strictEqual(out.snmp_heartbeat_notification_schedule, null);
});

test('sanitizeServerBodyForPut leaves snmp_heartbeat alone when scanning is configured', () => {
  const out = sanitizeServerBodyForPut({
    snmp_heartbeat_enabled: true,
    snmp_scan_frequency: 300,
    snmp_heartbeat_notification_schedule: 'https://api2.panopta.com/v2/notification_schedule/42'
  });
  assert.strictEqual(out.snmp_heartbeat_enabled, true);
  assert.strictEqual(out.snmp_heartbeat_notification_schedule, 'https://api2.panopta.com/v2/notification_schedule/42');
});

test('sanitizeServerBodyForPut returns input unchanged for non-object input', () => {
  assert.strictEqual(sanitizeServerBodyForPut(null), null);
  assert.strictEqual(sanitizeServerBodyForPut(undefined), undefined);
});

// ----- extractApiErrorMessage (FMN-206) ------------------------

test('extractApiErrorMessage prefers parsed.message', () => {
  assert.strictEqual(extractApiErrorMessage({ message: 'canonical' }), 'canonical');
});

test('extractApiErrorMessage falls back to parsed.error', () => {
  assert.strictEqual(
    extractApiErrorMessage({ error: "Can't enable SNMP heartbeat on a non-SNMP instance" }),
    "Can't enable SNMP heartbeat on a non-SNMP instance"
  );
});

test('extractApiErrorMessage flattens per-field validation errors', () => {
  const msg = extractApiErrorMessage({
    geo_latitude: 'This field is invalid: enter a number',
    geo_longitude: 'This field is invalid: enter a number'
  });
  assert.match(msg, /geo_latitude: This field is invalid/);
  assert.match(msg, /geo_longitude: This field is invalid/);
  assert.match(msg, /;/);
});

test('extractApiErrorMessage returns null for non-object / empty inputs', () => {
  assert.strictEqual(extractApiErrorMessage(null), null);
  assert.strictEqual(extractApiErrorMessage(undefined), null);
  assert.strictEqual(extractApiErrorMessage('plain text'), null);
  assert.strictEqual(extractApiErrorMessage({}), null);
});

test('extractApiErrorMessage skips message/error fields when they are empty strings', () => {
  assert.strictEqual(
    extractApiErrorMessage({ message: '   ', error: 'real-error' }),
    'real-error'
  );
});

// ----- removeServerTag GET->sanitize->PUT chain (FMN-206) ------

test('removeServerTag PUT body has numeric geo_latitude/geo_longitude (string-from-GET coerced)', async () => {
  const fetchMock = createFetchMock(async (url, init) => {
    if (init.method === 'GET') {
      return jsonResponse({
        url: 'https://api2.panopta.com/v2/server/123',
        name: 's',
        tags: ['doomed', 'keep'],
        geo_latitude: '61.217381',
        geo_longitude: '-149.863129'
      });
    }
    // PUT
    return jsonResponse({}, { status: 200 });
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch: fetchMock });
  await client.removeServerTag(123, ['doomed']);
  const putCall = fetchMock.calls.find((c) => c.init.method === 'PUT');
  assert.ok(putCall, 'PUT call should have been made');
  const sentBody = JSON.parse(putCall.init.body);
  assert.strictEqual(typeof sentBody.geo_latitude, 'number');
  assert.strictEqual(typeof sentBody.geo_longitude, 'number');
  assert.strictEqual(sentBody.geo_latitude, 61.217381);
  assert.deepEqual(sentBody.tags, ['keep']);
});

test('removeServerTag PUT body forces snmp_heartbeat off when scan frequency is 0', async () => {
  const fetchMock = createFetchMock(async (url, init) => {
    if (init.method === 'GET') {
      return jsonResponse({
        url: 'https://api2.panopta.com/v2/server/123',
        tags: ['doomed'],
        snmp_heartbeat_enabled: true,
        snmp_scan_frequency: 0,
        snmp_heartbeat_notification_schedule: 'https://api2.panopta.com/v2/notification_schedule/-1'
      });
    }
    return jsonResponse({}, { status: 200 });
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch: fetchMock });
  await client.removeServerTag(123, ['doomed']);
  const putCall = fetchMock.calls.find((c) => c.init.method === 'PUT');
  const sentBody = JSON.parse(putCall.init.body);
  assert.strictEqual(sentBody.snmp_heartbeat_enabled, false);
  assert.strictEqual(sentBody.snmp_heartbeat_notification_schedule, null);
});

test('removeServerTag preserves tags array on PUT (no field accidentally dropped by sanitizer)', async () => {
  const fetchMock = createFetchMock(async (url, init) => {
    if (init.method === 'GET') {
      return jsonResponse({
        url: 'https://api2.panopta.com/v2/server/123',
        name: 'my-server',
        tags: ['a', 'b', 'c'],
        notification_schedule: 'https://api2.panopta.com/v2/notification_schedule/42',
        server_group: 'https://api2.panopta.com/v2/server_group/100'
      });
    }
    return jsonResponse({}, { status: 200 });
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch: fetchMock });
  await client.removeServerTag(123, ['b']);
  const putCall = fetchMock.calls.find((c) => c.init.method === 'PUT');
  const sentBody = JSON.parse(putCall.init.body);
  assert.deepEqual(sentBody.tags, ['a', 'c']);
  assert.strictEqual(sentBody.name, 'my-server');
  assert.strictEqual(sentBody.notification_schedule, 'https://api2.panopta.com/v2/notification_schedule/42');
});

test('PanoptaError message surfaces parsed.error (not just parsed.message)', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse(
    { error: "Can't enable SNMP heartbeat on a non-SNMP instance" },
    { status: 400 }
  ));
  const client = new PanoptaClient({ apiKey: 'k', fetch: fetchMock });
  await assert.rejects(
    () => client.getServer(123),
    (err) => {
      assert.ok(err instanceof PanoptaError);
      assert.match(err.message, /Can't enable SNMP heartbeat/);
      return true;
    }
  );
});

test('PanoptaError message surfaces per-field validation errors', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse(
    {
      geo_latitude: 'This field is invalid: enter a number',
      geo_longitude: 'This field is invalid: enter a number'
    },
    { status: 400 }
  ));
  const client = new PanoptaClient({ apiKey: 'k', fetch: fetchMock });
  await assert.rejects(
    () => client.getServer(123),
    (err) => {
      assert.match(err.message, /geo_latitude.*This field is invalid/);
      assert.match(err.message, /geo_longitude.*This field is invalid/);
      return true;
    }
  );
});
