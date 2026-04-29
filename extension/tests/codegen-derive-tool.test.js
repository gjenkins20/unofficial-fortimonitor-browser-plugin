// FMN-96: tests for the codegen transform functions.
// FMN-108: tests for the collision-resolving naming heuristic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  pluralize,
  deriveDomain,
  lastResource,
  pathTargetsSingleResource,
  deriveToolName,
  pathAncestors,
  deriveToolNameWithLevel,
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

test('deriveToolName: POST on a single-resource path -> replace_<resource> (FMN-108)', () => {
  // POST on a path whose last segment is a placeholder is REST-anomalous;
  // it indicates upsert-style behavior where the client supplies the id.
  // Distinct from POST on a collection so /contact/{id}/contact_info and
  // /contact/{id}/contact_info/{contact_info_id} get distinct names.
  assert.equal(deriveToolName('/server/{server_id}', 'post'), 'replace_server');
  assert.equal(
    deriveToolName('/contact/{contact_id}/contact_info/{contact_info_id}', 'post'),
    'replace_contact_info'
  );
  // Sanity: POST on collection still maps to create_*.
  assert.equal(
    deriveToolName('/contact/{contact_id}/contact_info', 'post'),
    'create_contact_info'
  );
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

test('pathAncestors: returns non-placeholder ancestors closest-first, excluding last-resource segment', () => {
  assert.deepEqual(pathAncestors('/server'), []);
  assert.deepEqual(pathAncestors('/server/{server_id}'), []);
  assert.deepEqual(pathAncestors('/server/{server_id}/server_attribute'), ['server']);
  assert.deepEqual(pathAncestors('/server_group/{id}/server'), ['server_group']);
  assert.deepEqual(pathAncestors('/public/outage/{HASH}/acknowledge'), ['outage', 'public']);
  assert.deepEqual(
    pathAncestors('/server/{server_id}/agent_resource/{agent_resource_id}/agent_resource_threshold/{tid}/countermeasure'),
    ['agent_resource_threshold', 'agent_resource', 'server']
  );
});

test('deriveToolNameWithLevel: level 0 is the base verb_lastSeg name', () => {
  assert.equal(deriveToolNameWithLevel('/server', 'get', 0), 'list_servers');
  assert.equal(deriveToolNameWithLevel('/outage/{id}/acknowledge', 'put', 0), 'update_acknowledge');
  assert.equal(deriveToolNameWithLevel('/server_group/{id}/server', 'get', 0), 'list_servers');
});

test('deriveToolNameWithLevel: level k prepends k closest ancestors outermost-first', () => {
  // Single-ancestor escalation
  assert.equal(deriveToolNameWithLevel('/outage/{id}/acknowledge', 'put', 1),
               'update_outage_acknowledge');
  assert.equal(deriveToolNameWithLevel('/server_group/{id}/server', 'get', 1),
               'list_server_group_servers');
  // Two-ancestor escalation: outermost-first ordering
  assert.equal(deriveToolNameWithLevel('/public/outage/{HASH}/acknowledge', 'put', 1),
               'update_outage_acknowledge');
  assert.equal(deriveToolNameWithLevel('/public/outage/{HASH}/acknowledge', 'put', 2),
               'update_public_outage_acknowledge');
});

test('deriveToolNameWithLevel: caps at available ancestor count', () => {
  // Asking for level 5 on a path with 0 ancestors keeps the base name.
  assert.equal(deriveToolNameWithLevel('/server', 'get', 5), 'list_servers');
  // Asking for level 5 on a path with 2 ancestors caps at 2.
  assert.equal(deriveToolNameWithLevel('/public/outage/{HASH}/acknowledge', 'put', 5),
               'update_public_outage_acknowledge');
});

test('compileToolsByDomain: collision resolution disambiguates colliding base names', () => {
  // Three different paths that all yield list_servers at level 0:
  //   /server                            (0 ancestors, can't escalate)
  //   /server_group/{id}/server          (1 ancestor)
  //   /cloud_credential/{id}/server      (1 ancestor)
  // Expected: /server keeps list_servers, others get a single-ancestor prefix.
  const spec = {
    paths: {
      '/server': { get: { summary: 'List servers', parameters: [] } },
      '/server_group/{id}/server': {
        get: { summary: 'List servers in group', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] }
      },
      '/cloud_credential/{id}/server': {
        get: { summary: 'List servers for credential', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] }
      }
    }
  };
  const grouped = compileToolsByDomain(spec);
  const allNames = Object.values(grouped).flatMap((tools) => tools.map((t) => t.name));
  assert.equal(new Set(allNames).size, allNames.length, `expected unique names, got ${allNames.join(', ')}`);
  assert.ok(allNames.includes('list_servers'), 'canonical /server keeps list_servers');
  assert.ok(allNames.includes('list_server_group_servers'));
  assert.ok(allNames.includes('list_cloud_credential_servers'));
});

test('compileToolsByDomain: nested collision escalates only as far as needed for uniqueness', () => {
  // Two paths whose closest ancestor is the same (`outage`) share the
  // level-1 disambiguated name; the deeper path must escalate to level 2
  // to disambiguate.
  const spec = {
    paths: {
      '/outage/{id}/acknowledge': {
        put: { summary: 'Acknowledge outage', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] }
      },
      '/public/outage/{HASH}/acknowledge': {
        put: { summary: 'Public acknowledge', parameters: [{ name: 'HASH', in: 'path', required: true, schema: { type: 'string' } }] }
      }
    }
  };
  const grouped = compileToolsByDomain(spec);
  const names = Object.values(grouped).flatMap((tools) => tools.map((t) => t.name));
  assert.equal(new Set(names).size, names.length, `expected unique names, got ${names.join(', ')}`);
  assert.ok(names.includes('update_outage_acknowledge'));
  assert.ok(names.includes('update_public_outage_acknowledge'));
});

test('compileToolsByDomain: regression - live OpenAPI yields 262 unique tool names', () => {
  const specPath = path.resolve(
    process.env.HOME || '',
    'Projects/fortimonitor-schema-discovery/data/compiled/openapi.json'
  );
  if (!fs.existsSync(specPath)) {
    // The schema-discovery checkout is a sibling project; in environments
    // where it isn't present (e.g. fresh CI without that repo), skip
    // rather than fail. The synthetic collision tests above cover the
    // algorithm; this regression guards against the live spec drifting.
    console.log(`# skip live OpenAPI regression - ${specPath} not found`);
    return;
  }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const grouped = compileToolsByDomain(spec);
  const allTools = Object.values(grouped).flat();
  // Total operation count must equal the OpenAPI's operation count. The
  // ticket's headline goal is "all 262 surface" - if compileToolsByDomain
  // ever drops or duplicates an operation, this fires.
  assert.equal(allTools.length, 262, `expected 262 tools, got ${allTools.length}`);

  // Zero collisions: every operation produces a unique tool name. Any
  // remaining collision is a regression we want to catch loudly. Per
  // FMN-108, the previously-known persistent collision (POST on
  // /contact/{contact_id}/contact_info{,/{contact_info_id}}) is now
  // resolved by the POST-on-single-resource -> replace_<resource>
  // heuristic, so this assertion can be strict.
  const byName = new Map();
  for (const t of allTools) {
    if (!byName.has(t.name)) byName.set(t.name, []);
    byName.get(t.name).push(t);
  }
  const collisions = [...byName.entries()].filter(([, ts]) => ts.length > 1);
  assert.equal(
    collisions.length,
    0,
    `expected zero collisions; got: ${collisions.map(([n, ts]) => `${n}(${ts.map((t) => t._spec.path).join(', ')})`).join('; ')}`
  );
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
