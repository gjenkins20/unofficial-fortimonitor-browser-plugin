import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../src/lib/bulk-actions/auto-tag-by-name.js';

// =====================================================================
// FMN-225: Auto-tag by name pattern descriptor
// =====================================================================

// ---------- validate ----------

test('validate: regex + tagTemplate required', () => {
  assert.equal(a.validate({}).ok, false);
  assert.equal(a.validate({ regex: '^FGT-(\\d{3})-' }).ok, false);
  assert.equal(a.validate({ tagTemplate: 'sitecode=$1' }).ok, false);
  const ok = a.validate({ regex: '^FGT-(\\d{3})-', tagTemplate: 'sitecode=$1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.regex, '^FGT-(\\d{3})-');
  assert.ok(ok.value.regexObject instanceof RegExp);
});

test('validate: invalid regex rejected with friendly message', () => {
  const r = a.validate({ regex: '[unclosed', tagTemplate: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Invalid regex/);
});

test('validate: oversized tag template rejected', () => {
  const r = a.validate({ regex: '.', tagTemplate: 'x'.repeat(201) });
  assert.equal(r.ok, false);
  assert.match(r.error, /unusually long/);
});

// ---------- applyTemplate ----------

test('applyTemplate: $1, $2 substitute capture groups', () => {
  const m = /^FGT-(\d{3})-(.+)$/.exec('FGT-684-edge-01');
  assert.equal(a.applyTemplate('sitecode=$1', m), 'sitecode=684');
  assert.equal(a.applyTemplate('$1/$2', m), '684/edge-01');
});

test('applyTemplate: $& substitutes the full match', () => {
  const m = /\d+/.exec('FGT-684-edge-01');
  assert.equal(a.applyTemplate('full:$&', m), 'full:684');
});

test('applyTemplate: $$ produces a literal $', () => {
  const m = /(.)/.exec('x');
  assert.equal(a.applyTemplate('$$$1', m), '$x');
});

test('applyTemplate: unmatched placeholders become empty string', () => {
  const m = /^(\d+)$/.exec('5');
  assert.equal(a.applyTemplate('$1-$2-$3', m), '5--');
});

test('applyTemplate: null match -> null', () => {
  assert.equal(a.applyTemplate('foo', null), null);
});

// ---------- describe ----------

const RULE = { regex: '^FGT-(\\d{3})-', tagTemplate: 'sitecode=$1' };

test('describe: matched name + tag not yet present -> will change', () => {
  const target = { id: 1, name: 'FGT-684-edge-01', tags: ['prod'] };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, true);
  assert.equal(d.prev, 'prod');
  assert.equal(d.next, 'prod, sitecode=684');
  assert.match(d.note, /Will add tag "sitecode=684"/);
});

test('describe: matched name + tag already present -> skip', () => {
  const target = { id: 1, name: 'FGT-684-edge-01', tags: ['prod', 'sitecode=684'] };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /already present/);
});

test('describe: name does not match regex -> skip', () => {
  const target = { id: 1, name: 'unrelated-host', tags: [] };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.equal(d.next, '(no match)');
  assert.match(d.note, /did not match/);
});

test('describe: tags=null (instance not found) -> skip with friendly copy', () => {
  const target = { id: 1, name: 'FGT-684-edge-01', tags: null };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /not found on this tenant/);
});

test('describe: empty substitution result -> skip', () => {
  // Template references $2 but regex only has 1 capture group
  const target = { id: 1, name: 'FGT-684-edge-01', tags: [] };
  const d = a.describe(target, { regex: '^FGT-(\\d{3})-', tagTemplate: '$2' });
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /empty tag/);
});

test('describe: tag template with $& uses the full match', () => {
  const target = { id: 1, name: 'edge-fgt-01', tags: [] };
  const d = a.describe(target, { regex: 'fgt-\\d+', tagTemplate: 'matched=$&' });
  assert.equal(d.willChange, true);
  assert.match(d.next, /matched=fgt-01/);
});

// ---------- commit ----------

test('commit: matched name -> calls addServerTag with the substituted tag', async () => {
  const calls = [];
  const client = {
    async addServerTag(serverId, tags) {
      calls.push({ serverId, tags });
      return { status: 200, addedTags: tags.slice(), tagsAfter: ['prod', ...tags], tagsBefore: ['prod'] };
    }
  };
  const out = await a.commit({ id: 42, name: 'FGT-684-edge-01', tags: ['prod'] }, RULE, { client });
  assert.equal(out.noop, false);
  assert.equal(out.added, true);
  assert.equal(out.tag, 'sitecode=684');
  assert.deepEqual(calls, [{ serverId: 42, tags: ['sitecode=684'] }]);
});

test('commit: no regex match -> noop, no API call', async () => {
  const client = { async addServerTag() { throw new Error('should not call'); } };
  const out = await a.commit({ id: 42, name: 'unrelated', tags: [] }, RULE, { client });
  assert.equal(out.noop, true);
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'no-regex-match');
});

test('commit: empty substitution -> noop, no API call', async () => {
  const client = { async addServerTag() { throw new Error('should not call'); } };
  const out = await a.commit({ id: 42, name: 'FGT-684-edge-01', tags: [] }, { regex: '^FGT-(\\d{3})-', tagTemplate: '$5' }, { client });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'empty-tag-after-substitution');
});

test('commit: tags=null (instance not found) -> noop, no API call', async () => {
  const client = { async addServerTag() { throw new Error('should not call'); } };
  const out = await a.commit({ id: 42, name: 'FGT-684-edge-01', tags: null }, RULE, { client });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'instance-not-found');
});

test('commit: tag already present -> addServerTag returns addedTags=[] -> noop', async () => {
  const client = {
    async addServerTag(serverId, tags) {
      return { status: 200, addedTags: [], tagsAfter: ['sitecode=684'], tagsBefore: ['sitecode=684'] };
    }
  };
  const out = await a.commit({ id: 42, name: 'FGT-684-edge-01', tags: ['sitecode=684'] }, RULE, { client });
  assert.equal(out.noop, true);
  assert.equal(out.added, false);
});

test('commit: 404 from client surfaces friendly error', async () => {
  const client = {
    async addServerTag() {
      const err = new Error('Not found');
      err.status = 404;
      throw err;
    }
  };
  await assert.rejects(
    () => a.commit({ id: 42, name: 'FGT-684-edge-01', tags: [] }, RULE, { client }),
    /Instance #42 not found on this tenant/
  );
});

test('commit: missing client throws', async () => {
  await assert.rejects(
    () => a.commit({ id: 42, name: 'FGT-684-edge-01' }, RULE, {}),
    /PanoptaClient required/
  );
});
