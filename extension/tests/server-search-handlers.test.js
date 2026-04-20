import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesAttribute,
  shapeMatch,
  searchServersByAttribute,
  createServerSearchHandlers,
  isRetryable
} from '../src/background/server-search-handlers.js';
import { PanoptaError } from '../src/lib/panopta-client.js';

// ---- matchesAttribute ----------------------------------------------

const modelAttrs = (value) => [
  { name: 'Operating System', textkey: 'server.os', value: 'Linux' },
  { name: 'Model', textkey: 'dem.model', value }
];

test('matchesAttribute: exact match on value (case-insensitive by default)', () => {
  const server = { attributes: modelAttrs('FGT60F') };
  const r = matchesAttribute(server, { attributeName: 'Model', value: 'fgt60f' });
  assert.equal(r.matched, true);
  assert.equal(r.attributeName, 'Model');
  assert.equal(r.textkey, 'dem.model');
  assert.equal(r.value, 'FGT60F');
});

test('matchesAttribute: attribute lookup works by textkey too', () => {
  const server = { attributes: modelAttrs('FGT60F') };
  const r = matchesAttribute(server, { attributeName: 'dem.model', value: 'FGT60F' });
  assert.equal(r.matched, true);
});

test('matchesAttribute: exact match rejects substrings', () => {
  const server = { attributes: modelAttrs('FGT60F-Bypass') };
  assert.equal(matchesAttribute(server, { attributeName: 'Model', value: 'FGT60F' }).matched, false);
});

test('matchesAttribute: contains mode accepts substrings', () => {
  const server = { attributes: modelAttrs('FGT60F-Bypass') };
  const r = matchesAttribute(server, { attributeName: 'Model', value: 'FGT60F', exactMatch: false });
  assert.equal(r.matched, true);
});

test('matchesAttribute: case-sensitive mode respects case', () => {
  const server = { attributes: modelAttrs('FGT60F') };
  assert.equal(
    matchesAttribute(server, { attributeName: 'Model', value: 'fgt60f', caseInsensitive: false }).matched,
    false
  );
  assert.equal(
    matchesAttribute(server, { attributeName: 'Model', value: 'FGT60F', caseInsensitive: false }).matched,
    true
  );
});

test('matchesAttribute: does NOT hit on other fields (name/fqdn/tags)', () => {
  const server = {
    name: 'FGT60F-router-01',
    fqdn: 'fgt60f.example.com',
    tags: ['FGT60F'],
    attributes: modelAttrs('Linux') // the Model attribute is Linux here
  };
  assert.equal(matchesAttribute(server, { attributeName: 'Model', value: 'FGT60F' }).matched, false);
});

test('matchesAttribute: no attributes array → not matched', () => {
  assert.equal(matchesAttribute({ name: 'x' }, { attributeName: 'Model', value: 'FGT60F' }).matched, false);
});

test('matchesAttribute: missing args → not matched', () => {
  const server = { attributes: modelAttrs('FGT60F') };
  assert.equal(matchesAttribute(server, { value: 'FGT60F' }).matched, false);
  assert.equal(matchesAttribute(server, { attributeName: 'Model' }).matched, false);
  assert.equal(matchesAttribute(null, { attributeName: 'Model', value: 'FGT60F' }).matched, false);
});

test('matchesAttribute: matches first attribute with the given name when multiple exist', () => {
  const server = {
    attributes: [
      { name: 'Model', textkey: 'dem.model', value: 'FGT60F' },
      { name: 'Model', textkey: 'other.model', value: 'FGT61E' }
    ]
  };
  const r = matchesAttribute(server, { attributeName: 'Model', value: 'FGT61E' });
  assert.equal(r.matched, true);
  assert.equal(r.value, 'FGT61E');
});

// ---- shapeMatch ----------------------------------------------------

test('shapeMatch: extracts id from url and preserves the matched attribute info', () => {
  const raw = {
    url: 'https://api2.panopta.com/v2/server/42024060',
    name: 'fgt-a',
    fqdn: 'fgt-a.local',
    additional_fqdns: ['10.0.0.1'],
    device_type: 'network_device',
    device_sub_type: null
  };
  const out = shapeMatch(raw, { attributeName: 'Model', textkey: 'dem.model', value: 'FGT60F' });
  assert.equal(out.id, 42024060);
  assert.equal(out.name, 'fgt-a');
  assert.equal(out.fqdn, 'fgt-a.local');
  assert.deepEqual(out.additionalFqdns, ['10.0.0.1']);
  assert.equal(out.deviceType, 'network_device');
  assert.equal(out.matchedAttributeName, 'Model');
  assert.equal(out.matchedAttributeTextkey, 'dem.model');
  assert.equal(out.matchedValue, 'FGT60F');
});

test('shapeMatch: id is null when neither id nor parseable url present', () => {
  assert.equal(shapeMatch({ name: 'x' }, {}).id, null);
});

// ---- searchServersByAttribute --------------------------------------

function makePagedClient(pages) {
  let callIndex = 0;
  return {
    async listServers({ limit, offset }) {
      const page = pages[callIndex++] ?? { server_list: [], meta: {} };
      void limit; void offset;
      return page;
    }
  };
}

test('searchServersByAttribute: paginates and filters by Model attribute value', async () => {
  const pages = [
    {
      server_list: [
        { url: '.../server/1', name: 'linux-01', attributes: modelAttrs('Linux') },
        { url: '.../server/2', name: 'fgt-a',     attributes: modelAttrs('FGT60F') }
      ],
      meta: { total_count: 3 }
    },
    {
      server_list: [
        { url: '.../server/3', name: 'fgt-b', attributes: modelAttrs('FGT61E') }
      ],
      meta: { total_count: 3 }
    }
  ];
  const client = makePagedClient(pages);
  const result = await searchServersByAttribute({
    client, attributeName: 'Model', value: 'FGT60F', pageSize: 2
  });
  assert.equal(result.totalScanned, 3);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, 2);
  assert.equal(result.matches[0].matchedValue, 'FGT60F');
});

test('searchServersByAttribute: emits onPage per page with match counts', async () => {
  const pages = [
    { server_list: [{ url: '.../server/1', attributes: modelAttrs('FGT60F') }], meta: { total_count: 2 } },
    { server_list: [{ url: '.../server/2', attributes: modelAttrs('FGT60F') }], meta: { total_count: 2 } }
  ];
  const client = makePagedClient(pages);
  const events = [];
  await searchServersByAttribute({
    client, attributeName: 'Model', value: 'FGT60F', pageSize: 1,
    onPage: (e) => events.push(e)
  });
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { fetched: 1, total: 2, matches: 1 });
  assert.deepEqual(events[1], { fetched: 2, total: 2, matches: 2 });
});

test('searchServersByAttribute: stops on empty page without total_count', async () => {
  const pages = [
    { server_list: [{ url: '.../server/1', attributes: modelAttrs('FGT60F') }], meta: {} },
    { server_list: [], meta: {} }
  ];
  const client = makePagedClient(pages);
  const result = await searchServersByAttribute({
    client, attributeName: 'Model', value: 'FGT60F'
  });
  assert.equal(result.totalScanned, 1);
  assert.equal(result.matches.length, 1);
});

test('searchServersByAttribute: honors AbortSignal', async () => {
  const ac = new AbortController();
  ac.abort();
  const client = makePagedClient([{ server_list: [], meta: {} }]);
  await assert.rejects(
    () => searchServersByAttribute({ client, attributeName: 'Model', value: 'FGT60F', signal: ac.signal }),
    (err) => err.name === 'AbortError'
  );
});

test('searchServersByAttribute: requires client, attributeName, and value', async () => {
  await assert.rejects(() => searchServersByAttribute({ attributeName: 'Model', value: 'x' }), /client is required/);
  await assert.rejects(() => searchServersByAttribute({ client: {}, value: 'x' }), /attributeName is required/);
  await assert.rejects(() => searchServersByAttribute({ client: {}, attributeName: 'Model' }), /value is required/);
  await assert.rejects(() => searchServersByAttribute({ client: {}, attributeName: 'Model', value: '' }), /value is required/);
});

test('searchServersByAttribute: exact-match mode is the default (avoids FGT60F matching FGT60F-Bypass)', async () => {
  const pages = [{
    server_list: [
      { url: '.../server/1', attributes: modelAttrs('FGT60F') },
      { url: '.../server/2', attributes: modelAttrs('FGT60F-Bypass') }
    ],
    meta: { total_count: 2 }
  }];
  const client = makePagedClient(pages);
  const result = await searchServersByAttribute({ client, attributeName: 'Model', value: 'FGT60F' });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, 1);
});

// ---- handlers ------------------------------------------------------

test('search:list-attribute-types: delegates to client.listAttributeTypes and sorts by name', async () => {
  const client = {
    async listAttributeTypes() {
      return [
        { id: 2, name: 'Zebra', textkey: 'z', resourceUrl: 'u2' },
        { id: 1, name: 'Apple', textkey: 'a', resourceUrl: 'u1' },
        { id: 3, name: 'Model', textkey: 'dem.model', resourceUrl: 'u3' }
      ];
    }
  };
  const handlers = createServerSearchHandlers({ getClient: async () => client });
  const types = await handlers['search:list-attribute-types']();
  assert.deepEqual(types.map((t) => t.name), ['Apple', 'Model', 'Zebra']);
});

test('search:servers: end-to-end attribute filter via factory client', async () => {
  const pages = [{
    server_list: [
      { url: '.../server/42024060', name: 'edge-fgt-01', fqdn: 'fgt01.local', attributes: modelAttrs('FGT60F') },
      { url: '.../server/42024061', name: 'edge-fgt-02', fqdn: 'fgt02.local', attributes: modelAttrs('FGT61E') }
    ],
    meta: { total_count: 2 }
  }];
  const client = makePagedClient(pages);
  const events = [];
  const handlers = createServerSearchHandlers({
    events: { emit: (name, payload) => events.push({ name, payload }) },
    getClient: async () => client
  });
  const result = await handlers['search:servers']({ attributeName: 'Model', value: 'FGT60F' });
  assert.equal(result.attributeName, 'Model');
  assert.equal(result.value, 'FGT60F');
  assert.equal(result.exactMatch, true);
  assert.equal(result.caseInsensitive, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, 42024060);
  assert.equal(result.matches[0].fqdn, 'fgt01.local');
  assert.ok(events.some((e) => e.name === 'search:page' && e.payload.matches === 1));
});

test('search:servers: rejects empty attributeName or value', async () => {
  const handlers = createServerSearchHandlers({ getClient: async () => ({ listServers: async () => ({}) }) });
  await assert.rejects(() => handlers['search:servers']({ value: 'x' }), /attributeName is required/);
  await assert.rejects(() => handlers['search:servers']({ attributeName: 'Model' }), /value is required/);
  await assert.rejects(() => handlers['search:servers']({ attributeName: '  ', value: 'x' }), /attributeName is required/);
});

test('search:servers: rejects a concurrent run', async () => {
  let resolveFirst;
  const client = {
    async listServers() {
      await new Promise((r) => { resolveFirst = r; });
      return { server_list: [], meta: { total_count: 0 } };
    }
  };
  const handlers = createServerSearchHandlers({ getClient: async () => client });
  const first = handlers['search:servers']({ attributeName: 'Model', value: 'FGT60F' });
  await assert.rejects(
    handlers['search:servers']({ attributeName: 'Model', value: 'FGT61E' }),
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

// ---- isRetryable (unchanged semantics, regression-sanity) ----------

test('isRetryable: false for null/undefined', () => {
  assert.equal(isRetryable(null), false);
  assert.equal(isRetryable(undefined), false);
});

test('isRetryable: false for PanoptaError phase=auth', () => {
  assert.equal(isRetryable(new PanoptaError('bad key', { phase: 'auth', status: 401 })), false);
});

test('isRetryable: true for 5xx', () => {
  assert.equal(isRetryable(new PanoptaError('x', { phase: 'read', status: 502 })), true);
});

test('isRetryable: false for 404', () => {
  assert.equal(isRetryable(new PanoptaError('x', { phase: 'read', status: 404 })), false);
});
