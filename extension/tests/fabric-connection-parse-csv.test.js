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

// ---- FMN-265: cloud serials (hyphens) + include-flagged override ----

test('accepts cloud serials with a hyphen by default (FGTAWS-)', () => {
  const r = parseFortigateList('FGTAWS-LYSIUYW7D,10.0.0.5,8013');
  assert.equal(r.devices.length, 0 + 1);
  assert.deepEqual(r.devices[0], { serial: 'FGTAWS-LYSIUYW7D', ip: '10.0.0.5', port: 8013, lineNum: 1 });
  assert.equal(r.warnings.length, 0);
});

test('a serial of only hyphens is still rejected (needs an alphanumeric)', () => {
  const r = parseFortigateList('--------,10.0.0.5,8013');
  assert.equal(r.devices.length, 0);
  const soft = r.skipped.filter((s) => s.severity === 'soft');
  assert.equal(soft.length, 1);
});

test('skipped array carries structured reason + severity', () => {
  const r = parseFortigateList('FGVM01TM24006844,not-an-ip,8013');
  assert.equal(r.devices.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].severity, 'soft');
  assert.equal(r.skipped[0].serial, 'FGVM01TM24006844');
  assert.match(r.skipped[0].reason, /not a valid IPv4/);
});

test('includeFlagged onboards an unusual serial and marks it flagged', () => {
  const off = parseFortigateList('FGT@BADSERIAL,10.0.0.5,8013');
  assert.equal(off.devices.length, 0);
  assert.equal(off.skipped[0].severity, 'soft');

  const on = parseFortigateList('FGT@BADSERIAL,10.0.0.5,8013', { includeFlagged: true });
  assert.equal(on.devices.length, 1);
  assert.equal(on.devices[0].serial, 'FGT@BADSERIAL');
  assert.match(on.devices[0].flagged, /unusual serial/);
});

test('includeFlagged onboards a non-IPv4 host and preserves it', () => {
  const on = parseFortigateList('FGVM01TM24006844,fgt.branch.example.com,8013', { includeFlagged: true });
  assert.equal(on.devices.length, 1);
  assert.equal(on.devices[0].ip, 'fgt.branch.example.com');
  assert.match(on.devices[0].flagged, /non-IPv4 host/);
});

test('includeFlagged does NOT onboard rows missing a required field (hard skip)', () => {
  const on = parseFortigateList('FGVM01TM24006844,,8013', { includeFlagged: true });
  assert.equal(on.devices.length, 0);
  assert.equal(on.skipped[0].severity, 'hard');
});

test('includeFlagged still deduplicates by serial', () => {
  const on = parseFortigateList(
    'FGT@BADSERIAL,10.0.0.5,8013\nFGT@BADSERIAL,10.0.0.6,8013',
    { includeFlagged: true }
  );
  assert.equal(on.devices.length, 1);
  assert.ok(on.skipped.some((s) => s.severity === 'dedup'));
});

test('includeFlagged leaves a clean serial unflagged', () => {
  const on = parseFortigateList('FGVM01TM24006844,10.0.0.5,8013', { includeFlagged: true });
  assert.equal(on.devices.length, 1);
  assert.equal(on.devices[0].flagged, undefined);
});
