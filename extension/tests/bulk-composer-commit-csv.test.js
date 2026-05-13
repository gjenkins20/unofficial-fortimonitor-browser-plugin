// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-209: post-commit CSV must include `template` + `outcome` columns
// so operators can audit which template went where after a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCsv } from '../src/ui/bulk-composer/steps/commit.js';

test('header row contains template + outcome columns', () => {
  const csv = buildCsv({ rows: [] });
  const header = csv.split('\n')[0];
  assert.match(header, /^id,name,status,outcome,template,noop,error,errorStatus$/);
});

test('FMN-200 commit row surfaces template name + created+attached outcome', () => {
  const row = {
    id: 42024061,
    name: 'FGVM01TM24006845',
    status: 'succeeded',
    noop: false,
    detail: {
      status: 200,
      noop: false,
      reason: 'attached',
      template: { id: 555, name: 'FortiGate FGVM64-AWS Best Practice', created: true, reused: false, populated_count: 33 }
    }
  };
  const csv = buildCsv({ rows: [row] });
  const dataLine = csv.split('\n')[1];
  assert.match(dataLine, /42024061/);
  assert.match(dataLine, /FortiGate FGVM64-AWS Best Practice/);
  assert.match(dataLine, /created\+attached/);
  assert.match(dataLine, /33 metrics populated/);
});

test('reused template emits reused+attached outcome', () => {
  const csv = buildCsv({ rows: [{
    id: 1, name: 'x', status: 'succeeded', noop: true,
    detail: { template: { id: 1, name: 'T', created: false, reused: true, populated_count: 0 } }
  }] });
  assert.match(csv.split('\n')[1], /reused\+attached/);
});

test('already-attached reason emits the right outcome', () => {
  const csv = buildCsv({ rows: [{
    id: 1, name: 'x', status: 'succeeded', noop: true,
    detail: { reason: 'template-already-attached', template: { id: 1, name: 'T' } }
  }] });
  const line = csv.split('\n')[1];
  assert.match(line, /already-attached/);
  assert.match(line, /T/);
});

test('dry-run surfaces would-create outcome', () => {
  const csv = buildCsv({ rows: [{
    id: 1, name: 'x', status: 'succeeded', noop: false,
    detail: { reason: 'dry-run', dry_run: true, template: { name: 'T', would_create: true, would_attach: true } }
  }] });
  // CSV escapes embedded quotes by doubling them: "T" -> ""T""
  assert.match(csv.split('\n')[1], /dry-run: would create\+attach ""T""/);
});

test('no-matching-cluster reason emits the right outcome', () => {
  const csv = buildCsv({ rows: [{
    id: 1, name: 'x', status: 'succeeded', noop: true,
    detail: { reason: 'no-matching-cluster' }
  }] });
  assert.match(csv.split('\n')[1], /no-matching-cluster/);
});

test('legacy tag-action row remains valid (back-compat)', () => {
  const csv = buildCsv({ rows: [{
    id: 1, name: 'x', status: 'succeeded', noop: false,
    detail: { tag: 'prod', added: true }
  }] });
  const line = csv.split('\n')[1];
  assert.match(line, /tag added: prod/);
});

test('row without detail produces empty template + outcome fields (back-compat)', () => {
  const csv = buildCsv({ rows: [{
    id: 1, name: 'x', status: 'succeeded', noop: false
  }] });
  // header has 8 columns -> data line should have 7 commas separating 8 fields
  const line = csv.split('\n')[1];
  assert.equal(line.split(',').length, 8);
});

test('failed row surfaces failure reason as outcome', () => {
  const csv = buildCsv({ rows: [{
    id: 1, name: 'x', status: 'failed', error: 'boom',
    detail: { reason: 'fmclient-error' }
  }] });
  assert.match(csv.split('\n')[1], /fmclient-error/);
});

test('CSV escaping: name with comma is quoted', () => {
  const csv = buildCsv({ rows: [{
    id: 1, name: 'A, B', status: 'succeeded'
  }] });
  assert.match(csv, /"A, B"/);
});
