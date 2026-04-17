import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServerList } from '../src/ui/parse-csv.js';

test('plain list: one ID per line', () => {
  const r = parseServerList('42024060\n42024061\n42024075');
  assert.deepEqual(r.serverIds, ['42024060', '42024061', '42024075']);
  assert.deepEqual(r.nameById, {});
  assert.deepEqual(r.warnings, []);
  assert.equal(r.totalLines, 3);
});

test('plain list: strips blank lines and comments', () => {
  const r = parseServerList('\n42024060\n# comment\n\n42024061\n');
  assert.deepEqual(r.serverIds, ['42024060', '42024061']);
  assert.equal(r.totalLines, 2);
});

test('plain list: dedupes, surfaces warnings', () => {
  const r = parseServerList('42024060\n42024060\n42024061');
  assert.deepEqual(r.serverIds, ['42024060', '42024061']);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /duplicate/i);
});

test('plain list: rejects non-numeric with warning', () => {
  const r = parseServerList('42024060\nfoo\n42024061');
  assert.deepEqual(r.serverIds, ['42024060', '42024061']);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /not a numeric/i);
});

test('csv: server_id header with device_name column', () => {
  const input = 'server_id,device_name\n42024060,FGT-Branch-001\n42024061,FGT-Branch-002';
  const r = parseServerList(input);
  assert.deepEqual(r.serverIds, ['42024060', '42024061']);
  assert.equal(r.nameById['42024060'], 'FGT-Branch-001');
  assert.equal(r.nameById['42024061'], 'FGT-Branch-002');
  assert.equal(r.totalLines, 2);
});

test('csv: extra columns are ignored', () => {
  const input = 'server_id,device_name,foo\n42024060,a,x\n42024061,b,y';
  const r = parseServerList(input);
  assert.deepEqual(r.serverIds, ['42024060', '42024061']);
  assert.deepEqual(r.nameById, { 42024060: 'a', 42024061: 'b' });
});

test('csv: handles quoted fields with commas', () => {
  const input = 'server_id,device_name\n42024060,"Site, Branch 1"';
  const r = parseServerList(input);
  assert.equal(r.nameById['42024060'], 'Site, Branch 1');
});

test('empty input yields empty result', () => {
  const r = parseServerList('');
  assert.deepEqual(r.serverIds, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.totalLines, 0);
});

test('handles Windows CRLF line endings', () => {
  const r = parseServerList('42024060\r\n42024061\r\n');
  assert.deepEqual(r.serverIds, ['42024060', '42024061']);
});

test('csv: header with only server_id column still parses', () => {
  const input = 'server_id\n42024060\n42024061';
  const r = parseServerList(input);
  assert.deepEqual(r.serverIds, ['42024060', '42024061']);
  assert.deepEqual(r.nameById, {});
});
