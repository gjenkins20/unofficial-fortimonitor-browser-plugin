import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFortigateList } from '../src/ui/fabric-connection/parse-csv.js';

test('parses positional rows (no header)', () => {
  const r = parseFortigateList('FGVM01TM24006844,10.0.0.94,8013\nFGVM02TM24006845,10.0.0.95,8013');
  assert.equal(r.devices.length, 2);
  assert.deepEqual(r.devices[0], { serial: 'FGVM01TM24006844', ip: '10.0.0.94', port: 8013, lineNum: 1 });
});

test('parses with header row', () => {
  const r = parseFortigateList('serial,ip,port\nFGVM01TM24006844,10.0.0.94,8013');
  assert.equal(r.devices.length, 1);
  assert.equal(r.totalLines, 1); // header doesn't count
});

test('header recognizes synonym columns', () => {
  const r = parseFortigateList('sn,upstream_host,upstream_port\nFGVM01TM24006844,10.0.0.94,541');
  assert.equal(r.devices.length, 1);
  assert.equal(r.devices[0].port, 541);
});

test('default port applied when port column omitted', () => {
  const r = parseFortigateList('serial,ip\nFGVM01TM24006844,10.0.0.94');
  assert.equal(r.devices[0].port, 8013);
});

test('custom defaultPort honored', () => {
  const r = parseFortigateList('FGVM01TM24006844,10.0.0.94', { defaultPort: 541 });
  // No port column, positional layout - port column missing → default
  assert.equal(r.devices[0].port, 541);
});

test('skips invalid IP and warns', () => {
  const r = parseFortigateList('FGVM01TM24006844,not-an-ip,8013');
  assert.equal(r.devices.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /not a valid IPv4/);
});

test('skips invalid port and warns', () => {
  const r = parseFortigateList('FGVM01TM24006844,10.0.0.94,99999');
  assert.equal(r.devices.length, 0);
  assert.match(r.warnings[0], /not a valid port/);
});

test('skips short serial (looks suspicious)', () => {
  const r = parseFortigateList('SHORT,10.0.0.94,8013');
  assert.equal(r.devices.length, 0);
  assert.match(r.warnings[0], /serial/);
});

test('deduplicates by serial', () => {
  const r = parseFortigateList(
    'FGVM01TM24006844,10.0.0.94,8013\nFGVM01TM24006844,10.0.0.95,8013'
  );
  assert.equal(r.devices.length, 1);
  assert.match(r.warnings[0], /duplicate/);
});

test('strips comments', () => {
  const r = parseFortigateList('# preamble\nFGVM01TM24006844,10.0.0.94,8013 # branch one');
  assert.equal(r.devices.length, 1);
});

test('ignores blank lines', () => {
  const r = parseFortigateList('\n\nFGVM01TM24006844,10.0.0.94,8013\n\n');
  assert.equal(r.devices.length, 1);
});

test('skips rows missing serial', () => {
  const r = parseFortigateList(',10.0.0.94,8013');
  assert.equal(r.devices.length, 0);
  assert.match(r.warnings[0], /missing serial/);
});

test('skips rows missing IP', () => {
  const r = parseFortigateList('FGVM01TM24006844,,8013');
  assert.equal(r.devices.length, 0);
  assert.match(r.warnings[0], /missing IP/);
});
