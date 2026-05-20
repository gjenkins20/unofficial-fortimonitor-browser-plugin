import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FortimonitorClient,
  FortimonitorError,
  buildSavePortSelectionUrl,
  parseDevicePortsResponse,
  redactSensitive,
  FM_ORIGIN
} from '../src/lib/fortimonitor-client.js';
import { createFetchMock, createCookieMock, jsonResponse, errorResponse } from './fixtures/chrome-mocks.js';

function htmlResponse(body = '<!DOCTYPE html><html>login</html>', { status = 200, url = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Map([['content-type', 'text/html; charset=utf-8']]),
    async json() { throw new SyntaxError(`Unexpected token '<', "${body.slice(0, 15)}"... is not valid JSON`); },
    async text() { return body; }
  };
}

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

// ----- non-JSON (login-page) detection ---------------------------

test('getDevicePorts surfaces phase=auth when FortiMonitor redirects to an HTML login', async () => {
  const fetchMock = createFetchMock(async () => htmlResponse(
    '<!DOCTYPE html><html><body>login form</body></html>',
    { url: 'https://fortimonitor.forticloud.com/login' }
  ));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  await assert.rejects(client.getDevicePorts(42978481), (err) => {
    return err instanceof FortimonitorError
      && err.phase === 'auth'
      && err.status === 200
      && /non-JSON/i.test(err.message)
      && err.contentType?.includes('text/html')
      && typeof err.bodyPreview === 'string'
      && err.bodyPreview.includes('login form');
  });
});

test('getDevicePorts attaches responseUrl (redacted) on HTTP failure', async () => {
  const fetchMock = createFetchMock(async () => ({
    ok: false,
    status: 502,
    url: 'https://fortimonitor.forticloud.com/onboarding/getDevicePorts?server_id=1&sig=abcdefghijklmnopqrstuvwxyz0123456789',
    headers: new Map([['content-type', 'text/html']]),
    async json() { return null; },
    async text() { return ''; }
  }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  await assert.rejects(client.getDevicePorts(1), (err) => {
    return err.status === 502
      && err.phase === 'read'
      && err.responseUrl?.includes('<redacted-query>')
      && err.contentType === 'text/html';
  });
});

// ----- redactSensitive -------------------------------------------

test('redactSensitive strips query strings and long base64-ish runs', () => {
  const out = redactSensitive('https://x/y?token=ABC&sig=abcdefghijklmnopqrstuvwxyz0123456789');
  assert.ok(out.includes('<redacted-query>'), `expected <redacted-query> in: ${out}`);
  const out2 = redactSensitive('prefix abcdefghijklmnopqrstuvwxyz0123456789xx suffix');
  assert.ok(out2.includes('<redacted-token>'), `expected <redacted-token> in: ${out2}`);
});

test('redactSensitive leaves short text untouched', () => {
  assert.equal(redactSensitive('hello world'), 'hello world');
  assert.equal(redactSensitive(null), null);
  assert.equal(redactSensitive(undefined), undefined);
});

// ----- probeSession ----------------------------------------------

test('probeSession reports XSRF cookie presence and HTTP status', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ data: { ports: [] } }, {
    headers: { 'content-type': 'application/json' }
  }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'xsrf-123456789' });
  const out = await client.probeSession();
  assert.equal(out.hasXsrfCookie, true);
  assert.ok(out.xsrfCookiePrefix?.startsWith('xsrf-1'));
  assert.equal(out.probe.status, 200);
  assert.ok(out.probe.contentType.includes('json'));
});

test('probeSession reports hasXsrfCookie=false when cookie is missing', async () => {
  const fetchMock = createFetchMock(async () => htmlResponse());
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => null });
  const out = await client.probeSession();
  assert.equal(out.hasXsrfCookie, false);
  assert.equal(out.xsrfCookiePrefix, null);
  assert.equal(out.probe.status, 200);
  assert.ok(out.probe.contentType.includes('text/html'));
});

test('probeSession does not throw when fetch rejects', async () => {
  const client = new FortimonitorClient({
    fetch: async () => { throw new Error('network down'); },
    getCookie: async () => 'tok'
  });
  const out = await client.probeSession();
  assert.equal(out.hasXsrfCookie, true);
  assert.match(out.probe.error, /network down/);
});

// ----- injectable origin (regional tenant support) ---------------

test('getDevicePorts uses the injected origin, not the federation URL', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ data: { ports: [] } }));
  const client = new FortimonitorClient({
    fetch: fetchMock,
    getCookie: async () => 'tok',
    origin: 'https://my.us01.fortimonitor.com'
  });
  await client.getDevicePorts(42024060);
  assert.equal(fetchMock.calls[0].url, 'https://my.us01.fortimonitor.com/onboarding/getDevicePorts?server_id=42024060');
});

test('origin accepts an async resolver and caches the result', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ data: { ports: [] } }));
  let calls = 0;
  const resolver = async () => {
    calls++;
    return 'https://my.us01.fortimonitor.com';
  };
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok', origin: resolver });
  await client.getDevicePorts(1);
  await client.getDevicePorts(2);
  await client.probeSession();
  assert.equal(calls, 1, 'resolver should only be called once per client');
});

test('savePortSelection targets the injected origin', async () => {
  let captured;
  const fetchMock = createFetchMock(async (url) => { captured = url; return jsonResponse({ success: true }); });
  const client = new FortimonitorClient({
    fetch: fetchMock,
    getCookie: async () => 'xsrf',
    origin: 'https://my.eu01.fortimonitor.com'
  });
  await client.savePortSelection({ serverId: 1, totalPortCount: 3 });
  assert.ok(captured.startsWith('https://my.eu01.fortimonitor.com/config/save_port_selection?'),
    `expected regional origin, got: ${captured}`);
});

test('probeSession reports the resolved tenant origin in its output', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ data: { ports: [] } }));
  const client = new FortimonitorClient({
    fetch: fetchMock,
    getCookie: async () => 'xsrf',
    origin: 'https://my.us02.fortimonitor.com'
  });
  const out = await client.probeSession();
  assert.equal(out.origin, 'https://my.us02.fortimonitor.com');
});

test('getCookie is called with the resolved origin so cookie lookup follows the tenant', async () => {
  const seen = [];
  const fetchMock = createFetchMock(async () => jsonResponse({ success: true }));
  const client = new FortimonitorClient({
    fetch: fetchMock,
    getCookie: async (name, urlOverride) => { seen.push({ name, urlOverride }); return 'xsrf'; },
    origin: 'https://my.us01.fortimonitor.com'
  });
  await client.savePortSelection({ serverId: 1, totalPortCount: 3 });
  assert.equal(seen[0].urlOverride, 'https://my.us01.fortimonitor.com');
});

// ----- getServerName (FMN-61) -------------------------------------

test('getServerName returns the name from pageData.instance.name on success', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({
    success: true,
    pageData: { instance: { id: 42024060, name: 'FGVM01TM24006844' } }
  }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  const name = await client.getServerName(42024060);
  assert.equal(name, 'FGVM01TM24006844');
});

test('getServerName sends server_id as a query param', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({
    pageData: { instance: { name: 'x' } }
  }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  await client.getServerName(42024060);
  assert.match(fetchMock.calls[0].url, /\/report\/get_idp_data\?server_id=42024060$/);
});

test('getServerName returns null on non-JSON (SPA-shell) response', async () => {
  const fetchMock = createFetchMock(async () => htmlResponse());
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  const name = await client.getServerName(99999999);
  assert.equal(name, null);
});

test('getServerName returns null on HTTP error', async () => {
  const fetchMock = createFetchMock(async () => errorResponse(500));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  assert.equal(await client.getServerName(1), null);
});

test('getServerName returns null when pageData.instance.name is missing', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ pageData: { instance: {} } }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  assert.equal(await client.getServerName(1), null);
});

test('getServerName returns null when name is an empty string', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ pageData: { instance: { name: '' } } }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  assert.equal(await client.getServerName(1), null);
});

test('getServerName returns null when fetch throws', async () => {
  const client = new FortimonitorClient({
    fetch: async () => { throw new Error('net'); },
    getCookie: async () => 'tok'
  });
  assert.equal(await client.getServerName(1), null);
});

test('getServerName returns null for null or undefined serverId', async () => {
  const client = new FortimonitorClient({
    fetch: async () => { throw new Error('should not fetch'); },
    getCookie: async () => 'tok'
  });
  assert.equal(await client.getServerName(null), null);
  assert.equal(await client.getServerName(undefined), null);
});

test('getServerName uses the injected origin', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ pageData: { instance: { name: 'n' } } }));
  const client = new FortimonitorClient({
    fetch: fetchMock,
    getCookie: async () => 'tok',
    origin: 'https://my.us01.fortimonitor.com'
  });
  await client.getServerName(1);
  assert.match(fetchMock.calls[0].url, /^https:\/\/my\.us01\.fortimonitor\.com\/report\/get_idp_data/);
});

// =====================================================================
// FMN-196: getFabricSystemData
// =====================================================================

test('getFabricSystemData returns the fabricSystemData blob augmented with isFabric + deviceSubType (FMN-211)', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({
    pageData: {
      instance: {
        name: 'FGVM01TM24006845',
        isFabric: true,
        deviceSubType: 'fortinet.fortigate',
        fabricSystemData: { model_name: 'FortiGate', model_number: 'FGVMA6', os_version: 'v7.6.3 build3510' }
      }
    }
  }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  const fsd = await client.getFabricSystemData(42024061);
  assert.deepEqual(fsd, {
    model_name: 'FortiGate',
    model_number: 'FGVMA6',
    os_version: 'v7.6.3 build3510',
    isFabric: true,
    deviceSubType: 'fortinet.fortigate'
  });
});

test('getFabricSystemData returns isFabric/deviceSubType as null when the instance lacks them (legacy response)', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({
    pageData: {
      instance: {
        fabricSystemData: { model_name: 'FortiGate', model_number: 'FGVMA6', os_version: 'v7.6.3' }
      }
    }
  }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  const fsd = await client.getFabricSystemData(1);
  assert.equal(fsd.isFabric, null);
  assert.equal(fsd.deviceSubType, null);
});

test('getFabricSystemData returns null when fabricSystemData is absent (non-Fortinet device)', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({
    pageData: { instance: { name: 'linux-server', fabricSystemData: null } }
  }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  assert.equal(await client.getFabricSystemData(1), null);
});

test('getFabricSystemData returns null on HTML / login redirect', async () => {
  const fetchMock = createFetchMock(async () => htmlResponse());
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => null });
  assert.equal(await client.getFabricSystemData(1), null);
});

test('getFabricSystemData returns null on null/undefined serverId', async () => {
  const client = new FortimonitorClient({
    fetch: async () => { throw new Error('should not fetch'); },
    getCookie: async () => 'tok'
  });
  assert.equal(await client.getFabricSystemData(null), null);
  assert.equal(await client.getFabricSystemData(undefined), null);
});

test('getFabricSystemData hits /report/get_idp_data on the injected origin', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ pageData: { instance: { fabricSystemData: {} } } }));
  const client = new FortimonitorClient({
    fetch: fetchMock,
    getCookie: async () => 'tok',
    origin: 'https://my.eu01.fortimonitor.com'
  });
  await client.getFabricSystemData(7);
  assert.equal(fetchMock.calls[0].url, 'https://my.eu01.fortimonitor.com/report/get_idp_data?server_id=7');
});

// =====================================================================
// FMN-196: getMonitoringPolicyPageData
// =====================================================================

test('getMonitoringPolicyPageData returns the parsed JSON envelope', async () => {
  const captured = { rulesets: [{ id: 1, name: 'r1' }], nounOptions: { device_types: [] }, success: true };
  const fetchMock = createFetchMock(async () => jsonResponse(captured));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  const out = await client.getMonitoringPolicyPageData();
  assert.deepEqual(out.rulesets, [{ id: 1, name: 'r1' }]);
  assert.deepEqual(out.nounOptions, { device_types: [] });
  assert.equal(fetchMock.calls[0].url, `${FM_ORIGIN}/monitoring_policy/get_page_data`);
});

test('getMonitoringPolicyPageData throws phase=auth on HTML login redirect', async () => {
  const fetchMock = createFetchMock(async () => htmlResponse(
    '<!DOCTYPE html><html>login</html>',
    { url: 'https://fortimonitor.forticloud.com/login' }
  ));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => null });
  await assert.rejects(client.getMonitoringPolicyPageData(), (err) => {
    return err instanceof FortimonitorError && err.phase === 'auth' && err.status === 200;
  });
});

test('getMonitoringPolicyPageData throws phase=read on HTTP failure', async () => {
  const fetchMock = createFetchMock(async () => errorResponse(500));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  await assert.rejects(client.getMonitoringPolicyPageData(), (err) => {
    return err instanceof FortimonitorError && err.phase === 'read' && err.status === 500;
  });
});

// =====================================================================
// FMN-196: createMonitoringPolicy
// =====================================================================

test('createMonitoringPolicy posts form-encoded body without X-XSRF-TOKEN', async () => {
  let captured;
  const fetchMock = createFetchMock(async (_url, init) => {
    captured = init;
    return jsonResponse({ success: true, ruleset: { id: 8812, name: 'Probe', latest_version: 0, config: { rules: [] } } });
  });
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  const ruleset = await client.createMonitoringPolicy({ name: 'Probe', index: 2, description: '' });
  assert.equal(ruleset.id, 8812);
  assert.equal(ruleset.name, 'Probe');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.equal(captured.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.equal(captured.headers['X-XSRF-TOKEN'], undefined, 'monitoring_policy POSTs must not carry XSRF');
  const params = new URLSearchParams(captured.body);
  assert.equal(params.get('index'), '2');
  assert.equal(params.get('name'), 'Probe');
  assert.equal(params.get('description'), '');
});

test('createMonitoringPolicy hits /monitoring_policy/addRuleset', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ success: true, ruleset: { id: 1, name: 'x' } }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  await client.createMonitoringPolicy({ name: 'x' });
  assert.equal(fetchMock.calls[0].url, `${FM_ORIGIN}/monitoring_policy/addRuleset`);
});

test('createMonitoringPolicy throws when name missing', async () => {
  const client = new FortimonitorClient({
    fetch: async () => { throw new Error('should not fetch'); },
    getCookie: async () => 'tok'
  });
  await assert.rejects(client.createMonitoringPolicy({}), TypeError);
});

test('createMonitoringPolicy throws phase=write when server returns success:false', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ success: false, error: 'duplicate name' }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  await assert.rejects(client.createMonitoringPolicy({ name: 'x' }), (err) => {
    return err instanceof FortimonitorError && err.phase === 'write';
  });
});

test('createMonitoringPolicy throws when ruleset payload absent on success', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ success: true }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  await assert.rejects(client.createMonitoringPolicy({ name: 'x' }), (err) => {
    return err instanceof FortimonitorError && /ruleset/i.test(err.message);
  });
});

// =====================================================================
// FMN-196: updateMonitoringPolicyConfig
// =====================================================================

test('updateMonitoringPolicyConfig posts ruleset_id and url-encoded config_json', async () => {
  let captured;
  const fetchMock = createFetchMock(async (_url, init) => {
    captured = init;
    return jsonResponse({ success: true, config: { rules: [] }, ruleset_id: 8812, version_id: 10935 });
  });
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  const config = { rules: [{ enabled: true, name: 'R1', conditions: [], actions: [] }] };
  const out = await client.updateMonitoringPolicyConfig(8812, config);
  assert.equal(out.version_id, 10935);
  const params = new URLSearchParams(captured.body);
  assert.equal(params.get('ruleset_id'), '8812');
  assert.deepEqual(JSON.parse(params.get('config_json')), config);
});

test('updateMonitoringPolicyConfig throws when args missing', async () => {
  const client = new FortimonitorClient({
    fetch: async () => { throw new Error('should not fetch'); },
    getCookie: async () => 'tok'
  });
  await assert.rejects(client.updateMonitoringPolicyConfig(null, { rules: [] }), TypeError);
  await assert.rejects(client.updateMonitoringPolicyConfig(1, null), TypeError);
});

// =====================================================================
// FMN-196: updateMonitoringPolicyMetadata
// =====================================================================

test('updateMonitoringPolicyMetadata posts ruleset_id + name + description', async () => {
  let captured;
  const fetchMock = createFetchMock(async (_url, init) => {
    captured = init;
    return jsonResponse({ success: true, ruleset: { id: 8812, name: 'Renamed' } });
  });
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  await client.updateMonitoringPolicyMetadata(8812, { name: 'Renamed' });
  const params = new URLSearchParams(captured.body);
  assert.equal(params.get('ruleset_id'), '8812');
  assert.equal(params.get('name'), 'Renamed');
  assert.equal(params.get('description'), '');
});

// =====================================================================
// FMN-196: deleteMonitoringPolicy
// =====================================================================

test('deleteMonitoringPolicy posts ruleset_id and returns the server response', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ success: true }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  const out = await client.deleteMonitoringPolicy(8812);
  assert.equal(out.success, true);
  assert.equal(fetchMock.calls[0].url, `${FM_ORIGIN}/monitoring_policy/deleteRuleset`);
});

test('deleteMonitoringPolicy throws when rulesetId missing', async () => {
  const client = new FortimonitorClient({
    fetch: async () => { throw new Error('should not fetch'); },
    getCookie: async () => 'tok'
  });
  await assert.rejects(client.deleteMonitoringPolicy(null), TypeError);
});

// =====================================================================
// Cross-cutting: monitoring_policy POSTs surface auth errors on HTML
// =====================================================================

test('monitoring_policy POST surfaces phase=auth on HTML login redirect', async () => {
  const fetchMock = createFetchMock(async () => htmlResponse(
    '<!DOCTYPE html><html>login</html>',
    { url: 'https://fortimonitor.forticloud.com/login' }
  ));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => null });
  await assert.rejects(client.createMonitoringPolicy({ name: 'x' }), (err) => {
    return err instanceof FortimonitorError && err.phase === 'auth';
  });
});

// =====================================================================
// FMN-200: createServerTemplate
// =====================================================================

test('createServerTemplate posts JSON body with X-XSRF-TOKEN and required fields', async () => {
  let captured;
  const fetchMock = createFetchMock(async (_url, init) => {
    captured = init;
    return jsonResponse({ success: true });
  });
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'xsrf-value' });
  await client.createServerTemplate({
    name: 'FortiGate FGVMA6 Stock',
    templateType: 'fabric_template',
    destinationGroup: 'grp-617598'
  });
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers['Content-Type'], 'application/json');
  assert.equal(captured.headers['X-XSRF-TOKEN'], 'xsrf-value');
  const body = JSON.parse(captured.body);
  assert.equal(body.template_name, 'FortiGate FGVMA6 Stock');
  assert.equal(body.template_type, 'fabric_template');
  assert.equal(body.element_ids, 'grp-617598');
  assert.equal(body.server_id, null);                  // shell mode
  assert.equal(body.select_options, 'no');             // shell default
  assert.equal(body.instance_grp_name, 'FortiGate FGVMA6 Stock');
  assert.equal(body.notification_schedule, 0);
});

test('createServerTemplate clone-from-device sets server_id', async () => {
  let captured;
  const fetchMock = createFetchMock(async (_url, init) => {
    captured = init;
    return jsonResponse({ success: true });
  });
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'xsrf' });
  await client.createServerTemplate({
    name: 'Cloned',
    templateType: 'fabric_template',
    destinationGroup: 'grp-1',
    sourceServerId: 42024075
  });
  const body = JSON.parse(captured.body);
  assert.equal(body.server_id, 42024075);
});

test('createServerTemplate throws when XSRF cookie is missing', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ success: true }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => null });
  await assert.rejects(
    client.createServerTemplate({ name: 'x', templateType: 'fabric_template', destinationGroup: 'grp-1' }),
    (err) => err instanceof FortimonitorError && err.phase === 'auth'
  );
  assert.equal(fetchMock.calls.length, 0, 'no fetch when XSRF missing');
});

test('createServerTemplate throws on missing required args', async () => {
  const client = new FortimonitorClient({
    fetch: async () => { throw new Error('should not fetch'); },
    getCookie: async () => 'xsrf'
  });
  await assert.rejects(client.createServerTemplate({}), TypeError);
  await assert.rejects(client.createServerTemplate({ name: 'x' }), TypeError);
  await assert.rejects(client.createServerTemplate({ name: 'x', templateType: 'fabric_template' }), TypeError);
});

test('createServerTemplate synthesizes a {success:true} envelope when response body is empty', async () => {
  const fetchMock = createFetchMock(async () => ({
    ok: true, status: 200, url: null,
    headers: new Map([['content-type', 'application/json; charset=utf-8']]),
    async json() { throw new SyntaxError('Unexpected end of JSON input'); },
    async text() { return ''; }
  }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'xsrf' });
  const out = await client.createServerTemplate({ name: 'x', templateType: 'fabric_template', destinationGroup: 'grp-1' });
  assert.deepEqual(out, { success: true });
});

test('createServerTemplate hits /config/createServerTemplate on the injected origin', async () => {
  let url;
  const fetchMock = createFetchMock(async (u) => { url = u; return jsonResponse({ success: true }); });
  const client = new FortimonitorClient({
    fetch: fetchMock,
    getCookie: async () => 'xsrf',
    origin: 'https://my.us02.fortimonitor.com'
  });
  await client.createServerTemplate({ name: 'x', templateType: 'fabric_template', destinationGroup: 'grp-1' });
  assert.equal(url, 'https://my.us02.fortimonitor.com/config/createServerTemplate');
});

// =====================================================================
// FMN-200: addTemplateMetric
// =====================================================================

test('addTemplateMetric posts form-encoded body with required field set and no XSRF', async () => {
  let captured;
  const fetchMock = createFetchMock(async (_url, init) => {
    captured = init;
    return jsonResponse({ success: true, server_resource_id: -123456 });
  });
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'xsrf' });
  await client.addTemplateMetric({
    templateId: 44017104,
    pluginTextkey: 'fortigate.resources',
    resourceTextkey: 'memory_usage_percent',
    pluginName: 'Memory Usage',
    resourceName: 'Memory Usage',
    units: '%'
  });
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(captured.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.equal(captured.headers['X-XSRF-TOKEN'], undefined, 'editAgentMetric must not send XSRF');
  const params = new URLSearchParams(captured.body);
  assert.equal(params.get('server_id'), '44017104');
  assert.equal(params.get('plugin_textkey'), 'fortigate.resources');
  assert.equal(params.get('resource_textkey'), 'memory_usage_percent');
  assert.equal(params.get('check_method'), 'fabric');
  assert.equal(params.get('action'), 'add');
  assert.equal(params.get('isTemplate'), 'true');
  assert.equal(params.get('template_from_scratch'), 'true');
  assert.equal(params.get('match_type'), 'positive_pattern');
  assert.equal(params.get('send_new'), 'true');
  assert.equal(params.get('frequency'), '60');
  assert.equal(params.get('units'), '%');
  assert.equal(params.get('server_resource_id'), '');
});

test('addTemplateMetric throws on missing required args', async () => {
  const client = new FortimonitorClient({
    fetch: async () => { throw new Error('should not fetch'); },
    getCookie: async () => 'xsrf'
  });
  await assert.rejects(client.addTemplateMetric({}), TypeError);
  await assert.rejects(client.addTemplateMetric({ templateId: 1 }), TypeError);
  await assert.rejects(client.addTemplateMetric({ templateId: 1, pluginTextkey: 'p' }), TypeError);
});

test('addTemplateMetric hits the lowercase /editAgentMetric endpoint', async () => {
  let url;
  const fetchMock = createFetchMock(async (u) => { url = u; return jsonResponse({ success: true }); });
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'xsrf' });
  await client.addTemplateMetric({
    templateId: 1,
    pluginTextkey: 'p',
    resourceTextkey: 'r'
  });
  // Important per FMN-203: capital E /EditAgentMetric is the form load
  // (read); lowercase e /editAgentMetric is the write.
  assert.match(url, /\/config\/monitoring\/editAgentMetric$/);
});

// =====================================================================
// FMN-200: getCreateServerTemplateData
// =====================================================================

test('getCreateServerTemplateData returns the JSON envelope', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({
    success: true,
    template_type_options: [{ value: 'fabric_template', label: 'Fabric Template' }],
    alert_timeline_options: [{ value: 0, label: 'Inherit' }]
  }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  const out = await client.getCreateServerTemplateData();
  assert.equal(out.template_type_options[0].value, 'fabric_template');
  assert.equal(fetchMock.calls[0].url, `${FM_ORIGIN}/config/get_create_server_template_data`);
});

// =====================================================================
// FMN-224: getMonitoringTree
// =====================================================================

test('getMonitoringTree POSTs to /util/monitoring_tree?include_templates=1 and returns the parsed body', async () => {
  const body = { nodes: [{ id: 'grp-0', 'node-type': 'group', text: 'All Instances', children: [] }], userHash: 'h' };
  const fetchMock = createFetchMock(async () => jsonResponse(body));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'xsrf' });
  const tree = await client.getMonitoringTree();
  assert.deepEqual(tree, body);
  assert.equal(fetchMock.calls.length, 1);
  assert.equal(fetchMock.calls[0].url, `${FM_ORIGIN}/util/monitoring_tree?include_templates=1`);
  assert.equal(fetchMock.calls[0].init.method, 'POST');
  assert.equal(fetchMock.calls[0].init.credentials, 'include');
  // X-XSRF-TOKEN attached when cookie present (matches captured browser request).
  assert.equal(fetchMock.calls[0].init.headers['X-XSRF-TOKEN'], 'xsrf');
});

test('getMonitoringTree omits X-XSRF-TOKEN when cookie helper returns null', async () => {
  const fetchMock = createFetchMock(async () => jsonResponse({ nodes: [] }));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => null });
  await client.getMonitoringTree();
  assert.ok(!('X-XSRF-TOKEN' in fetchMock.calls[0].init.headers));
});

test('getMonitoringTree throws FortimonitorError with phase=auth on HTML / login redirect', async () => {
  const fetchMock = createFetchMock(async () => htmlResponse());
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => null });
  await assert.rejects(
    () => client.getMonitoringTree(),
    (err) => err instanceof FortimonitorError && err.phase === 'auth'
  );
});

test('getMonitoringTree throws FortimonitorError with phase=read on non-2xx', async () => {
  const fetchMock = createFetchMock(async () => errorResponse(500, 'boom'));
  const client = new FortimonitorClient({ fetch: fetchMock, getCookie: async () => 'tok' });
  await assert.rejects(
    () => client.getMonitoringTree(),
    (err) => err instanceof FortimonitorError && err.phase === 'read' && err.status === 500
  );
});
