import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanoptaClient, PanoptaError } from '../src/lib/panopta-client.js';
import { createFetchMock, jsonResponse, errorResponse } from './fixtures/chrome-mocks.js';

// ----- listTemplates ----------------------------

test('listTemplates: returns templates with id extracted from url', async () => {
  const fetch = createFetchMock(async () => jsonResponse({
    meta: { total_count: 2, limit: 100, offset: 0, next: null },
    server_template_list: [
      {
        url: 'https://api2.panopta.com/v2/server_template/40430873',
        name: 'FortiGate Baseline',
        template_type: 'dem_template',
        server_group: 'https://api2.panopta.com/v2/server_group/621243',
        applied_servers: ['https://api2.panopta.com/v2/server/40430881']
      },
      {
        url: 'https://api2.panopta.com/v2/server_template/40430874',
        name: 'APIs',
        template_type: 'dem_template',
        server_group: 'https://api2.panopta.com/v2/server_group/621243',
        applied_servers: []
      }
    ]
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const templates = await client.listTemplates();
  assert.equal(templates.length, 2);
  assert.deepEqual(templates[0], {
    id: 40430873,
    name: 'FortiGate Baseline',
    templateType: 'dem_template',
    serverGroupUrl: 'https://api2.panopta.com/v2/server_group/621243',
    resourceUrl: 'https://api2.panopta.com/v2/server_template/40430873',
    appliedServerUrls: ['https://api2.panopta.com/v2/server/40430881']
  });
  assert.equal(templates[1].id, 40430874);
});

test('listTemplates: follows pagination until total_count exhausted', async () => {
  const pages = [
    {
      meta: { total_count: 3, limit: 2, offset: 0, next: '...' },
      server_template_list: [
        { url: 'https://api2.panopta.com/v2/server_template/1', name: 'A' },
        { url: 'https://api2.panopta.com/v2/server_template/2', name: 'B' }
      ]
    },
    {
      meta: { total_count: 3, limit: 2, offset: 2, next: null },
      server_template_list: [
        { url: 'https://api2.panopta.com/v2/server_template/3', name: 'C' }
      ]
    }
  ];
  let i = 0;
  const fetch = createFetchMock(async () => jsonResponse(pages[i++]));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const templates = await client.listTemplates({ pageSize: 2 });
  assert.equal(templates.length, 3);
  assert.deepEqual(templates.map((t) => t.id), [1, 2, 3]);
  assert.equal(fetch.calls.length, 2);
  assert.match(fetch.calls[0].url, /offset=0/);
  assert.match(fetch.calls[1].url, /offset=2/);
});

test('listTemplates: missing applied_servers defaults to empty array', async () => {
  const fetch = createFetchMock(async () => jsonResponse({
    meta: { total_count: 1 },
    server_template_list: [
      { url: 'https://api2.panopta.com/v2/server_template/7', name: 'T' }
    ]
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const [t] = await client.listTemplates();
  assert.deepEqual(t.appliedServerUrls, []);
});

test('listTemplates: malformed response throws PanoptaError phase=read', async () => {
  const fetch = createFetchMock(async () => jsonResponse({ not_the_key: [] }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(
    () => client.listTemplates(),
    (err) => err instanceof PanoptaError && err.phase === 'read'
  );
});

test('listTemplates: 401 surfaces phase=auth', async () => {
  const fetch = createFetchMock(async () => errorResponse(401, { message: 'bad key' }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(
    () => client.listTemplates(),
    (err) => err instanceof PanoptaError && err.phase === 'auth' && err.status === 401
  );
});

// ----- listServerTemplateMappings ----------------------------

// ----- getServerTemplate (FMN-121) --------------

test('getServerTemplate: returns name + appliedServerIds parsed from server URLs', async () => {
  const fetch = createFetchMock(async (url) => {
    assert.match(url, /\/server_template\/501$/);
    return jsonResponse({
      url: 'https://api2.panopta.com/v2/server_template/501',
      name: 'Critical Infra',
      applied_servers: [
        'https://api2.panopta.com/v2/server/1001',
        'https://api2.panopta.com/v2/server/1002/',
        'malformed-row',
        'https://api2.panopta.com/v2/server/9999'
      ]
    });
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const tpl = await client.getServerTemplate(501);
  assert.equal(tpl.id, 501);
  assert.equal(tpl.name, 'Critical Infra');
  assert.deepEqual(tpl.appliedServerIds, [1001, 1002, 9999]);
  assert.equal(tpl.appliedServerUrls.length, 4);
});

test('getServerTemplate: missing applied_servers defaults to empty', async () => {
  const fetch = createFetchMock(async () => jsonResponse({
    url: 'https://api2.panopta.com/v2/server_template/777',
    name: 'Empty'
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const tpl = await client.getServerTemplate('777');
  assert.deepEqual(tpl.appliedServerIds, []);
  assert.deepEqual(tpl.appliedServerUrls, []);
});

test('getServerTemplate: malformed response throws PanoptaError', async () => {
  const fetch = createFetchMock(async () => jsonResponse(null));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(() => client.getServerTemplate(1), PanoptaError);
});

test('getServerTemplate: 404 propagates as PanoptaError with status=404', async () => {
  const fetch = createFetchMock(async () => errorResponse(404));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  try {
    await client.getServerTemplate(123);
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err instanceof PanoptaError, true);
    assert.equal(err.status, 404);
  }
});

test('getServerTemplate: requires templateId', async () => {
  const client = new PanoptaClient({ apiKey: 'k', fetch: () => { throw new Error('no'); } });
  await assert.rejects(() => client.getServerTemplate(null), TypeError);
  await assert.rejects(() => client.getServerTemplate(''), TypeError);
});

test('listServerTemplateMappings: extracts templateId from mapping url', async () => {
  const fetch = createFetchMock(async () => jsonResponse({
    meta: { total_count: 2, limit: 100, offset: 0, next: null },
    server_template_list: [
      { continuous: true, server_template: 'https://api2.panopta.com/v2/server_template/40430873' },
      { continuous: false, server_template: 'https://api2.panopta.com/v2/server_template/40430874' }
    ]
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const mappings = await client.listServerTemplateMappings(42024060);
  assert.equal(mappings.length, 2);
  assert.deepEqual(mappings[0], {
    continuous: true,
    templateUrl: 'https://api2.panopta.com/v2/server_template/40430873',
    templateId: 40430873
  });
  assert.equal(mappings[1].continuous, false);
  assert.equal(mappings[1].templateId, 40430874);
});

test('listServerTemplateMappings: encodes serverId in path', async () => {
  const fetch = createFetchMock(async () => jsonResponse({ server_template_list: [], meta: {} }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await client.listServerTemplateMappings('42024060');
  assert.match(fetch.calls[0].url, /\/server\/42024060\/template\?/);
});

test('listServerTemplateMappings: empty list is fine', async () => {
  const fetch = createFetchMock(async () => jsonResponse({
    meta: { total_count: 0 },
    server_template_list: []
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const mappings = await client.listServerTemplateMappings(42024060);
  assert.deepEqual(mappings, []);
});

test('listServerTemplateMappings: requires serverId', async () => {
  const fetch = createFetchMock(async () => jsonResponse({}));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(() => client.listServerTemplateMappings(), TypeError);
  await assert.rejects(() => client.listServerTemplateMappings(''), TypeError);
  await assert.rejects(() => client.listServerTemplateMappings(null), TypeError);
});

test('listServerTemplateMappings: malformed response throws PanoptaError phase=read', async () => {
  const fetch = createFetchMock(async () => jsonResponse({ wrong_key: [] }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(
    () => client.listServerTemplateMappings(1),
    (err) => err instanceof PanoptaError && err.phase === 'read'
  );
});

// ----- attachTemplate ----------------------------

test('attachTemplate: POSTs {continuous, server_template} to /server/{id}/template', async () => {
  const fetch = createFetchMock(async () => ({
    ok: true,
    status: 201,
    headers: new Map([
      ['location', 'https://api2.panopta.com/v2/server/42024060/template/9999'],
      ['id', '9999'],
      ['content-type', 'application/json']
    ]),
    async json() { return null; },
    async text() { return ''; }
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const result = await client.attachTemplate(42024060, {
    templateUrl: 'https://api2.panopta.com/v2/server_template/40430873'
  });
  assert.equal(result.status, 201);
  assert.equal(result.location, 'https://api2.panopta.com/v2/server/42024060/template/9999');
  assert.equal(result.resourceId, '9999');
  // Verify body
  const init = fetch.calls[0].init;
  const sent = JSON.parse(init.body);
  assert.deepEqual(sent, {
    continuous: true,
    server_template: 'https://api2.panopta.com/v2/server_template/40430873'
  });
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
});

test('attachTemplate: continuous=false honored', async () => {
  const fetch = createFetchMock(async () => jsonResponse(null, { status: 201 }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await client.attachTemplate(1, {
    templateUrl: 'https://api2.panopta.com/v2/server_template/2',
    continuous: false
  });
  const sent = JSON.parse(fetch.calls[0].init.body);
  assert.equal(sent.continuous, false);
});

test('attachTemplate: requires serverId and templateUrl', async () => {
  const fetch = createFetchMock(async () => jsonResponse(null, { status: 201 }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(() => client.attachTemplate(null, { templateUrl: 'u' }), TypeError);
  await assert.rejects(() => client.attachTemplate(1, {}), TypeError);
  await assert.rejects(() => client.attachTemplate(1, { templateUrl: '' }), TypeError);
});

test('attachTemplate: 400 surfaces phase=write', async () => {
  const fetch = createFetchMock(async () => errorResponse(400, { message: 'server_group mismatch' }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(
    () => client.attachTemplate(1, { templateUrl: 'u' }),
    (err) => err instanceof PanoptaError && err.status === 400 && err.phase === 'write'
  );
});

// ----- detachTemplate ----------------------------

test('detachTemplate: DELETE with default strategy=dissociate', async () => {
  const fetch = createFetchMock(async () => ({
    ok: true,
    status: 204,
    headers: new Map(),
    async json() { return null; },
    async text() { return ''; }
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const result = await client.detachTemplate(42024060, 40430873);
  assert.equal(result.status, 204);
  const init = fetch.calls[0].init;
  assert.equal(init.method, 'DELETE');
  assert.match(fetch.calls[0].url, /\/server\/42024060\/template\/40430873$/);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { strategy: 'dissociate' });
});

test('detachTemplate: strategy=delete sent in body', async () => {
  const fetch = createFetchMock(async () => ({
    ok: true, status: 204, headers: new Map(),
    async json() { return null; }, async text() { return ''; }
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await client.detachTemplate(1, 2, { strategy: 'delete' });
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { strategy: 'delete' });
});

test('detachTemplate: rejects unknown strategy', async () => {
  const fetch = createFetchMock(async () => jsonResponse(null));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(
    () => client.detachTemplate(1, 2, { strategy: 'nuke' }),
    TypeError
  );
  // fetch should not have been called - validation is pre-flight
  assert.equal(fetch.calls.length, 0);
});

test('detachTemplate: requires serverId and templateId', async () => {
  const fetch = createFetchMock(async () => jsonResponse(null));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(() => client.detachTemplate(null, 1), TypeError);
  await assert.rejects(() => client.detachTemplate(1, null), TypeError);
  await assert.rejects(() => client.detachTemplate(1, 0), TypeError);
});

test('detachTemplate: 404 surfaces phase=write (treated as not-attached by caller)', async () => {
  const fetch = createFetchMock(async () => errorResponse(404, { message: 'not found' }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(
    () => client.detachTemplate(1, 2),
    (err) => err instanceof PanoptaError && err.status === 404
  );
});

test('detachTemplate: 401 surfaces phase=auth', async () => {
  const fetch = createFetchMock(async () => errorResponse(401, { message: 'bad key' }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(
    () => client.detachTemplate(1, 2),
    (err) => err instanceof PanoptaError && err.phase === 'auth'
  );
});
