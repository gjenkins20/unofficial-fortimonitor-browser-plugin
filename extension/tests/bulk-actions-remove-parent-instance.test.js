import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../src/lib/bulk-actions/remove-parent-instance.js';

// =====================================================================
// FMN-279: Remove Parent Instance bulk action descriptor
// =====================================================================

const PARENT = { id: 500, name: 'core-fw', url: 'https://api2.panopta.com/v2/server/500' };

test('validate: always ok (no params)', () => {
  assert.equal(a.validate().ok, true);
  assert.equal(a.validate({}).ok, true);
});

// ---------- describe ----------

test('describe: parent unknown (unenriched) -> placeholder will-change', () => {
  const d = a.describe({ id: 1, name: 's1' });
  assert.equal(d.willChange, true);
  assert.equal(d.next, '(none)');
});

test('describe: no parent -> skip', () => {
  const d = a.describe({ id: 1, name: 's1', parentInstance: null });
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /No parent set/);
});

test('describe: has parent -> will remove', () => {
  const d = a.describe({ id: 1, name: 's1', parentInstance: PARENT });
  assert.equal(d.willChange, true);
  assert.equal(d.prev, 'core-fw');
  assert.equal(d.next, '(none)');
  assert.match(d.note, /Will remove parent "core-fw"/);
});

// ---------- commit ----------

test('commit: calls removeServerParentInstance; reports cleared parent', async () => {
  let called = null;
  const fortimonitorClient = {
    async removeServerParentInstance(id) { called = id; return { status: 200, success: true, message: 'changed parent server from core-fw to None' }; }
  };
  const out = await a.commit({ id: 42, parentInstance: PARENT }, {}, { fortimonitorClient });
  assert.equal(out.noop, false);
  assert.equal(called, 42);
  assert.equal(out.parent.to, null);
  assert.deepEqual(out.parent.from, PARENT);
});

test('commit: pre-flight says no parent -> noop, never calls the client', async () => {
  let called = false;
  const fortimonitorClient = { async removeServerParentInstance() { called = true; return {}; } };
  const out = await a.commit({ id: 42, parentInstance: null }, {}, { fortimonitorClient });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'no-parent');
  assert.equal(called, false);
});

test('commit: parent unknown (undefined) still attempts removal', async () => {
  let called = false;
  const fortimonitorClient = { async removeServerParentInstance() { called = true; return { status: 200, success: true, message: 'ok' }; } };
  const out = await a.commit({ id: 42 }, {}, { fortimonitorClient });
  assert.equal(called, true);
  assert.equal(out.noop, false);
});

test('commit: 404 surfaces friendly error', async () => {
  const fortimonitorClient = {
    async removeServerParentInstance() { const e = new Error('nf'); e.status = 404; throw e; }
  };
  await assert.rejects(
    () => a.commit({ id: 42, parentInstance: PARENT }, {}, { fortimonitorClient }),
    /Instance #42 not found/
  );
});

test('commit: missing client throws', async () => {
  await assert.rejects(() => a.commit({ id: 1, parentInstance: PARENT }, {}, {}), /FortimonitorClient required/);
});
