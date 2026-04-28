// FMN-96: tests for the codegen transform functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pluralize,
  deriveDomain,
  lastResource,
  pathTargetsSingleResource,
  deriveToolName,
  deriveTier,
  normalizeParamSchema,
  operationToTool,
  compileToolsByDomain,
  stableStringify
} from '../../tools/codegen/derive-tool.mjs';

test('pluralize handles common English forms', () => {
  assert.equal(pluralize('server'), 'servers');
  assert.equal(pluralize('outage'), 'outages');
  assert.equal(pluralize('policy'), 'policies');
  assert.equal(pluralize('address'), 'addresses');
  assert.equal(pluralize('box'), 'boxes');
  assert.equal(pluralize('match'), 'matches');
  assert.equal(pluralize('day'), 'days');           // vowel-y stays -ays
  assert.equal(pluralize('onsight_group'), 'onsight_groups');
});

test('deriveDomain takes the first non-placeholder segment, pluralized', () => {
  assert.equal(deriveDomain('/server'), 'servers');
  assert.equal(deriveDomain('/server/{server_id}'), 'servers');
  assert.equal(deriveDomain('/server/{server_id}/server_attribute'), 'servers');
  assert.equal(deriveDomain('/cloud_credential/{id}/cloud_discovery'), 'cloud_credentials');
  assert.equal(deriveDomain('/outage'), 'outages');
});

test('lastResource returns the last non-placeholder segment', () => {
  assert.equal(lastResource('/server'), 'server');
  assert.equal(lastResource('/server/{server_id}'), 'server');
  assert.equal(lastResource('/server/{server_id}/server_attribute'), 'server_attribute');
  assert.equal(lastResource('/server/{id}/server_attribute/{aid}'), 'server_attribute');
});

test('pathTargetsSingleResource only true when last segment is a placeholder', () => {
  assert.equal(pathTargetsSingleResource('/server'), false);
  assert.equal(pathTargetsSingleResource('/server/{server_id}'), true);
  assert.equal(pathTargetsSingleResource('/server/{server_id}/server_attribute'), false);
  assert.equal(pathTargetsSingleResource('/server/{id}/server_attribute/{aid}'), true);
});

test('deriveToolName: GET on collection -> list_<plural>', () => {
  assert.equal(deriveToolName('/server', 'get'), 'list_servers');
  assert.equal(deriveToolName('/outage', 'GET'), 'list_outages');
  assert.equal(deriveToolName('/server/{server_id}/server_attribute', 'get'),
               'list_server_attributes');
});

test('deriveToolName: GET on single resource -> get_<resource>', () => {
  assert.equal(deriveToolName('/server/{server_id}', 'get'), 'get_server');
  assert.equal(deriveToolName('/server/{id}/server_attribute/{aid}', 'get'),
               'get_server_attribute');
});

test('deriveToolName: POST/PUT/PATCH/DELETE map to create/update/delete', () => {
  assert.equal(deriveToolName('/server', 'post'), 'create_server');
  assert.equal(deriveToolName('/server/{server_id}', 'put'), 'update_server');
  assert.equal(deriveToolName('/server/{server_id}', 'patch'), 'update_server');
  assert.equal(deriveToolName('/server/{server_id}', 'delete'), 'delete_server');
});

test('deriveTier: GET is readonly, everything else is readwrite', () => {
  assert.equal(deriveTier('GET'), 'readonly');
  assert.equal(deriveTier('get'), 'readonly');
  assert.equal(deriveTier('POST'), 'readwrite');
  assert.equal(deriveTier('PUT'), 'readwrite');
  assert.equal(deriveTier('DELETE'), 'readwrite');
});

test('normalizeParamSchema: plain types pass through', () => {
  assert.deepEqual(
    normalizeParamSchema({ type: 'integer', description: 'Page size' }),
    { type: 'integer', description: 'Page size' }
  );
  assert.deepEqual(
    normalizeParamSchema({ type: 'string', enum: ['a', 'b'] }),
    { type: 'string', enum: ['a', 'b'] }
  );
});

test('normalizeParamSchema: $ref bodies become a generic object stub', () => {
  const out = normalizeParamSchema({ $ref: '#/components/schemas/Server' });
  assert.equal(out.type, 'object');
  assert.ok(out.description);
});

test('operationToTool: GET with path + query parameters', () => {
  const tool = operationToTool('/server/{server_id}/server_attribute', 'get', {
    summary: 'Get server attributes',
    parameters: [
      { name: 'server_id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', description: 'Page size' } }
    ]
  });
  assert.equal(tool.name, 'list_server_attributes');
  assert.equal(tool.tier, 'readonly');
  assert.equal(tool.description, 'Get server attributes');
  assert.equal(tool._spec.method, 'GET');
  assert.equal(tool._spec.path, '/server/{server_id}/server_attribute');
  assert.deepEqual(tool._spec.pathParams, ['server_id']);
  assert.deepEqual(tool._spec.queryParams, ['limit']);
  assert.deepEqual(tool._spec.bodyParams, []);
  assert.deepEqual(tool.input_schema.required, ['server_id']);
});

test('operationToTool: POST with requestBody lifts body fields into input_schema', () => {
  const tool = operationToTool('/server/{server_id}/server_attribute', 'post', {
    summary: 'Create attribute',
    parameters: [
      { name: 'server_id', in: 'path', required: true, schema: { type: 'integer' } }
    ],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['attribute_type'],
            properties: {
              attribute_type: { type: 'integer', description: 'Type id' },
              value: { type: 'string' }
            }
          }
        }
      }
    }
  });
  assert.equal(tool.name, 'create_server_attribute');
  assert.equal(tool.tier, 'readwrite');
  assert.deepEqual(tool._spec.bodyParams, ['attribute_type', 'value']);
  assert.deepEqual(tool._spec.pathParams, ['server_id']);
  // server_id (path-required) and attribute_type (body-required) are both in required
  assert.ok(tool.input_schema.required.includes('server_id'));
  assert.ok(tool.input_schema.required.includes('attribute_type'));
});

test('compileToolsByDomain: groups by first path segment, sorts alphabetically by tool name', () => {
  const spec = {
    paths: {
      '/server': {
        get: { summary: 'List servers', parameters: [] },
        post: { summary: 'Create server' }
      },
      '/outage': {
        get: { summary: 'List outages', parameters: [] }
      },
      '/server/{server_id}': {
        get: { summary: 'Get server', parameters: [{ name: 'server_id', in: 'path', required: true, schema: { type: 'integer' } }] }
      }
    }
  };
  const grouped = compileToolsByDomain(spec);
  assert.deepEqual(Object.keys(grouped).sort(), ['outages', 'servers']);
  assert.equal(grouped.servers.length, 3);
  // Sorted alphabetically by name within domain.
  assert.deepEqual(grouped.servers.map((t) => t.name), ['create_server', 'get_server', 'list_servers']);
});

test('stableStringify: same input yields byte-identical output across runs', () => {
  // Insertion order shouldn't matter; output is sorted by key.
  const a = { z: 1, a: 2, m: { y: 3, x: 4 } };
  const b = { a: 2, m: { x: 4, y: 3 }, z: 1 };
  assert.equal(stableStringify(a, 0), stableStringify(b, 0));
});
