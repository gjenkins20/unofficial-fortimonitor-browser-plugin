import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesServer,
  shapeMatch,
  searchServers,
  createServerSearchHandlers,
  isRetryable
} from '../src/background/server-search-handlers.js';
import { PanoptaError } from '../src/lib/panopta-client.js';

// ---- matchesServer -------------------------------------------------

test('matchesServer: hits on name (case-insensitive by default)', () => {
  const server = { name: 'FortiGate-Branch-A', fqdn: 'fgt-a.example.com' };
  const r = matchesServer(server, { term: 'FORTIGATE' });
  assert.equal(r.matched, true);
  assert.equal(r.field, 'name');
  assert.equal(r.value, 'FortiGate-Branch-A');
});

test('matchesServer: case-sensitive mode respects case', () => {
  const server = { name: 'FortiGate-Branch-A' };
  assert.equal(matchesServer(server, { term: 'fortigate', caseInsensitive: false }).matched, false);
  assert.equal(matchesServer(server, { term: 'FortiGate', caseInsensitive: false }).matched, true);
});

test('matchesServer: hits on fqdn when name does not match', () => {
  const server = { name: 'Bob', fqdn: 'fgvma6.example.com' };
  const r = matchesServer(server, { term: 'FGVMA6' });
  assert.equal(r.matched, true);
  assert.equal(r.field, 'fqdn');
});

test('matchesServer: hits on additional_fqdns[] entries', () => {
  const server = { name: 'x', fqdn: 'nomatch', additional_fqdns: ['10.0.0.1', 'fgvma6.local'] };
  const r = matchesServer(server, { term: 'fgvma6' });
  assert.equal(r.matched, true);
  assert.equal(r.field, 'additional_fqdns');
  assert.equal(r.value, 'fgvma6.local');
});

test('matchesServer: hits on device_sub_type', () => {
  const server = { name: 'x', device_sub_type: 'FortiGate FGVMA6' };
  const r = matchesServer(server, { term: 'fgvma6' });
  assert.equal(r.matched, true);
  assert.equal(r.field, 'device_sub_type');
});

test('matchesServer: hits on tags[]', () => {
  const server = { name: 'x', tags: ['Linux', 'FortiGate FGVMA6'] };
  const r = matchesServer(server, { term: 'fgvma6' });
  assert.equal(r.matched, true);
  assert.equal(r.field, 'tags');
  assert.equal(r.value, 'FortiGate FGVMA6');
});

test('matchesServer: hits on attributes[].value with attribute name in the field label', () => {
  const server = {
    name: 'x',
    attributes: [
      { name: 'Operating System', value: 'Linux' },
      { name: 'Model', textkey: 'dem.model', value: 'FortiGate FGVMA6' }
    ]
  };
  const r = matchesServer(server, { term: 'fgvma6' });
  assert.equal(r.matched, true);
  assert.equal(r.field, 'attributes[Model]');
  assert.equal(r.value, 'FortiGate FGVMA6');
});

test('matchesServer: returns matched=false when no field contains the term', () => {
  const server = {
    name: 'web-01',
    fqdn: 'web-01.example.com',
    device_type: 'server',
    tags: ['Linux'],
    attributes: [{ name: 'Model', value: 'Linux' }]
  };
  assert.equal(matchesServer(server, { term: 'fgvma6' }).matched, false);
});

test('matchesServer: empty term or missing server → not matched', () => {
  assert.equal(matchesServer(null, { term: 'x' }).matched, false);
  assert.equal(matchesServer({ name: 'x' }, { term: '' }).matched, false);
});

test('matchesServer: priority — name wins over fqdn when both match', () => {
  const server = { name: 'fgvma6', fqdn: 'fgvma6.example.com' };
  assert.equal(matchesServer(server, { term: 'fgvma6' }).field, 'name');
});

// ---- shapeMatch ----------------------------------------------------

test('shapeMatch: extracts id from url when top-level id is missing', () => {
  const raw = {
    url: 'https://api2.panopta.com/v2/server/42024060',
    name: 'fgt-a',
    fqdn: 'fgt-a.local',
    additional_fqdns: ['10.0.0.1'],
    device_type: 'network_device',
    device_sub_type: 'FortiGate FGVMA6'
  };
  const out = shapeMatch(raw, { field: 'device_sub_type', value: 'FortiGate FGVMA6' });
  assert.equal(out.id, 42024060);
  assert.equal(out.name, 'fgt-a');
  assert.equal(out.fqdn, 'fgt-a.local');
  assert.deepEqual(out.additionalFqdns, ['10.0.0.1']);
  assert.equal(out.deviceType, 'network_device');
  assert.equal(out.deviceSubType, 'FortiGate FGVMA6');
  assert.equal(out.matchedField, 'device_sub_type');
  assert.equal(out.matchedValue, 'FortiGate FGVMA6');
});

test('shapeMatch: prefers top-level id when present', () => {
  const raw = { id: 9, url: 'https://api2.panopta.com/v2/server/42024060', name: 'x' };
  assert.equal(shapeMatch(raw, {}).id, 9);
});

test('shapeMatch: id is null when neither id nor parseable url present', () => {
  assert.equal(shapeMatch({ name: 'x' }, {}).id, null);
});

// ---- searchServers (paginates /server and filters) -----------------

function makePagedClient(pages) {
  // Each page is { server_list, meta:{total_count} }. The caller supplies
  // them in order; listServers returns them by offset.
  let callIndex = 0;
  return {
    async listServers({ limit, offset }) {
      const page = pages[callIndex++] ?? { server_list: [], meta: { total_count: pages.reduce((n, p) => n + p.server_list.length, 0) } };
      // Sanity: confirm offset roughly matches cumulative length so pagination
      // math is exercised. Loosely enforced — tests pass through whatever.
      void limit; void offset;
      return page;
    }
  };
}

test('searchServers: paginates until meta.total_count is exhausted', async () => {
  const pages = [
    {
      server_list: [
        { url: 'https://api2.panopta.com/v2/server/1', name: 'linux-01', fqdn: 'l1.ex' },
        { url: 'https://api2.panopta.com/v2/server/2', name: 'FortiGate FGVMA6', fqdn: 'fgt.ex' }
      ],
      meta: { total_count: 3 }
    },
    {
      server_list: [
        { url: 'https://api2.panopta.com/v2/server/3', name: 'win-01', fqdn: 'w1.ex' }
      ],
      meta: { total_count: 3 }
    }
  ];
  const client = makePagedClient(pages);
  const result = await searchServers({ client, term: 'fgvma6', pageSize: 2 });
  assert.equal(result.totalScanned, 3);
  assert.equal(result.totalAvailable, 3);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, 2);
  assert.equal(result.matches[0].matchedField, 'name');
});

test('searchServers: emits onPage with {fetched,total,matches} per page', async () => {
  const pages = [
    { server_list: [{ url: '.../server/1', name: 'FGVMA6-a' }], meta: { total_count: 2 } },
    { server_list: [{ url: '.../server/2', name: 'FGVMA6-b' }], meta: { total_count: 2 } }
  ];
  const client = makePagedClient(pages);
  const events = [];
  await searchServers({ client, term: 'fgvma6', pageSize: 1, onPage: (e) => events.push(e) });
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { fetched: 1, total: 2, matches: 1 });
  assert.deepEqual(events[1], { fetched: 2, total: 2, matches: 2 });
});

test('searchServers: stops on an empty page even without total_count', async () => {
  const pages = [
    { server_list: [{ url: '.../server/1', name: 'FGVMA6-a' }], meta: {} },
    { server_list: [], meta: {} }
  ];
  const client = makePagedClient(pages);
  const result = await searchServers({ client, term: 'fgvma6', pageSize: 1 });
  assert.equal(result.totalScanned, 1);
  assert.equal(result.matches.length, 1);
});

test('searchServers: honors AbortSignal', async () => {
  const ac = new AbortController();
  ac.abort();
  const client = makePagedClient([{ server_list: [], meta: { total_count: 0 } }]);
  await assert.rejects(
    () => searchServers({ client, term: 'x', signal: ac.signal }),
    (err) => err.name === 'AbortError'
  );
});

test('searchServers: requires client + term', async () => {
  await assert.rejects(() => searchServers({ term: 'x' }), /client is required/);
  await assert.rejects(() => searchServers({ client: {} }), /term is required/);
});

test('searchServers: empty result set returns 0 matches and 0 scanned', async () => {
  const client = makePagedClient([{ server_list: [], meta: { total_count: 0 } }]);
  const result = await searchServers({ client, term: 'fgvma6' });
  assert.equal(result.matches.length, 0);
  assert.equal(result.totalScanned, 0);
  assert.equal(result.totalAvailable, 0);
});

// ---- createServerSearchHandlers -----------------------------------

test('search:servers: end-to-end via factory client', async () => {
  const pages = [{
    server_list: [
      { url: '.../server/42024060', name: 'edge-fgt-01', device_sub_type: 'FortiGate FGVMA6', fqdn: 'fgt01.local' }
    ],
    meta: { total_count: 1 }
  }];
  const client = makePagedClient(pages);
  const events = [];
  const handlers = createServerSearchHandlers({
    events: { emit: (name, payload) => events.push({ name, payload }) },
    getClient: async () => client
  });
  const result = await handlers['search:servers']({ term: 'FGVMA6' });
  assert.equal(result.term, 'FGVMA6');
  assert.equal(result.caseInsensitive, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, 42024060);
  assert.equal(result.matches[0].matchedField, 'device_sub_type');
  assert.ok(events.some((e) => e.name === 'search:page' && e.payload.matches === 1));
});

test('search:servers: rejects empty term', async () => {
  const handlers = createServerSearchHandlers({ getClient: async () => ({ listServers: async () => ({}) }) });
  await assert.rejects(() => handlers['search:servers']({ term: '   ' }), /term is required/);
});

test('search:servers: rejects a concurrent run', async () => {
  let resolveFirst;
  const client = {
    async listServers() {
      // Pause the first run so we can fire a second before it finishes.
      await new Promise((r) => { resolveFirst = r; });
      return { server_list: [], meta: { total_count: 0 } };
    }
  };
  const handlers = createServerSearchHandlers({ getClient: async () => client });
  const first = handlers['search:servers']({ term: 'x' });
  await assert.rejects(
    handlers['search:servers']({ term: 'y' }),
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

// ---- isRetryable --------------------------------------------------

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
