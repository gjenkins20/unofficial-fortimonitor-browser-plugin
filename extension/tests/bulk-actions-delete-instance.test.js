import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../src/lib/bulk-actions/delete-instance.js';
import { getAction, listActions } from '../src/lib/bulk-actions/index.js';

// =====================================================================
// Bulk action - Delete Instances (destructive)
// =====================================================================

// ---------- registry ----------

test('registry: delete-instance is registered and resolvable', () => {
  assert.equal(a.id, 'delete-instance');
  assert.equal(a.requires, 'session');
  assert.equal(getAction('delete-instance'), a);
  assert.ok(listActions().some((x) => x.id === 'delete-instance'));
});

// ---------- validate (the confirm gate) ----------

test('validate: rejects missing / wrong confirm phrase', () => {
  assert.equal(a.validate({}).ok, false);
  assert.equal(a.validate({ confirm: '' }).ok, false);
  assert.equal(a.validate({ confirm: 'delete' }).ok, false);     // case-sensitive
  assert.equal(a.validate({ confirm: 'DELETE ' }).ok, false);    // no trimming
  assert.equal(a.validate({ confirm: 'yes' }).ok, false);
});

test('validate: accepts the exact confirm phrase', () => {
  const r = a.validate({ confirm: a.CONFIRM_PHRASE });
  assert.equal(r.ok, true);
  assert.equal(r.value.confirm, 'DELETE');
});

// ---------- describe ----------

test('describe: always previews exists -> DELETED, independent of confirm', () => {
  const d = a.describe({ id: 5, name: 's5' }, {});
  assert.equal(d.prev, 'exists');
  assert.equal(d.next, 'DELETED');
  assert.equal(d.willChange, true);
  assert.match(d.note, /irreversible|destroyed|No undo/i);
  // describe must NOT gate on the confirm phrase (preview shows blast radius first)
  assert.equal(d.error, undefined);
});

// ---------- commit ----------

test('commit: refuses without the confirm phrase even if UI is bypassed', async () => {
  const client = { async deleteServerOrTemplate() { throw new Error('should not be called'); } };
  await assert.rejects(
    () => a.commit({ id: 9, name: 's9' }, {}, { fortimonitorClient: client }),
    /Type DELETE to confirm/
  );
});

test('commit: deletes via deleteServerOrTemplate when confirmed', async () => {
  const calls = [];
  const client = {
    async deleteServerOrTemplate(id) { calls.push(id); return { status: 200 }; }
  };
  const out = await a.commit({ id: 42, name: 's42' }, { confirm: 'DELETE' }, { fortimonitorClient: client });
  assert.deepEqual(calls, [42]);
  assert.equal(out.deleted, true);
  assert.equal(out.noop, false);
  assert.equal(out.status, 200);
  assert.equal(out.id, 42);
});

test('commit: 404 is an idempotent skip (already gone), not a hard failure', async () => {
  const client = {
    async deleteServerOrTemplate() { const e = new Error('not found'); e.status = 404; throw e; }
  };
  const out = await a.commit({ id: 7 }, { confirm: 'DELETE' }, { fortimonitorClient: client });
  assert.equal(out.noop, true);
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'not-found');
  assert.equal(out.deleted, false);
});

test('commit: non-404 errors propagate (do not swallow real failures)', async () => {
  const client = {
    async deleteServerOrTemplate() { const e = new Error('boom'); e.status = 500; throw e; }
  };
  await assert.rejects(
    () => a.commit({ id: 7 }, { confirm: 'DELETE' }, { fortimonitorClient: client }),
    /boom/
  );
});

test('commit: requires a fortimonitorClient and a target id', async () => {
  await assert.rejects(
    () => a.commit({ id: 1 }, { confirm: 'DELETE' }, {}),
    /FortimonitorClient required/
  );
  const client = { async deleteServerOrTemplate() { return { status: 200 }; } };
  await assert.rejects(
    () => a.commit({ name: 'no-id' }, { confirm: 'DELETE' }, { fortimonitorClient: client }),
    /id is required/
  );
});
