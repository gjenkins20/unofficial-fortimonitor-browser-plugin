// FMN-96: tests for the runtime dispatcher that turns codegen tool specs
// into PanoptaClient-backed handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodegenHandler,
  buildAllCodegenHandlers,
  stripSpecForApi
} from '../src/lib/claude-tools/codegen/dispatcher.js';

function makeFakeClient() {
  const calls = [];
  return {
    calls,
    _request: async (method, path, opts) => {
      calls.push({ method, path, opts: opts ?? null });
      return { res: { ok: true }, body: { ok: true, called: { method, path, opts: opts ?? null } } };
    }
  };
}

test('buildCodegenHandler substitutes path params and ignores empty query', async () => {
  const client = makeFakeClient();
  const handler = buildCodegenHandler({
    method: 'GET',
    path: '/server/{server_id}',
    pathParams: ['server_id'],
    queryParams: [],
    bodyParams: []
  }, client);
  await handler({ server_id: 42 });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, 'GET');
  assert.equal(client.calls[0].path, '/server/42');
  // Dispatcher passes `undefined` when there's no body; fake client coerces
  // to null in its recorded shape. Either way - no opts object.
  assert.equal(client.calls[0].opts, null);
});

test('buildCodegenHandler builds a query string from non-null query params', async () => {
  const client = makeFakeClient();
  const handler = buildCodegenHandler({
    method: 'GET',
    path: '/server',
    pathParams: [],
    queryParams: ['limit', 'offset', 'name'],
    bodyParams: []
  }, client);
  await handler({ limit: 10, offset: 20, name: null });
  assert.equal(client.calls[0].path, '/server?limit=10&offset=20');
});

test('buildCodegenHandler attaches a JSON body when bodyParams are present', async () => {
  const client = makeFakeClient();
  const handler = buildCodegenHandler({
    method: 'POST',
    path: '/server/{server_id}/server_attribute',
    pathParams: ['server_id'],
    queryParams: [],
    bodyParams: ['attribute_type', 'value']
  }, client);
  await handler({ server_id: 7, attribute_type: 12, value: 'production' });
  assert.equal(client.calls[0].method, 'POST');
  assert.equal(client.calls[0].path, '/server/7/server_attribute');
  assert.deepEqual(client.calls[0].opts, { body: { attribute_type: 12, value: 'production' } });
});

test('buildCodegenHandler throws when a required path param is missing', async () => {
  const client = makeFakeClient();
  const handler = buildCodegenHandler({
    method: 'DELETE',
    path: '/server/{server_id}',
    pathParams: ['server_id'],
    queryParams: [],
    bodyParams: []
  }, client);
  await assert.rejects(() => handler({}), /server_id/);
});

test('buildCodegenHandler URL-encodes path params', async () => {
  const client = makeFakeClient();
  const handler = buildCodegenHandler({
    method: 'GET',
    path: '/server/{name}',
    pathParams: ['name'],
    queryParams: [],
    bodyParams: []
  }, client);
  await handler({ name: 'fw 01/west' });
  assert.equal(client.calls[0].path, '/server/fw%2001%2Fwest');
});

test('buildAllCodegenHandlers builds a name -> handler map', async () => {
  const tools = [
    { name: 't1', _spec: { method: 'GET', path: '/a', pathParams: [], queryParams: [], bodyParams: [] } },
    { name: 't2', _spec: { method: 'GET', path: '/b', pathParams: [], queryParams: [], bodyParams: [] } }
  ];
  const handlers = buildAllCodegenHandlers(tools, makeFakeClient());
  assert.equal(typeof handlers.t1, 'function');
  assert.equal(typeof handlers.t2, 'function');
});

test('buildAllCodegenHandlers throws without a client', () => {
  assert.throws(() => buildAllCodegenHandlers([], null), /client is required/);
});

test('stripSpecForApi removes _spec and tier (Anthropic rejects unknown fields)', () => {
  const tool = {
    name: 'list_servers',
    tier: 'readonly',
    description: 'List servers',
    input_schema: { type: 'object' },
    _spec: { method: 'GET', path: '/server' }
  };
  const out = stripSpecForApi(tool);
  assert.equal(out._spec, undefined);
  assert.equal(out.tier, undefined);
  assert.equal(out.name, 'list_servers');
  assert.equal(out.description, 'List servers');
});
