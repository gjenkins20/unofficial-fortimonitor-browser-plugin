// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-152 unit tests, Layer 1: scoring tiers.
//
// Pure-function tests for scoreServer. No chrome.* stubs needed; the
// scoring logic operates on plain server-shaped objects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreServer } from '../../extension/src/background/omni-search-handlers.js';

// Minimal valid "server entry" shape (matches buildServerEntry output).
// FMN-153 added classified ips[] / dns_names[] alongside the legacy
// additional_fqdns array. Test fixtures default both to empty.
function server(overrides = {}) {
  return {
    id: 1,
    name: '',
    fqdn: '',
    additional_fqdns: [],
    ips: [],
    dns_names: [],
    description: '',
    tags: [],
    attributes: [],
    device_type: '',
    device_sub_type: '',
    agent_version: '',
    status: '',
    group_name: '',
    template_names: [],
    ...overrides,
  };
}

test('exact name match scores 1000', () => {
  const r = scoreServer(server({ name: 'server' }), 'server');
  assert.equal(r.score, 1000);
  assert.equal(r.field, 'name');
});

test('exact fqdn match scores 900', () => {
  const r = scoreServer(server({ name: 'other', fqdn: 'host.example' }), 'host.example');
  assert.equal(r.score, 900);
  assert.equal(r.field, 'fqdn');
});

test('name starts-with scores 800', () => {
  const r = scoreServer(server({ name: 'server-01' }), 'server');
  assert.equal(r.score, 800);
  assert.equal(r.field, 'name');
});

test('fqdn starts-with scores 700 when name does not match', () => {
  const r = scoreServer(server({ name: 'web', fqdn: 'host.example' }), 'host');
  assert.equal(r.score, 700);
  assert.equal(r.field, 'fqdn');
});

test('name contains scores 600 when not starts-with', () => {
  const r = scoreServer(server({ name: 'my-server-01' }), 'server');
  assert.equal(r.score, 600);
  assert.equal(r.field, 'name');
});

test('ips substring scores 500 with field=ip (FMN-153)', () => {
  // Post-FMN-153: classified IPs land in server.ips at ingest time;
  // matching against them yields the high-confidence 'ip' label.
  const r = scoreServer(server({ name: 'sql', ips: ['10.0.0.185'] }), '10.0.0.185');
  assert.equal(r.score, 500);
  assert.equal(r.field, 'ip');
});

test('dns_names substring scores 500 with field=dns (FMN-153)', () => {
  const r = scoreServer(server({ name: 'web', dns_names: ['api.example.com'] }), 'example');
  assert.equal(r.score, 500);
  assert.equal(r.field, 'dns');
});

test('legacy additional_fqdns-only substring scores 480 with field=fqdn (FMN-153 fallback)', () => {
  // additional_fqdns hits that did not classify into ips/dns_names
  // (unusual; would be a value that fails both IPv4/IPv6/hostname regex)
  // fall through to the legacy rule at a slightly lower score.
  const r = scoreServer(server({ name: 'sql', additional_fqdns: ['unclassified-token'] }), 'unclassified');
  assert.equal(r.score, 480);
  assert.equal(r.field, 'fqdn');
});

test('fqdn contains scores 400 when not exact / starts-with', () => {
  const r = scoreServer(server({ fqdn: 'web.host.example' }), 'host');
  assert.equal(r.score, 400);
  assert.equal(r.field, 'fqdn');
});

test('tag exact scores 350', () => {
  const r = scoreServer(server({ tags: ['Linux'] }), 'linux');
  assert.equal(r.score, 350);
  assert.equal(r.field, 'tag');
});

test('tag contains (not exact) scores 300', () => {
  const r = scoreServer(server({ tags: ['Linux-RHEL'] }), 'linux');
  assert.equal(r.score, 300);
  assert.equal(r.field, 'tag');
});

test('attribute value match scores 250', () => {
  const r = scoreServer(server({ attributes: [{ name: 'OS', value: 'Red Hat Enterprise Linux' }] }), 'red hat');
  assert.equal(r.score, 250);
  assert.equal(r.field, 'attribute');
});

test('attribute name match scores 250', () => {
  const r = scoreServer(server({ attributes: [{ name: 'Operating System', value: 'Linux' }] }), 'operating system');
  // "operating system" doesn't match name field. Will match attribute name.
  assert.equal(r.score, 250);
  assert.equal(r.field, 'attribute');
});

test('description contains scores 200', () => {
  const r = scoreServer(server({ description: 'edge router for east region' }), 'east region');
  assert.equal(r.score, 200);
  assert.equal(r.field, 'description');
});

test('group_name contains scores 150', () => {
  const r = scoreServer(server({ group_name: 'INCOMING SERVERS' }), 'incoming');
  assert.equal(r.score, 150);
  assert.equal(r.field, 'group');
});

test('template_names contains scores 150', () => {
  const r = scoreServer(server({ template_names: ['Linux Base'] }), 'base');
  assert.equal(r.score, 150);
  assert.equal(r.field, 'template');
});

test('device_type contains scores 100', () => {
  const r = scoreServer(server({ device_type: 'NetworkDevice' }), 'network');
  assert.equal(r.score, 100);
  assert.equal(r.field, 'device_type');
});

test('agent_version contains scores 100', () => {
  const r = scoreServer(server({ agent_version: '2025.4.5' }), '2025');
  assert.equal(r.score, 100);
  assert.equal(r.field, 'agent_version');
});

test('status contains scores 100', () => {
  const r = scoreServer(server({ status: 'active' }), 'act');
  assert.equal(r.score, 100);
  assert.equal(r.field, 'status');
});

test('no field matches scores 0', () => {
  const r = scoreServer(server({ name: 'foo' }), 'nonexistent');
  assert.equal(r.score, 0);
  assert.equal(r.field, 'other');
});

test('mixed-case name compared against lowercased query (scoreServer contract)', () => {
  // scoreServer expects the caller to have lowercased the query already;
  // it internally lowercases each server field. So a lowercased 'my-server-01'
  // exact-matches a mixed-case stored 'My-Server-01'.
  const r = scoreServer(server({ name: 'My-Server-01' }), 'my-server-01');
  assert.equal(r.score, 1000);
});

test('case-insensitive: lowercase query against mixed-case tag', () => {
  const r = scoreServer(server({ tags: ['Linux'] }), 'LINUX');
  // Query is lowercased upstream in searchCache; scoreServer receives
  // it already lowercased. Test that scoreServer compares lowercased.
  // Here we pass uppercased to confirm the comparison is one-way (only
  // server fields get lowercased inside scoreServer). The exact-tag
  // tier compares t.toLowerCase() === q, so an uppercase query fails
  // unless the caller lowercases first. This documents that contract.
  // We score uppercase 'LINUX' against tag 'Linux': lowercase tag is
  // 'linux' which does not equal 'LINUX', so falls through to contains:
  // tag 'Linux'.toLowerCase() = 'linux', q = 'LINUX' -> includes() is
  // false because 'linux' does not include 'LINUX'. So score 0.
  // This is the documented contract: callers (searchCache) must
  // lowercase the query before calling scoreServer.
  assert.equal(r.score, 0);
});

test('searchCache lowercases query before scoring (integration with scoreServer contract)', async () => {
  const { searchCache } = await import('../../extension/src/background/omni-search-handlers.js');
  const cache = {
    fetchedAt: Date.now(), tenantOrigin: 'x',
    servers: [server({ name: 'Linux-box' })],
    corpus: ['linux-box'],
  };
  const r = searchCache(cache, 'LINUX');
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].matched_field, 'name');
});

test('exact-name match outranks substring match for the same query', async () => {
  const { searchCache } = await import('../../extension/src/background/omni-search-handlers.js');
  const cache = {
    fetchedAt: Date.now(), tenantOrigin: 'x',
    servers: [
      server({ id: 1, name: 'SQL_Server_01' }),
      server({ id: 2, name: 'server' }),
      server({ id: 3, name: 'web', tags: ['server-tag'] }),
    ],
    corpus: ['sql_server_01', 'server', 'web\nserver-tag'],
  };
  const r = searchCache(cache, 'server');
  assert.equal(r.matches[0].name, 'server', 'exact name match must be row 1');
  assert.equal(r.matches[0].matched_field, 'name');
});
