import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../src/lib/bulk-actions/set-parent-group.js';

// =====================================================================
// FMN-170: Set Parent Group bulk action descriptor
// =====================================================================

const GROUP_URL = 'https://api2.panopta.com/v2/server_group/100/';
const GROUP_URL_2 = 'https://api2.panopta.com/v2/server_group/200/';

const RULE = { groupUrl: GROUP_URL, groupName: 'Production' };

// ---------- validate ----------

test('validate: requires groupUrl', () => {
  assert.equal(a.validate({}).ok, false);
  assert.equal(a.validate({ groupName: 'Prod' }).ok, false);
  const ok = a.validate(RULE);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.groupUrl, GROUP_URL);
  assert.equal(ok.value.groupName, 'Production');
});

test('validate: groupName is optional', () => {
  const ok = a.validate({ groupUrl: GROUP_URL });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.groupName, null);
});

// ---------- describe ----------

test('describe: parent unknown (unenriched target) -> placeholder branch', () => {
  const d = a.describe({ id: 1, name: 's1' }, RULE);
  assert.equal(d.willChange, true);
  assert.equal(d.prev, '(group unknown)');
  assert.match(d.next, /Production/);
});

test('describe: already in target group -> skip', () => {
  const target = { id: 1, name: 's1', parentGroup: { id: 100, name: 'Production', url: GROUP_URL } };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /Already in "Production"/);
});

test('describe: in a different group -> will-move', () => {
  const target = { id: 1, name: 's1', parentGroup: { id: 200, name: 'Staging', url: GROUP_URL_2 } };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, true);
  assert.equal(d.prev, 'Staging');
  assert.equal(d.next, 'Production');
  assert.match(d.note, /from "Staging" to "Production"/);
});

test('describe: parentGroup=null (root-level instance) -> will-move from (none)', () => {
  const target = { id: 1, name: 's1', parentGroup: null };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, true);
  assert.equal(d.prev, '(none)');
  assert.equal(d.next, 'Production');
});

// ---------- commit ----------

test('commit: calls setServerParentGroup; reports new parent', async () => {
  let captured = null;
  const client = {
    async setServerParentGroup(serverId, url) {
      captured = { serverId, url };
      return { status: 200, from: GROUP_URL_2, to: url, noop: false };
    }
  };
  const out = await a.commit({ id: 42, name: 's42' }, RULE, { client });
  assert.equal(out.noop, false);
  assert.equal(out.parent.from, GROUP_URL_2);
  assert.equal(out.parent.to, GROUP_URL);
  assert.equal(out.parent.name, 'Production');
  assert.deepEqual(captured, { serverId: 42, url: GROUP_URL });
});

test('commit: already-in-group -> noop, no error', async () => {
  const client = {
    async setServerParentGroup() {
      return { status: 200, from: GROUP_URL, to: GROUP_URL, noop: true };
    }
  };
  const out = await a.commit({ id: 42, name: 's42' }, RULE, { client });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'already-in-group');
});

test('commit: 404 from client surfaces friendly error', async () => {
  const client = {
    async setServerParentGroup() {
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
