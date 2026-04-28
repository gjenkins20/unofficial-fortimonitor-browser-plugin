import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInput,
  classifyLine,
  extractServerIdFromUrl,
  URL_PATTERNS
} from '../src/ui/server-lookup/parse-input.js';

// ---- extractServerIdFromUrl / classifyLine -------------------------

test('extractServerIdFromUrl: /instance/N path with trailing segments', () => {
  assert.equal(extractServerIdFromUrl('https://fortimonitor.forticloud.com/instance/12345/details'), 12345);
  assert.equal(extractServerIdFromUrl('https://fortimonitor.forticloud.com/instance/42024060'), 42024060);
  assert.equal(extractServerIdFromUrl('/instance/9'), 9);
});

test('extractServerIdFromUrl: case-insensitive (FMN-113 QA: real URL is /report/Instance/N/details)', () => {
  assert.equal(extractServerIdFromUrl('https://fortimonitor.forticloud.com/report/Instance/42024060/details'), 42024060);
  assert.equal(extractServerIdFromUrl('https://fortimonitor.forticloud.com/REPORT/INSTANCE/12345'), 12345);
});

test('extractServerIdFromUrl: rejects non-/instance paths', () => {
  assert.equal(extractServerIdFromUrl('https://fortimonitor.forticloud.com/server/12345'), null);
  assert.equal(extractServerIdFromUrl('https://example.com/'), null);
});

test('extractServerIdFromUrl: rejects /instance/non-digit', () => {
  assert.equal(extractServerIdFromUrl('/instance/abc'), null);
  assert.equal(extractServerIdFromUrl('/instance/'), null);
});

test('classifyLine: URL', () => {
  const r = classifyLine('https://fortimonitor.forticloud.com/instance/42024060/edit');
  assert.equal(r.kind, 'url');
  assert.equal(r.serverId, 42024060);
  assert.equal(r.raw, 'https://fortimonitor.forticloud.com/instance/42024060/edit');
});

test('classifyLine: bare numeric ID', () => {
  const r = classifyLine('42024060');
  assert.equal(r.kind, 'id');
  assert.equal(r.serverId, 42024060);
});

test('classifyLine: name fall-through', () => {
  const r = classifyLine('FGVM01TM24006844');
  assert.equal(r.kind, 'name');
  assert.equal(r.name, 'FGVM01TM24006844');
});

test('classifyLine: empty / whitespace returns null', () => {
  assert.equal(classifyLine(''), null);
  assert.equal(classifyLine('   '), null);
});

test('classifyLine: numeric-zero rejected (treated as name)', () => {
  // /^\d+$/ matches "0" but our extractor requires id > 0; the line then
  // falls through to name classification. This keeps a stray "0" from
  // accidentally pretending to be a valid server_id.
  const r = classifyLine('0');
  assert.equal(r.kind, 'name');
  assert.equal(r.name, '0');
});

test('URL_PATTERNS: stable initial set is exactly the operator-confirmed format', () => {
  // If a future change adds patterns, this test will fail loudly so the
  // change is reviewed. /instance/N is the format the operator confirmed
  // pasting; other formats need their own ticket.
  assert.equal(URL_PATTERNS.length, 1);
  assert.equal(URL_PATTERNS[0].label, '/instance/N (case-insensitive)');
});

// ---- parseInput ---------------------------------------------------

test('parseInput: empty input yields empty result', () => {
  assert.deepEqual(parseInput(''), { entries: [], warnings: [], totalLines: 0 });
  assert.deepEqual(parseInput(null), { entries: [], warnings: [], totalLines: 0 });
});

test('parseInput: mixed URL / ID / name in one paste', () => {
  const r = parseInput([
    'FGVM01',
    'https://fortimonitor.forticloud.com/instance/42024060/details',
    '42024061'
  ].join('\n'));
  assert.equal(r.entries.length, 3);
  assert.equal(r.entries[0].kind, 'name');
  assert.equal(r.entries[0].name, 'FGVM01');
  assert.equal(r.entries[1].kind, 'url');
  assert.equal(r.entries[1].serverId, 42024060);
  assert.equal(r.entries[2].kind, 'id');
  assert.equal(r.entries[2].serverId, 42024061);
  assert.equal(r.warnings.length, 0);
});

test('parseInput: header row "name" is skipped', () => {
  const r = parseInput('name\nFGVM01\nFGVM02');
  assert.deepEqual(r.entries.map((e) => e.name), ['FGVM01', 'FGVM02']);
});

test('parseInput: URL on first line is NEVER mistaken for the "name" header', () => {
  const r = parseInput('https://fortimonitor.forticloud.com/instance/42024060\nFGVM01');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].kind, 'url');
  assert.equal(r.entries[0].serverId, 42024060);
});

test('parseInput: ID on first line is NEVER mistaken for the "name" header', () => {
  const r = parseInput('42024060\nFGVM01');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].kind, 'id');
});

test('parseInput: comments stripped', () => {
  const r = parseInput('# top comment\nFGVM01\n42024060 # inline\nFGVM02');
  assert.equal(r.entries.length, 3);
  assert.equal(r.entries[1].kind, 'id');
});

test('parseInput: blank lines ignored', () => {
  const r = parseInput('FGVM01\n\n\n42024060\n   \n');
  assert.equal(r.entries.length, 2);
});

test('parseInput: dedupes URL and raw ID for the same server, with warning', () => {
  const r = parseInput([
    'https://fortimonitor.forticloud.com/instance/42024060/details',
    '42024060'
  ].join('\n'));
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].kind, 'url');
  assert.equal(r.entries[0].serverId, 42024060);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Duplicate server id 42024060/);
});

test('parseInput: dedupes repeated names with warning (legacy behaviour)', () => {
  const r = parseInput('alpha\nalpha\nbeta\nalpha');
  assert.deepEqual(r.entries.map((e) => e.name), ['alpha', 'beta']);
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /Duplicate name "alpha"/);
});

test('parseInput: CSV first cell is taken when extra columns present', () => {
  const r = parseInput('alpha,extra,stuff\nbeta,more');
  assert.deepEqual(r.entries.map((e) => e.name), ['alpha', 'beta']);
});

test('parseInput: surrounding double quotes stripped from a name cell', () => {
  const r = parseInput('"alpha"\n"beta"');
  assert.deepEqual(r.entries.map((e) => e.name), ['alpha', 'beta']);
});

test('parseInput: CRLF and CR line endings handled', () => {
  assert.deepEqual(parseInput('a\r\nb\r\nc').entries.map((e) => e.name), ['a', 'b', 'c']);
  assert.deepEqual(parseInput('a\rb\rc').entries.map((e) => e.name), ['a', 'b', 'c']);
});

test('parseInput: case-sensitive on names - "Alpha" and "alpha" are distinct', () => {
  const r = parseInput('Alpha\nalpha');
  assert.deepEqual(r.entries.map((e) => e.name), ['Alpha', 'alpha']);
  assert.equal(r.warnings.length, 0);
});
