import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PanoptaClient,
  PanoptaError,
  parseServerListResponse
} from '../src/lib/panopta-client.js';
import { createFetchMock, jsonResponse, errorResponse } from './fixtures/chrome-mocks.js';

// ----- parseServerListResponse ----------------------------

test('parseServerListResponse returns id/name/resourceUrl per item', () => {
  const items = parseServerListResponse({
    server_list: [
      { id: 42024060, name: 'FGVM01TM24006844', resource_uri: '/v2/server/42024060' },
      { id: 42024061, name: 'FGVM01TM24006845', resource_uri: '/v2/server/42024061' }
    ]
  });
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: 42024060,
    name: 'FGVM01TM24006844',
    resourceUrl: 'https://api2.panopta.com/v2/server/42024060'
  });
});

test('parseServerListResponse handles missing name with #id fallback', () => {
  const items = parseServerListResponse({ server_list: [{ id: 9, resource_uri: '/v2/server/9' }] });
  assert.equal(items[0].name, '#9');
});

test('parseServerListResponse handles missing resource_uri', () => {
  const items = parseServerListResponse({ server_list: [{ id: 9, name: 'x' }] });
  assert.equal(items[0].resourceUrl, null);
});

test('parseServerListResponse throws when wrapper key is wrong', () => {
  assert.throws(() => parseServerListResponse({ objects: [] }), PanoptaError);
  assert.throws(() => parseServerListResponse(null), PanoptaError);
  assert.throws(() => parseServerListResponse({}), PanoptaError);
});

test('parseServerListResponse handles empty list', () => {
  assert.deepEqual(parseServerListResponse({ server_list: [] }), []);
});

test('parseServerListResponse extracts id from url when top-level id is absent', () => {
  // Real /v2/server shape (verified against a captured live response):
  // items carry `url` with the id embedded in the path, and no top-level
  // `id` or `resource_uri`. Regression for FMN-50 post-merge bug where
  // UI rendered "undefined" as the server id.
  const items = parseServerListResponse({
    server_list: [
      { name: 'FGVM01TM24006844', url: 'https://api2.panopta.com/v2/server/40234446' },
      { name: 'edge-router', url: 'https://api2.panopta.com/v2/server/40234449/' }
    ]
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 40234446);
  assert.equal(items[0].name, 'FGVM01TM24006844');
  assert.equal(items[0].resourceUrl, 'https://api2.panopta.com/v2/server/40234446');
  assert.equal(items[1].id, 40234449);
});

test('parseServerListResponse: id is null when neither id nor url is present', () => {
  const items = parseServerListResponse({ server_list: [{ name: 'orphan' }] });
  assert.equal(items[0].id, null);
  assert.equal(items[0].name, 'orphan');
  assert.equal(items[0].resourceUrl, null);
});

// ----- lookupServersByName ----------------------------

test('lookupServersByName: server-side substring is filtered to exact match', async () => {
  // Probing the live API with prefix "FGVM01TM2400684" returned 3 hits (the
  // three test devices). Client must enforce equality on top — only the
  // exactly-matching name survives.
  const fetch = createFetchMock(async () => jsonResponse({
    meta: { total_count: 3, limit: 50, offset: 0 },
    server_list: [
      { id: 42024060, name: 'FGVM01TM24006844', resource_uri: '/v2/server/42024060' },
      { id: 42024061, name: 'FGVM01TM24006845', resource_uri: '/v2/server/42024061' },
      { id: 42024075, name: 'FGVM01TM24006846', resource_uri: '/v2/server/42024075' }
    ]
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const matches = await client.lookupServersByName('FGVM01TM24006845');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 42024061);
  assert.equal(matches[0].name, 'FGVM01TM24006845');
});

test('lookupServersByName: returns empty when no exact match in server-side hits', async () => {
  // Server returns hits because the term is a substring of every name, but
  // none equals the term exactly.
  const fetch = createFetchMock(async () => jsonResponse({
    server_list: [
      { id: 1, name: 'FGVM01TM24006844', resource_uri: '/v2/server/1' },
      { id: 2, name: 'FGVM01TM24006845', resource_uri: '/v2/server/2' }
    ]
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const matches = await client.lookupServersByName('FGVM01TM2400684'); // prefix only
  assert.equal(matches.length, 0);
});

test('lookupServersByName: returns multiple when the same name appears twice (ambiguous)', async () => {
  const fetch = createFetchMock(async () => jsonResponse({
    server_list: [
      { id: 1, name: 'edge-router', resource_uri: '/v2/server/1' },
      { id: 2, name: 'edge-router', resource_uri: '/v2/server/2' }
    ]
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const matches = await client.lookupServersByName('edge-router');
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((m) => m.id).sort(), [1, 2]);
});

test('lookupServersByName: returns empty for zero hits', async () => {
  const fetch = createFetchMock(async () => jsonResponse({ server_list: [] }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const matches = await client.lookupServersByName('nope');
  assert.equal(matches.length, 0);
});

test('lookupServersByName: 401 surfaces phase=auth PanoptaError', async () => {
  const fetch = createFetchMock(async () => errorResponse(401, { message: 'bad key' }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(
    () => client.lookupServersByName('x'),
    (err) => err instanceof PanoptaError && err.phase === 'auth' && err.status === 401
  );
});

test('lookupServersByName: network error surfaces phase=network PanoptaError', async () => {
  const fetch = createFetchMock(async () => { throw new TypeError('Failed to fetch'); });
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(
    () => client.lookupServersByName('x'),
    (err) => err instanceof PanoptaError && err.phase === 'network'
  );
});

test('lookupServersByName: name is required', async () => {
  const fetch = createFetchMock(async () => jsonResponse({ server_list: [] }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(() => client.lookupServersByName(''), TypeError);
  await assert.rejects(() => client.lookupServersByName(null), TypeError);
  await assert.rejects(() => client.lookupServersByName(undefined), TypeError);
});

test('lookupServersByName: encodes special characters in name', async () => {
  const fetch = createFetchMock(async () => jsonResponse({ server_list: [] }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await client.lookupServersByName('a&b c');
  assert.match(fetch.calls[0].url, /\/server\?name=a%26b%20c/);
});
