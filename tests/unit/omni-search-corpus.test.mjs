// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-152 Phase 2 unit tests: corpus build + id->name resolution.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractIdFromUrl,
  buildIdNameMap,
  buildServerCorpus,
  searchCache,
} from '../../extension/src/background/omni-search-handlers.js';

// ---- extractIdFromUrl ----

test('extractIdFromUrl: standard v2 URL returns numeric id', () => {
  assert.equal(extractIdFromUrl('https://api2.panopta.com/v2/server/42024060'), 42024060);
});

test('extractIdFromUrl: URL with trailing slash returns id', () => {
  assert.equal(extractIdFromUrl('https://api2.panopta.com/v2/server_group/617573/'), 617573);
});

test('extractIdFromUrl: nested resource path returns the trailing id', () => {
  assert.equal(
    extractIdFromUrl('https://api2.panopta.com/v2/server/42024060/agent_resource/123'),
    123
  );
});

test('extractIdFromUrl: malformed URL returns null', () => {
  assert.equal(extractIdFromUrl('not-a-url'), null);
});

test('extractIdFromUrl: empty / null / non-string returns null', () => {
  assert.equal(extractIdFromUrl(''), null);
  assert.equal(extractIdFromUrl(null), null);
  assert.equal(extractIdFromUrl(undefined), null);
  assert.equal(extractIdFromUrl(42), null);
});

// ---- buildIdNameMap ----

test('buildIdNameMap: builds id->name from records with url + name', () => {
  const records = [
    { url: 'https://api2.panopta.com/v2/server_group/100', name: 'Production' },
    { url: 'https://api2.panopta.com/v2/server_group/200', name: 'Staging' },
  ];
  const m = buildIdNameMap(records);
  assert.equal(m.get(100), 'Production');
  assert.equal(m.get(200), 'Staging');
  assert.equal(m.size, 2);
});

test('buildIdNameMap: uses explicit .id when url is absent', () => {
  const records = [{ id: 7, name: 'Direct' }];
  const m = buildIdNameMap(records);
  assert.equal(m.get(7), 'Direct');
});

test('buildIdNameMap: skips records missing both id and url, or missing name', () => {
  const records = [
    { name: 'no-id' },
    { url: 'https://api2.panopta.com/v2/server_group/9' }, // no name
    null,
    'string-not-object',
    { url: 'https://api2.panopta.com/v2/server_group/5', name: 'kept' },
  ];
  const m = buildIdNameMap(records);
  assert.equal(m.size, 1);
  assert.equal(m.get(5), 'kept');
});

test('buildIdNameMap: handles empty / non-array input', () => {
  assert.equal(buildIdNameMap([]).size, 0);
  assert.equal(buildIdNameMap(null).size, 0);
  assert.equal(buildIdNameMap(undefined).size, 0);
});

// ---- buildServerCorpus ----

const GROUPS = new Map([[617573, 'Production']]);
const TEMPLATES = new Map([[42, 'Linux Base'], [43, 'Network Device']]);

test('buildServerCorpus: pulls every documented field into lowercased corpus', () => {
  const srv = {
    name: 'edge-01',
    fqdn: 'edge-01.example',
    additional_fqdns: ['10.0.0.1', '10.0.0.2'],
    description: 'East coast edge router',
    tags: ['Linux', 'Production'],
    attributes: [
      { name: 'Operating System', textkey: 'server.os', value: 'Linux' },
      { name: 'Model', textkey: 'dem.model', value: 'FortiGate-100F' },
    ],
    device_type: 'Server',
    device_sub_type: 'EdgeRouter',
    agent_version: '2025.4.5',
    status: 'active',
    server_key: 'KEY-X',
    partner_server_id: 'PSID-7',
    server_group: 'https://api2.panopta.com/v2/server_group/617573',
    server_template: ['https://api2.panopta.com/v2/server_template/42'],
  };
  const c = buildServerCorpus(srv, GROUPS, TEMPLATES);
  // Lowercased
  assert.equal(c, c.toLowerCase(), 'corpus must be entirely lowercased');
  // Every required substring present
  for (const needle of [
    'edge-01', 'edge-01.example', '10.0.0.1', '10.0.0.2',
    'east coast edge router', 'linux', 'production',
    'operating system', 'server.os', 'fortigate-100f',
    'server', 'edgerouter', '2025.4.5', 'active',
    'key-x', 'psid-7', 'linux base',
  ]) {
    assert.ok(c.includes(needle), `corpus must contain "${needle}"; got: ${c.slice(0, 200)}`);
  }
});

test('buildServerCorpus: missing optional fields do not throw and produce a useful corpus', () => {
  const srv = { name: 'minimal' };
  const c = buildServerCorpus(srv, new Map(), new Map());
  assert.ok(c.includes('minimal'));
  // No crash on null/undefined arrays or strings.
});

test('buildServerCorpus: null/undefined fields are safely skipped', () => {
  const srv = {
    name: 'has-nulls',
    fqdn: null,
    additional_fqdns: null,
    description: undefined,
    tags: undefined,
    attributes: null,
    device_type: null,
    server_group: null,
    server_template: null,
  };
  const c = buildServerCorpus(srv, new Map(), new Map());
  assert.ok(c.includes('has-nulls'));
});

test('buildServerCorpus: resolves group + template URLs to names via the maps', () => {
  const srv = {
    name: 's',
    server_group: 'https://api2.panopta.com/v2/server_group/617573',
    server_template: [
      'https://api2.panopta.com/v2/server_template/42',
      'https://api2.panopta.com/v2/server_template/43',
    ],
  };
  const c = buildServerCorpus(srv, GROUPS, TEMPLATES);
  assert.ok(c.includes('production'), 'group name resolved');
  assert.ok(c.includes('linux base'), 'first template name resolved');
  assert.ok(c.includes('network device'), 'second template name resolved');
});

test('buildServerCorpus: unknown group/template ids are silently skipped', () => {
  const srv = {
    name: 's',
    server_group: 'https://api2.panopta.com/v2/server_group/99999',
    server_template: ['https://api2.panopta.com/v2/server_template/8888'],
  };
  const c = buildServerCorpus(srv, GROUPS, TEMPLATES);
  // 's' is there, but no group/template name leaked in.
  assert.ok(!c.includes('production'));
  assert.ok(!c.includes('linux base'));
});

test('buildServerCorpus: object-shaped server_template entries (url-bearing) resolve correctly', () => {
  const srv = {
    name: 's',
    server_template: [{ url: 'https://api2.panopta.com/v2/server_template/42', name: 'ignored-via-name' }],
  };
  const c = buildServerCorpus(srv, GROUPS, TEMPLATES);
  assert.ok(c.includes('linux base'), 'name pulled from the id->name map, not the inline name field');
});

// ---- integration: corpus + search end to end ----

test('end to end: query that matches via attribute value via corpus', () => {
  const corpus = buildServerCorpus(
    {
      name: 'svr',
      attributes: [{ name: 'Operating System', textkey: 'server.os', value: 'Red Hat Enterprise Linux' }],
    },
    new Map(),
    new Map()
  );
  const cache = {
    fetchedAt: Date.now(), tenantOrigin: 'x',
    servers: [{
      id: 1, name: 'svr', fqdn: '', additional_fqdns: [], description: '', tags: [],
      attributes: [{ name: 'Operating System', value: 'Red Hat Enterprise Linux' }],
      device_type: '', device_sub_type: '', agent_version: '', status: '',
      group_name: '', template_names: [],
    }],
    corpus: [corpus],
  };
  const r = searchCache(cache, 'red hat');
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].matched_field, 'attribute');
});
