import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../src/lib/bulk-actions/delete-instance.js';
import { getAction, listActions } from '../src/lib/bulk-actions/index.js';

// =====================================================================
// Bulk action - Delete Instances (destructive)
// =====================================================================

// ---------- registry ----------

// A v2 client whose GET /server/{id} resolves (the id IS a server). Tests that
// exercise a real delete pass this so the servers-only verification succeeds.
function serverClient(existingIds = null) {
  return {
    getJsonCalls: [],
    async getJson(path) {
      this.getJsonCalls.push(path);
      if (existingIds === null) return { id: 1 }; // any id is a server
      const m = /\/server\/(\d+)/.exec(path);
      if (m && existingIds.includes(Number(m[1]))) return { id: Number(m[1]) };
      const e = new Error('not found'); e.status = 404; throw e;
    }
  };
}

test('registry: delete-instance is registered and resolvable', () => {
  assert.equal(a.id, 'delete-instance');
  assert.equal(a.requires, 'apiKey+session');
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
  const fortimonitorClient = { async deleteServerOrTemplate() { throw new Error('should not be called'); } };
  await assert.rejects(
    () => a.commit({ id: 9, name: 's9' }, {}, { client: serverClient(), fortimonitorClient }),
    /Type DELETE to confirm/
  );
});

test('commit: verifies server then deletes when confirmed', async () => {
  const calls = [];
  const client = serverClient(); // any id is a server
  const fortimonitorClient = { async deleteServerOrTemplate(id) { calls.push(id); return { status: 200 }; } };
  const out = await a.commit({ id: 42, name: 's42' }, { confirm: 'DELETE' }, { client, fortimonitorClient });
  assert.deepEqual(calls, [42]);
  assert.equal(out.deleted, true);
  assert.equal(out.noop, false);
  assert.equal(out.status, 200);
  assert.equal(out.id, 42);
  // verification GET hit /server/42 before deleting
  assert.ok(client.getJsonCalls.some((p) => p.includes('/server/42')));
});

test('servers only: a non-server id (template / gone) is skipped, never deleted', async () => {
  // id 7 is NOT in the server list -> GET /server/7 404s -> skip, no delete.
  const client = serverClient([1, 2, 3]);
  const fortimonitorClient = { async deleteServerOrTemplate() { throw new Error('delete must not be called for a non-server'); } };
  const out = await a.commit({ id: 7 }, { confirm: 'DELETE' }, { client, fortimonitorClient });
  assert.equal(out.noop, true);
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'not-a-server');
  assert.equal(out.deleted, false);
});

test('commit: a server racing to 404 at delete time is an idempotent skip', async () => {
  const client = serverClient(); // verify passes
  const fortimonitorClient = {
    async deleteServerOrTemplate() { const e = new Error('not found'); e.status = 404; throw e; }
  };
  const out = await a.commit({ id: 7 }, { confirm: 'DELETE' }, { client, fortimonitorClient });
  assert.equal(out.noop, true);
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'not-found');
});

test('commit: non-404 errors propagate (do not swallow real failures)', async () => {
  const client = serverClient();
  const fortimonitorClient = {
    async deleteServerOrTemplate() { const e = new Error('boom'); e.status = 500; throw e; }
  };
  await assert.rejects(
    () => a.commit({ id: 7 }, { confirm: 'DELETE' }, { client, fortimonitorClient }),
    /boom/
  );
});

test('commit: a non-404 verification error propagates (e.g. auth)', async () => {
  const client = { async getJson() { const e = new Error('unauthorized'); e.status = 401; throw e; } };
  const fortimonitorClient = { async deleteServerOrTemplate() { throw new Error('must not delete'); } };
  await assert.rejects(
    () => a.commit({ id: 7 }, { confirm: 'DELETE' }, { client, fortimonitorClient }),
    /unauthorized/
  );
});

test('commit: requires both clients and a target id', async () => {
  await assert.rejects(
    () => a.commit({ id: 1 }, { confirm: 'DELETE' }, { client: serverClient() }),
    /FortimonitorClient required/
  );
  await assert.rejects(
    () => a.commit({ id: 1 }, { confirm: 'DELETE' }, { fortimonitorClient: { async deleteServerOrTemplate() {} } }),
    /PanoptaClient/
  );
  await assert.rejects(
    () => a.commit({ name: 'no-id' }, { confirm: 'DELETE' }, { client: serverClient(), fortimonitorClient: { async deleteServerOrTemplate() {} } }),
    /id is required/
  );
});
