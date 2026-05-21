import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../src/lib/bulk-actions/auto-set-attribute-by-name.js';

// =====================================================================
// FMN-226: Auto-set instance attributes by name regex descriptor
// =====================================================================

const TYPE_URL = 'https://api2.panopta.com/v2/server_attribute_type/501/';
const RULE = { regex: '^FGT-(\\d{3})-', valueTemplate: '$1', attributeTypeUrl: TYPE_URL, attributeTypeName: 'sitecode' };

// ---------- validate ----------

test('validate: requires regex + valueTemplate + attributeTypeUrl', () => {
  assert.equal(a.validate({}).ok, false);
  assert.equal(a.validate({ regex: 'x' }).ok, false);
  assert.equal(a.validate({ regex: 'x', valueTemplate: 'y' }).ok, false);
  assert.equal(a.validate({ regex: 'x', valueTemplate: 'y', attributeTypeUrl: TYPE_URL }).ok, true);
});

test('validate: invalid regex rejected', () => {
  const r = a.validate({ regex: '[oops', valueTemplate: '$1', attributeTypeUrl: TYPE_URL });
  assert.equal(r.ok, false);
  assert.match(r.error, /Invalid regex/);
});

test('validate: oversized template rejected', () => {
  const r = a.validate({ regex: '.', valueTemplate: 'x'.repeat(201), attributeTypeUrl: TYPE_URL });
  assert.equal(r.ok, false);
});

// ---------- applyTemplate ----------

test('applyTemplate: capture group substitution', () => {
  const m = /^FGT-(\d{3})-(\w+)/.exec('FGT-684-edge');
  assert.equal(a.applyTemplate('$1', m), '684');
  assert.equal(a.applyTemplate('$1-$2', m), '684-edge');
  assert.equal(a.applyTemplate('$&', m), 'FGT-684-edge');
  assert.equal(a.applyTemplate('$$', m), '$');
});

// ---------- describe ----------

test('describe: no existing attribute -> will create', () => {
  const target = { id: 1, name: 'FGT-684-edge-01', attributes: [] };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, true);
  assert.equal(d.prev, '(none)');
  assert.match(d.next, /\+ sitecode = 684/);
});

test('describe: existing attribute with same value -> skip (idempotent)', () => {
  const target = { id: 1, name: 'FGT-684-edge-01', attributes: [{ typeUrl: TYPE_URL, name: 'sitecode', value: '684' }] };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /already set to "684"/);
});

test('describe: existing attribute with different value -> conflict', () => {
  const target = { id: 1, name: 'FGT-684-edge-01', attributes: [{ typeUrl: TYPE_URL, name: 'sitecode', value: '999' }] };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.equal(d.conflict, true);
  assert.match(d.note, /already has "sitecode" = "999"/);
});

test('describe: no regex match -> skip', () => {
  const target = { id: 1, name: 'unrelated', attributes: [] };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /did not match/);
});

test('describe: attributes=null -> placeholder branch (unenriched)', () => {
  const target = { id: 1, name: 'FGT-684-edge-01' };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, true);
  assert.equal(d.prev, '(attributes unknown)');
});

test('describe: empty substitution -> skip', () => {
  const target = { id: 1, name: 'FGT-684-edge-01', attributes: [] };
  const d = a.describe(target, { regex: '^FGT-(\\d{3})-', valueTemplate: '$5', attributeTypeUrl: TYPE_URL, attributeTypeName: 'sitecode' });
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /empty value/);
});

// ---------- commit ----------

test('commit: no existing attribute -> POST createServerAttribute', async () => {
  let created = null;
  const client = {
    async listServerAttributes() { return []; },
    async createServerAttribute(serverId, args) {
      created = { serverId, args };
      return { status: 201, location: 'https://api2/v2/server_attribute/99/', resourceId: 99 };
    }
  };
  const out = await a.commit({ id: 42, name: 'FGT-684-edge-01' }, RULE, { client });
  assert.equal(out.noop, false);
  assert.equal(out.attribute.value, '684');
  assert.equal(created.args.value, '684');
  assert.equal(created.args.typeUrl, TYPE_URL);
});

test('commit: already-set with same value -> noop (no POST)', async () => {
  let postCalled = false;
  const client = {
    async listServerAttributes() { return [{ typeUrl: TYPE_URL, value: '684' }]; },
    async createServerAttribute() { postCalled = true; return { status: 0 }; }
  };
  const out = await a.commit({ id: 42, name: 'FGT-684-edge-01' }, RULE, { client });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'already-set');
  assert.equal(postCalled, false);
});

test('commit: conflict with existing different value -> noop, no POST, conflict reason', async () => {
  let postCalled = false;
  const client = {
    async listServerAttributes() { return [{ typeUrl: TYPE_URL, value: '999' }]; },
    async createServerAttribute() { postCalled = true; return { status: 0 }; }
  };
  const out = await a.commit({ id: 42, name: 'FGT-684-edge-01' }, RULE, { client });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'conflict-existing-value');
  assert.equal(out.currentValue, '999');
  assert.equal(postCalled, false);
});

test('commit: no regex match -> noop, no API calls', async () => {
  const client = {
    async listServerAttributes() { throw new Error('should not call'); },
    async createServerAttribute() { throw new Error('should not call'); }
  };
  const out = await a.commit({ id: 42, name: 'unrelated' }, RULE, { client });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'no-regex-match');
});

test('commit: empty substitution -> noop, no API calls', async () => {
  const client = {
    async listServerAttributes() { throw new Error('should not call'); }
  };
  const out = await a.commit({ id: 42, name: 'FGT-684-edge-01' }, { regex: '^FGT-(\\d{3})-', valueTemplate: '$5', attributeTypeUrl: TYPE_URL, attributeTypeName: 'sitecode' }, { client });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'empty-value-after-substitution');
});

test('commit: 404 from listServerAttributes surfaces friendly error', async () => {
  const client = {
    async listServerAttributes() {
      const err = new Error('Not found');
      err.status = 404;
      throw err;
    }
  };
  await assert.rejects(
    () => a.commit({ id: 42, name: 'FGT-684-edge-01' }, RULE, { client }),
    /Instance #42 not found on this tenant/
  );
});

test('commit: missing client throws', async () => {
  await assert.rejects(() => a.commit({ id: 1, name: 'x' }, RULE, {}), /PanoptaClient required/);
});
