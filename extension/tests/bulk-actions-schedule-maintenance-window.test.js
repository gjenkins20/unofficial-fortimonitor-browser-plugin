import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../src/lib/bulk-actions/schedule-maintenance-window.js';

// =====================================================================
// FMN-172: Schedule Maintenance Window descriptor
// =====================================================================

const RULE = {
  name: 'Quarterly patch window',
  startTime: '2026-06-01T22:00:00Z',
  endTime: '2026-06-02T04:00:00Z',
  description: 'Patch window for the Q3 maintenance.',
  pauseAllChecks: true
};

// ---------- validate ----------

test('validate: requires name + start + end (well-formed)', () => {
  assert.equal(a.validate({}).ok, false);
  assert.equal(a.validate({ name: 'x' }).ok, false);
  assert.equal(a.validate({ name: 'x', startTime: '2026-06-01T22:00:00Z' }).ok, false);
  assert.equal(a.validate({ name: 'x', startTime: 'not-a-date', endTime: '2026-06-02T00:00:00Z' }).ok, false);
  const ok = a.validate(RULE);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name, 'Quarterly patch window');
});

test('validate: end must be after start', () => {
  const r = a.validate({ name: 'x', startTime: '2026-06-02T00:00:00Z', endTime: '2026-06-01T00:00:00Z' });
  assert.equal(r.ok, false);
  assert.match(r.error, /End time must be after start/);
});

test('validate: pauseAllChecks defaults to true', () => {
  const ok = a.validate({ ...RULE, pauseAllChecks: undefined });
  assert.equal(ok.value.pauseAllChecks, true);
  const off = a.validate({ ...RULE, pauseAllChecks: false });
  assert.equal(off.value.pauseAllChecks, false);
});

test('validate: description is optional, trimmed', () => {
  const ok = a.validate({ ...RULE, description: '   ' });
  assert.equal(ok.value.description, '');
});

// ---------- describe ----------

test('describe: every target shows "covered by the shared MW"', () => {
  const d = a.describe({ id: 1, name: 's1' }, RULE);
  assert.equal(d.willChange, true);
  assert.equal(d.prev, '(no MW)');
  assert.match(d.next, /Quarterly patch window/);
});

test('describe: bad params surface via error field', () => {
  const d = a.describe({ id: 1, name: 's1' }, { name: 'x', startTime: 'nope', endTime: 'nope' });
  assert.equal(d.willChange, false);
  assert.ok(d.error);
});

// ---------- commit ----------

test('commit: first arrival creates the MW with the full targetUrls list', async () => {
  const calls = [];
  const client = {
    async scheduleMaintenanceWindow(args) {
      calls.push(args);
      return { status: 201, url: 'https://api2/v2/maintenance_schedule/9000/', id: 9000 };
    }
  };
  const sharedState = new Map();
  const allTargetUrls = ['/v2/server/10/', '/v2/server/11/', '/v2/server/12/'];
  const r = await a.commit({ id: 10, name: 's10' }, RULE, { client, sharedState, allTargetUrls });
  assert.equal(r.noop, false);
  assert.equal(r.maintenanceWindow.id, 9000);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].targetUrls, allTargetUrls);
  assert.equal(calls[0].name, 'Quarterly patch window');
});

test('commit: second/third arrivals reuse the cached promise (one POST per run)', async () => {
  let postCount = 0;
  const client = {
    async scheduleMaintenanceWindow() {
      postCount++;
      return { status: 201, url: 'https://api2/v2/maintenance_schedule/9001/', id: 9001 };
    }
  };
  const sharedState = new Map();
  const allTargetUrls = ['/v2/server/10/', '/v2/server/11/'];
  const r1 = await a.commit({ id: 10, name: 's10' }, RULE, { client, sharedState, allTargetUrls });
  const r2 = await a.commit({ id: 11, name: 's11' }, RULE, { client, sharedState, allTargetUrls });
  assert.equal(postCount, 1);
  assert.equal(r1.maintenanceWindow.id, 9001);
  assert.equal(r2.maintenanceWindow.id, 9001);
});

test('commit: missing client throws', async () => {
  await assert.rejects(() => a.commit({ id: 1 }, RULE, { sharedState: new Map() }), /PanoptaClient required/);
});

test('commit: missing sharedState throws', async () => {
  const client = { async scheduleMaintenanceWindow() { return {}; } };
  await assert.rejects(() => a.commit({ id: 1 }, RULE, { client }), /sharedState Map required/);
});
