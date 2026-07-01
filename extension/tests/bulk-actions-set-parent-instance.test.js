import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../src/lib/bulk-actions/set-parent-instance.js';

// =====================================================================
// FMN-277: Set Parent Instance bulk action descriptor (device parent/child)
// =====================================================================

const PARENT_URL = 'https://api2.panopta.com/v2/server/500';
const PARENT_URL_2 = 'https://api2.panopta.com/v2/server/600';

const RULE = { parentUrl: PARENT_URL, parentName: 'core-fw' };

// ---------- validate ----------

test('validate: requires parentUrl', () => {
  assert.equal(a.validate({}).ok, false);
  assert.equal(a.validate({ parentName: 'core-fw' }).ok, false);
  const ok = a.validate(RULE);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.parentUrl, PARENT_URL);
  assert.equal(ok.value.parentName, 'core-fw');
});

test('validate: parentName is optional', () => {
  const ok = a.validate({ parentUrl: PARENT_URL });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.parentName, null);
});

// ---------- describe ----------

test('describe: parent unknown (unenriched target) -> placeholder branch', () => {
  const d = a.describe({ id: 1, name: 's1' }, RULE);
  assert.equal(d.willChange, true);
  assert.equal(d.prev, '(parent unknown)');
  assert.match(d.next, /core-fw/);
});

test('describe: already parented to target -> skip', () => {
  const target = { id: 1, name: 's1', parentInstance: { id: 500, name: 'core-fw', url: PARENT_URL } };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /Already parented to "core-fw"/);
});

test('describe: different parent -> will-set', () => {
  const target = { id: 1, name: 's1', parentInstance: { id: 600, name: 'edge-fw', url: PARENT_URL_2 } };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, true);
  assert.equal(d.prev, 'edge-fw');
  assert.equal(d.next, 'core-fw');
  assert.match(d.note, /from "edge-fw" to "core-fw"/);
});

test('describe: parentInstance=null (no parent) -> will-set from (none)', () => {
  const target = { id: 1, name: 's1', parentInstance: null };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, true);
  assert.equal(d.prev, '(none)');
  assert.equal(d.next, 'core-fw');
});

test('describe: self-parent -> skip even when parent unknown', () => {
  // target id 500 == the parent url id -> cannot be its own parent
  const d = a.describe({ id: 500, name: 'core-fw' }, RULE);
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /cannot be its own parent/);
});

// ---------- commit ----------

test('commit: calls setServerParentInstance; reports new parent', async () => {
  let captured = null;
  const client = {
    async setServerParentInstance(serverId, url) {
      captured = { serverId, url };
      return { status: 204, from: PARENT_URL_2, to: url, noop: false };
    }
  };
  const out = await a.commit({ id: 42, name: 's42' }, RULE, { client });
  assert.equal(out.noop, false);
  assert.equal(out.parent.from, PARENT_URL_2);
  assert.equal(out.parent.to, PARENT_URL);
  assert.equal(out.parent.name, 'core-fw');
  assert.deepEqual(captured, { serverId: 42, url: PARENT_URL });
});

test('commit: already-parented -> noop, no error', async () => {
  const client = {
    async setServerParentInstance() {
      return { status: 200, from: PARENT_URL, to: PARENT_URL, noop: true };
    }
  };
  const out = await a.commit({ id: 42, name: 's42' }, RULE, { client });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'already-parented');
});

test('commit: self-parent short-circuits before hitting the client', async () => {
  let called = false;
  const client = { async setServerParentInstance() { called = true; return {}; } };
  const out = await a.commit({ id: 500, name: 'core-fw' }, RULE, { client });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'self-parent');
  assert.equal(called, false);
});

test('commit: 404 from client surfaces friendly error', async () => {
  const client = {
    async setServerParentInstance() {
      const err = new Error('Not found');
      err.status = 404;
      throw err;
    }
  };
  await assert.rejects(
    () => a.commit({ id: 42, name: 's42' }, RULE, { client }),
    /Instance #42 not found/
  );
});

test('commit: missing client throws', async () => {
  await assert.rejects(() => a.commit({ id: 1, name: 'x' }, RULE, {}), /PanoptaClient required/);
});
