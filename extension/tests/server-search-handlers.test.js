import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRetryable,
  matchesAttribute,
  matchesName,
  matchesFqdn,
  matchesTag,
  matchesStatus,
  matchesDeviceType,
  matchesHasActiveOutage,
  matchesAppliedTemplate,
  matchOneCriterion,
  matchesByCriteria,
  shapeMatch,
  fetchActiveOutageServerIds,
  fetchAppliedTemplateSets,
  resolveIdentifiers,
  findServers,
  createServerSearchHandlers
} from '../src/background/server-search-handlers.js';
import { PanoptaError } from '../src/lib/panopta-client.js';

// =====================================================================
// matchesAttribute (carried forward, signature unchanged for `info` field)
// =====================================================================

const modelAttrs = (value) => [
  { name: 'Operating System', textkey: 'server.os', value: 'Linux' },
  { name: 'Model', textkey: 'dem.model', value }
];

test('matchesAttribute: exact match (case-insensitive default)', () => {
  const r = matchesAttribute({ attributes: modelAttrs('FGT60F') }, { attributeName: 'Model', value: 'fgt60f' });
  assert.equal(r.matched, true);
  assert.equal(r.info.value, 'FGT60F');
});

test('matchesAttribute: textkey lookup also works', () => {
  const r = matchesAttribute({ attributes: modelAttrs('FGT60F') }, { attributeName: 'dem.model', value: 'FGT60F' });
  assert.equal(r.matched, true);
});

test('matchesAttribute: substring mode and case-sensitive options', () => {
  const server = { attributes: modelAttrs('FGT60F-Bypass') };
  assert.equal(matchesAttribute(server, { attributeName: 'Model', value: 'FGT60F' }).matched, false);
  assert.equal(matchesAttribute(server, { attributeName: 'Model', value: 'FGT60F', exactMatch: false }).matched, true);
  assert.equal(matchesAttribute({ attributes: modelAttrs('FGT60F') }, { attributeName: 'Model', value: 'fgt60f', caseInsensitive: false }).matched, false);
});

test('matchesAttribute: no attributes / missing args / non-attribute fields all miss', () => {
  assert.equal(matchesAttribute({ name: 'x' }, { attributeName: 'Model', value: 'FGT60F' }).matched, false);
  assert.equal(matchesAttribute({ attributes: modelAttrs('FGT60F') }, { value: 'FGT60F' }).matched, false);
  assert.equal(matchesAttribute({ name: 'FGT60F-router', tags: ['FGT60F'], attributes: modelAttrs('Linux') }, { attributeName: 'Model', value: 'FGT60F' }).matched, false);
});

// =====================================================================
// matchesName / matchesFqdn / matchesTag / matchesStatus / matchesDeviceType
// =====================================================================

test('matchesName: exact and substring on server.name', () => {
  const server = { name: 'edge-fgt-01' };
  assert.equal(matchesName(server, { value: 'edge-fgt-01' }).matched, true);
  assert.equal(matchesName(server, { value: 'EDGE-FGT-01' }).matched, true); // case-insensitive default
  assert.equal(matchesName(server, { value: 'edge', exactMatch: false }).matched, true);
  assert.equal(matchesName(server, { value: 'edge' }).matched, false); // exact default
});

test('matchesFqdn: matches primary fqdn or any of additional_fqdns', () => {
  const server = { fqdn: 'edge.example.com', additional_fqdns: ['10.0.0.1', 'edge.local'] };
  assert.equal(matchesFqdn(server, { value: 'edge.example.com' }).matched, true);
  assert.equal(matchesFqdn(server, { value: '10.0.0.1' }).matched, true);
  assert.equal(matchesFqdn(server, { value: 'edge.local' }).matched, true);
  assert.equal(matchesFqdn(server, { value: 'example', exactMatch: false }).matched, true);
  assert.equal(matchesFqdn(server, { value: 'nope' }).matched, false);
});

test('matchesTag: any-of match against server.tags[]', () => {
  const server = { tags: ['production', 'edge', 'wan'] };
  assert.equal(matchesTag(server, { value: 'production' }).matched, true);
  assert.equal(matchesTag(server, { value: 'PRODUCTION' }).matched, true); // case-insensitive default
  assert.equal(matchesTag(server, { value: 'prod', exactMatch: false }).matched, true);
  assert.equal(matchesTag(server, { value: 'staging' }).matched, false);
  assert.equal(matchesTag({}, { value: 'production' }).matched, false);
});

test('matchesStatus: enum equality (case-insensitive)', () => {
  assert.equal(matchesStatus({ status: 'active' }, { value: 'active' }).matched, true);
  assert.equal(matchesStatus({ status: 'Active' }, { value: 'active' }).matched, true);
  assert.equal(matchesStatus({ status: 'paused' }, { value: 'active' }).matched, false);
});

test('matchesDeviceType: hits device_type or device_sub_type', () => {
  const server = { device_type: 'network_device', device_sub_type: 'fortigate' };
  assert.equal(matchesDeviceType(server, { value: 'network_device' }).matched, true);
  assert.equal(matchesDeviceType(server, { value: 'fortigate' }).matched, true);
  assert.equal(matchesDeviceType(server, { value: 'network', exactMatch: false }).matched, true);
  assert.equal(matchesDeviceType(server, { value: 'router' }).matched, false);
});

test('matchesHasActiveOutage: ctx-driven boolean', () => {
  const ctx = { activeOutageServerIds: new Set([42, 99]) };
  assert.equal(matchesHasActiveOutage({ id: 42 }, { value: true }, ctx).matched, true);
  assert.equal(matchesHasActiveOutage({ id: 42 }, { value: false }, ctx).matched, false);
  assert.equal(matchesHasActiveOutage({ id: 1 }, { value: false }, ctx).matched, true);
  assert.equal(matchesHasActiveOutage({ id: 1 }, { value: true }, ctx).matched, false);
});

test('matchesHasActiveOutage: no ctx Set => never matches', () => {
  assert.equal(matchesHasActiveOutage({ id: 42 }, { value: true }).matched, false);
});

// =====================================================================
// matchesAppliedTemplate (FMN-121)
// =====================================================================

test('matchesAppliedTemplate: attached/not_attached against ctx Map<url, Set<id>>', () => {
  const ctx = {
    appliedTemplateSets: new Map([
      ['/server_template/501', new Set([1001, 1002])],
      ['/server_template/502', new Set([])]
    ])
  };
  // attached match
  assert.equal(matchesAppliedTemplate({ id: 1001 }, { templateUrl: '/server_template/501', match: 'attached' }, ctx).matched, true);
  // not attached, mode=attached -> miss
  assert.equal(matchesAppliedTemplate({ id: 9999 }, { templateUrl: '/server_template/501', match: 'attached' }, ctx).matched, false);
  // not attached, mode=not_attached -> hit
  assert.equal(matchesAppliedTemplate({ id: 9999 }, { templateUrl: '/server_template/501', match: 'not_attached' }, ctx).matched, true);
  // attached, mode=not_attached -> miss
  assert.equal(matchesAppliedTemplate({ id: 1001 }, { templateUrl: '/server_template/501', match: 'not_attached' }, ctx).matched, false);
  // unknown templateUrl -> miss
  assert.equal(matchesAppliedTemplate({ id: 1001 }, { templateUrl: '/server_template/999', match: 'attached' }, ctx).matched, false);
  // missing ctx Map -> miss
  assert.equal(matchesAppliedTemplate({ id: 1001 }, { templateUrl: '/server_template/501' }).matched, false);
});

test('matchesAppliedTemplate: attached match info carries name + flag', () => {
  const ctx = { appliedTemplateSets: new Map([['/server_template/501', new Set([42])]]) };
  const r = matchesAppliedTemplate({ id: 42 }, { templateUrl: '/server_template/501', templateName: 'Critical Infra' }, ctx);
  assert.equal(r.matched, true);
  assert.equal(r.info.templateName, 'Critical Infra');
  assert.equal(r.info.attached, true);
});

test('fetchAppliedTemplateSets: one getServerTemplate call per unique templateUrl', async () => {
  const calls = [];
  const fakeClient = {
    async getServerTemplate(id) {
      calls.push(id);
      if (id === '501') return { id: 501, name: 'A', appliedServerUrls: [], appliedServerIds: [1, 2, 3] };
      if (id === '502') return { id: 502, name: 'B', appliedServerUrls: [], appliedServerIds: [9] };
      const err = new PanoptaError('404', { phase: 'read' });
      err.status = 404;
      throw err;
    }
  };
  const sets = await fetchAppliedTemplateSets(fakeClient, ['/server_template/501', '/server_template/502', '/server_template/777']);
  assert.deepEqual(calls, ['501', '502', '777']);
  assert.deepEqual([...sets.get('/server_template/501')], [1, 2, 3]);
  assert.deepEqual([...sets.get('/server_template/502')], [9]);
  assert.deepEqual([...sets.get('/server_template/777')], []); // 404 -> empty
});

test('fetchAppliedTemplateSets: malformed templateUrl yields empty set without API call', async () => {
  let called = false;
  const fakeClient = { async getServerTemplate() { called = true; return null; } };
  const sets = await fetchAppliedTemplateSets(fakeClient, ['not-a-server-template-url']);
  assert.equal(called, false);
  assert.deepEqual([...sets.get('not-a-server-template-url')], []);
});

// =====================================================================
// matchOneCriterion / matchesByCriteria
// =====================================================================

test('matchOneCriterion: dispatches on fieldType', () => {
  const server = { name: 'edge-fgt-01', tags: ['production'] };
  assert.equal(matchOneCriterion(server, { fieldType: 'name', value: 'edge-fgt-01' }).matched, true);
  assert.equal(matchOneCriterion(server, { fieldType: 'tag', value: 'production' }).matched, true);
  assert.equal(matchOneCriterion(server, { fieldType: 'unknown', value: 'x' }).matched, false);
});

test('matchesByCriteria: AND across two field types', () => {
  const server = {
    name: 'edge-fgt-01',
    tags: ['production'],
    attributes: modelAttrs('FGT60F')
  };
  const r = matchesByCriteria(server, [
    { fieldType: 'tag', value: 'production' },
    { fieldType: 'attribute', attributeName: 'Model', value: 'FGT60F' }
  ], 'all');
  assert.equal(r.matched, true);
  assert.equal(r.criteriaInfo.length, 2);
});

test('matchesByCriteria: AND short-circuits when one criterion misses', () => {
  const server = { tags: ['production'], attributes: modelAttrs('FGT60F') };
  const r = matchesByCriteria(server, [
    { fieldType: 'tag', value: 'production' },
    { fieldType: 'name', value: 'edge-fgt-01' } // no name on this server
  ], 'all');
  assert.equal(r.matched, false);
});

test('matchesByCriteria: OR across two criteria, only one needs to hit', () => {
  const server = { tags: ['staging'], attributes: modelAttrs('FGT60F') };
  const r = matchesByCriteria(server, [
    { fieldType: 'tag', value: 'production' },
    { fieldType: 'attribute', attributeName: 'Model', value: 'FGT60F' }
  ], 'any');
  assert.equal(r.matched, true);
  assert.equal(r.criteriaInfo.length, 1); // only the matched one is recorded in OR
});

test('matchesByCriteria: empty/missing criteria returns not matched', () => {
  assert.equal(matchesByCriteria({ tags: [] }, []).matched, false);
  assert.equal(matchesByCriteria({ tags: [] }, undefined).matched, false);
});

// =====================================================================
// shapeMatch
// =====================================================================

test('shapeMatch: extracts id, preserves full record fields, includes source', () => {
  const raw = {
    url: 'https://api2.panopta.com/v2/server/42024060',
    name: 'edge-fgt-01',
    fqdn: 'edge.local',
    additional_fqdns: ['10.0.0.1'],
    device_type: 'network_device',
    device_sub_type: 'fortigate',
    status: 'active',
    tags: ['production'],
    attributes: modelAttrs('FGT60F')
  };
  const out = shapeMatch(raw, [{ fieldType: 'attribute', value: 'FGT60F' }], { kind: 'name', name: 'edge-fgt-01' });
  assert.equal(out.id, 42024060);
  assert.equal(out.name, 'edge-fgt-01');
  assert.equal(out.fqdn, 'edge.local');
  assert.deepEqual(out.additionalFqdns, ['10.0.0.1']);
  assert.equal(out.deviceType, 'network_device');
  assert.equal(out.deviceSubType, 'fortigate');
  assert.equal(out.status, 'active');
  assert.deepEqual(out.tags, ['production']);
  assert.equal(out.attributes.length, 2);
  assert.equal(out.matchedCriteria.length, 1);
  assert.equal(out.source.kind, 'name');
});

// =====================================================================
// fetchActiveOutageServerIds
// =====================================================================

test('fetchActiveOutageServerIds: extracts ids from /server/N URLs and from server_id fields', async () => {
  const client = {
    async listOutages({ active }) {
      void active;
      return {
        outage_list: [
          { server: 'https://api/v2/server/42' },
          { server: 'https://api/v2/server/99/' },
          { server_id: 7 },
          { server: 'no-id-here' } // ignored
        ],
        meta: { total_count: 4 }
      };
    }
  };
  const ids = await fetchActiveOutageServerIds(client);
  assert.ok(ids.has(42));
  assert.ok(ids.has(99));
  assert.ok(ids.has(7));
  assert.equal(ids.size, 3);
});

// =====================================================================
// resolveIdentifiers
// =====================================================================

test('resolveIdentifiers: name -> getServer, URL/ID -> getServer, classifications correct', async () => {
  const calls = { lookup: [], get: [] };
  const client = {
    async lookupServersByName(name) {
      calls.lookup.push(name);
      return name === 'edge-fgt-01' ? [{ id: 42024060, name }] : [];
    },
    async getServer(id) {
      calls.get.push(id);
      if (id === 999999) throw new PanoptaError('nope', { phase: 'read', status: 404 });
      return { id, name: `srv-${id}`, fqdn: `srv-${id}.local`, tags: [], attributes: [] };
    }
  };
  const out = await resolveIdentifiers(client, [
    'edge-fgt-01',
    'https://fortimonitor.forticloud.com/report/Instance/42024060/details',
    '42024061',
    '999999'
  ]);
  assert.equal(out.length, 4);
  assert.equal(out[0].source.kind, 'name');
  assert.equal(out[0].status, 'found');
  assert.equal(out[1].source.kind, 'url');
  assert.equal(out[1].source.serverId, 42024060);
  assert.equal(out[1].status, 'found');
  assert.equal(out[2].source.kind, 'id');
  assert.equal(out[2].status, 'found');
  assert.equal(out[3].source.kind, 'id');
  assert.equal(out[3].status, 'not_found');
});

test('resolveIdentifiers: ambiguous and not_found name lookups', async () => {
  const client = {
    async lookupServersByName(name) {
      if (name === 'amb') return [{ id: 1, name }, { id: 2, name }];
      return [];
    },
    async getServer() { throw new Error('should not be called'); }
  };
  const out = await resolveIdentifiers(client, ['amb', 'missing']);
  assert.equal(out[0].status, 'ambiguous');
  assert.equal(out[1].status, 'not_found');
});

// =====================================================================
// findServers
// =====================================================================

function makePagedClient(pages) {
  let i = 0;
  return {
    async listServers() { return pages[i++] ?? { server_list: [], meta: {} }; }
  };
}

test('findServers: requires at least one of identifiers or criteria', async () => {
  await assert.rejects(() => findServers({ client: makePagedClient([]) }), /at least one of identifiers or criteria/);
});

test('findServers: criteria-only path - paginates and AND-filters', async () => {
  const pages = [{
    server_list: [
      { url: '.../server/1', name: 'edge-fgt-01', tags: ['production'], attributes: modelAttrs('FGT60F') },
      { url: '.../server/2', name: 'edge-fgt-02', tags: ['staging'], attributes: modelAttrs('FGT60F') }
    ],
    meta: { total_count: 2 }
  }];
  const result = await findServers({
    client: makePagedClient(pages),
    criteria: [
      { fieldType: 'tag', value: 'production' },
      { fieldType: 'attribute', attributeName: 'Model', value: 'FGT60F' }
    ],
    mode: 'all'
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, 1);
});

test('findServers: criteria-only path with mode=any returns servers matching at least one criterion', async () => {
  const pages = [{
    server_list: [
      { url: '.../server/1', tags: ['production'], attributes: modelAttrs('Linux') },
      { url: '.../server/2', tags: ['staging'], attributes: modelAttrs('FGT60F') },
      { url: '.../server/3', tags: ['staging'], attributes: modelAttrs('Linux') }
    ],
    meta: { total_count: 3 }
  }];
  const result = await findServers({
    client: makePagedClient(pages),
    criteria: [
      { fieldType: 'tag', value: 'production' },
      { fieldType: 'attribute', attributeName: 'Model', value: 'FGT60F' }
    ],
    mode: 'any'
  });
  // 1 hits via tag, 2 hits via attribute, 3 misses both
  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.matches.map((m) => m.id).sort(), [1, 2]);
});

test('findServers: identifiers-only path resolves and shapes (no /server pagination)', async () => {
  let listServersCalled = false;
  const client = {
    async listServers() { listServersCalled = true; return { server_list: [], meta: {} }; },
    async lookupServersByName() { return []; },
    async getServer(id) { return { id, name: `srv-${id}`, tags: [], attributes: [] }; }
  };
  const result = await findServers({
    client,
    identifiers: ['42', '99']
  });
  assert.equal(listServersCalled, false, 'identifiers-only path should not page /server');
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].id, 42);
  assert.equal(result.matches[1].id, 99);
});

test('findServers: identifiers + criteria intersection', async () => {
  const records = {
    1: { id: 1, name: 'edge-fgt-01', tags: ['production'], attributes: modelAttrs('FGT60F') },
    2: { id: 2, name: 'edge-fgt-02', tags: ['staging'],    attributes: modelAttrs('FGT60F') }
  };
  const client = {
    async listServers() { throw new Error('should not page when identifiers given'); },
    async lookupServersByName() { return []; },
    async getServer(id) { return records[id]; }
  };
  const result = await findServers({
    client,
    identifiers: ['1', '2'],
    criteria: [{ fieldType: 'tag', value: 'production' }],
    mode: 'all'
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, 1);
});

test('findServers: has_active_outage criterion fetches active outages once', async () => {
  let listOutagesCalls = 0;
  const records = {
    1: { id: 1, name: 'down-server' },
    2: { id: 2, name: 'up-server' }
  };
  const client = {
    async listServers() { return { server_list: [records[1], { url: '.../server/2', ...records[2] }], meta: { total_count: 2 } }; },
    async listOutages({ active }) {
      assert.equal(active, true);
      listOutagesCalls++;
      return { outage_list: [{ server_id: 1 }], meta: { total_count: 1 } };
    }
  };
  const result = await findServers({
    client,
    criteria: [{ fieldType: 'has_active_outage', value: true }],
    mode: 'all'
  });
  assert.equal(listOutagesCalls, 1, 'fetched once at search start, not per server');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].name, 'down-server');
});

test('findServers: applied_template criterion intersects with filter set (FMN-121)', async () => {
  // Three servers, one template attached to two of them. Tag filter
  // narrows to two; applied_template narrows further to the one in both.
  const pages = [{
    server_list: [
      { url: '.../server/1001', id: 1001, name: 'edge-win-01', tags: ['production'] },
      { url: '.../server/1002', id: 1002, name: 'edge-win-02', tags: ['production'] },
      { url: '.../server/1003', id: 1003, name: 'staging-lnx-01', tags: ['staging'] }
    ],
    meta: { total_count: 3 }
  }];
  const client = {
    ...makePagedClient(pages),
    async getServerTemplate(id) {
      assert.equal(id, '501');
      return { id: 501, name: 'Critical Infra', appliedServerUrls: [], appliedServerIds: [1001, 1003] };
    }
  };
  const result = await findServers({
    client,
    criteria: [
      { fieldType: 'tag', value: 'production' },
      { fieldType: 'applied_template', templateUrl: '/server_template/501', templateName: 'Critical Infra', match: 'attached' }
    ],
    mode: 'all'
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, 1001);
  // criteriaInfo carries the matched-template payload for the UI column.
  const tplInfo = result.matches[0].matchedCriteria.find((c) => c.fieldType === 'applied_template');
  assert.equal(tplInfo.templateName, 'Critical Infra');
  assert.equal(tplInfo.attached, true);
});

test('findServers: applied_template not_attached selects servers WITHOUT the template (FMN-121)', async () => {
  const pages = [{
    server_list: [
      { url: '.../server/1001', id: 1001 },
      { url: '.../server/1002', id: 1002 }
    ],
    meta: { total_count: 2 }
  }];
  const client = {
    ...makePagedClient(pages),
    async getServerTemplate() {
      return { id: 501, name: 'Critical Infra', appliedServerUrls: [], appliedServerIds: [1001] };
    }
  };
  const result = await findServers({
    client,
    criteria: [{ fieldType: 'applied_template', templateUrl: '/server_template/501', match: 'not_attached' }],
    mode: 'all'
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, 1002);
});

test('findServers: applied_template fetches each unique template exactly once (FMN-121)', async () => {
  // Same template referenced by two criteria (e.g. attached AND not_attached
  // would be a contradiction, but the prefetcher dedupes regardless).
  let calls = 0;
  const pages = [{ server_list: [{ url: '.../server/1', id: 1 }], meta: { total_count: 1 } }];
  const client = {
    ...makePagedClient(pages),
    async getServerTemplate() { calls++; return { id: 501, name: 'A', appliedServerIds: [1] }; }
  };
  await findServers({
    client,
    criteria: [
      { fieldType: 'applied_template', templateUrl: '/server_template/501', match: 'attached' },
      { fieldType: 'applied_template', templateUrl: '/server_template/501', match: 'attached' }
    ],
    mode: 'all'
  });
  assert.equal(calls, 1);
});

test('findServers: applied_template runs only when needed (regression)', async () => {
  let calls = 0;
  const pages = [{ server_list: [{ url: '.../server/1', id: 1, tags: ['x'] }], meta: { total_count: 1 } }];
  const client = {
    ...makePagedClient(pages),
    async getServerTemplate() { calls++; return { id: 0, name: '', appliedServerIds: [] }; }
  };
  await findServers({
    client,
    criteria: [{ fieldType: 'tag', value: 'x' }],
    mode: 'all'
  });
  assert.equal(calls, 0, 'no applied_template criterion -> no template prefetch');
});

test('findServers: tool-level caseInsensitive stamps onto string criteria when not explicitly set', async () => {
  const pages = [{ server_list: [{ url: '.../server/1', name: 'EDGE-FGT-01' }], meta: { total_count: 1 } }];
  const result = await findServers({
    client: makePagedClient(pages),
    criteria: [{ fieldType: 'name', value: 'edge-fgt-01' }],
    caseInsensitive: true
  });
  assert.equal(result.matches.length, 1);
});

// =====================================================================
// Handler factory
// =====================================================================

test('search:list-templates: delegates to client.listTemplates (FMN-121)', async () => {
  let called = 0;
  const fakeTemplates = [
    { id: 501, name: 'Critical Infra', resourceUrl: '/server_template/501', appliedServerUrls: ['/server/1'] }
  ];
  const client = {
    async listTemplates() { called++; return fakeTemplates; }
  };
  const handlers = createServerSearchHandlers({ getClient: async () => client });
  const out = await handlers['search:list-templates']({});
  assert.equal(called, 1);
  assert.deepEqual(out, fakeTemplates);
});

test('search:list-attribute-types: still merges catalog + sample (regression)', async () => {
  const client = {
    async listAttributeTypes() { return [{ name: 'Zebra', textkey: 'z' }]; },
    async listServers() { return { server_list: [{ attributes: [{ name: 'Model', textkey: 'dem.model', value: 'X' }] }] }; }
  };
  const handlers = createServerSearchHandlers({ getClient: async () => client });
  const types = await handlers['search:list-attribute-types']();
  assert.deepEqual(types.map((t) => t.name).sort(), ['Model', 'Zebra']);
});

test('search:list-device-types: samples /server records for distinct device_type / sub_type', async () => {
  const client = {
    async listServers() {
      return {
        server_list: [
          { device_type: 'network_device', device_sub_type: 'fortigate' },
          { device_type: 'network_device', device_sub_type: 'fortiap' },
          { device_type: 'server' }
        ]
      };
    }
  };
  const handlers = createServerSearchHandlers({ getClient: async () => client });
  const out = await handlers['search:list-device-types']();
  assert.deepEqual(out.sort(), ['fortiap', 'fortigate', 'network_device', 'server']);
});

test('search:servers: end-to-end with criteria-only and emits search:page', async () => {
  const pages = [{ server_list: [{ url: '.../server/42', name: 'edge-fgt-01', attributes: modelAttrs('FGT60F') }], meta: { total_count: 1 } }];
  const events = [];
  const handlers = createServerSearchHandlers({
    events: { emit: (n, p) => events.push({ n, p }) },
    getClient: async () => makePagedClient(pages)
  });
  const out = await handlers['search:servers']({
    criteria: [{ fieldType: 'attribute', attributeName: 'Model', value: 'FGT60F' }]
  });
  assert.equal(out.matches.length, 1);
  assert.equal(out.mode, 'all');
  assert.ok(events.some((e) => e.n === 'search:page' && e.p.matches === 1));
});

test('search:servers: rejects when both identifiers and criteria are empty', async () => {
  const handlers = createServerSearchHandlers({ getClient: async () => makePagedClient([]) });
  await assert.rejects(() => handlers['search:servers']({}), /at least one of identifiers or criteria/);
});

test('search:servers: rejects unknown fieldType', async () => {
  const handlers = createServerSearchHandlers({
    getClient: async () => makePagedClient([{ server_list: [], meta: {} }])
  });
  await assert.rejects(
    () => handlers['search:servers']({ criteria: [{ fieldType: 'mystery', value: 'x' }] }),
    /unknown fieldType/
  );
});

test('search:servers: rejects a concurrent run', async () => {
  let resolveFirst;
  const slowClient = {
    async listServers() { await new Promise((r) => { resolveFirst = r; }); return { server_list: [], meta: { total_count: 0 } }; }
  };
  const handlers = createServerSearchHandlers({ getClient: async () => slowClient });
  const first = handlers['search:servers']({
    criteria: [{ fieldType: 'name', value: 'a' }]
  });
  await assert.rejects(
    handlers['search:servers']({ criteria: [{ fieldType: 'name', value: 'b' }] }),
    /already in progress/
  );
  resolveFirst();
  await first;
});

test('search:abort: returns aborted=false when no run is active', async () => {
  const handlers = createServerSearchHandlers({ getClient: async () => ({}) });
  const r = await handlers['search:abort']();
  assert.equal(r.aborted, false);
});

// =====================================================================
// isRetryable (regression sanity)
// =====================================================================

test('isRetryable: false for null, AbortError, auth errors; true for 5xx', () => {
  assert.equal(isRetryable(null), false);
  const ab = new Error('aborted'); ab.name = 'AbortError';
  assert.equal(isRetryable(ab), false);
  assert.equal(isRetryable(new PanoptaError('x', { phase: 'auth', status: 401 })), false);
  assert.equal(isRetryable(new PanoptaError('x', { phase: 'read', status: 502 })), true);
  assert.equal(isRetryable(new PanoptaError('x', { phase: 'read', status: 404 })), false);
});
