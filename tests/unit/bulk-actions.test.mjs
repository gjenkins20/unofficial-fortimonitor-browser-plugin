// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155 unit tests for the bulk-actions registry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as addTag from '../../extension/src/lib/bulk-actions/add-tag.js';
import * as removeTag from '../../extension/src/lib/bulk-actions/remove-tag.js';
import * as applyTemplate from '../../extension/src/lib/bulk-actions/apply-template.js';
import { ACTIONS, getAction, listActions } from '../../extension/src/lib/bulk-actions/index.js';

test('registry exposes the three v1 actions', () => {
  assert.equal(ACTIONS.length, 3);
  assert.deepEqual(listActions().map((a) => a.id).sort(), ['add-tag', 'apply-template', 'remove-tag']);
});

test('getAction returns the right module by id', () => {
  assert.equal(getAction('add-tag'), addTag);
  assert.equal(getAction('remove-tag'), removeTag);
  assert.equal(getAction('apply-template'), applyTemplate);
  assert.equal(getAction('unknown'), null);
});

// ---- add-tag ----

test('add-tag.validate: empty tag rejected', () => {
  const r = addTag.validate({ tag: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /required/i);
});

test('add-tag.validate: whitespace-only rejected', () => {
  const r = addTag.validate({ tag: '   ' });
  assert.equal(r.ok, false);
});

test('add-tag.validate: trims and returns value', () => {
  const r = addTag.validate({ tag: '  needs-review  ' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { tag: 'needs-review' });
});

test('add-tag.describe: new tag on instance with existing tags', () => {
  const d = addTag.describe({ id: 1, name: 's1', tags: ['prod'] }, { tag: 'needs-review' });
  assert.equal(d.willChange, true);
  assert.equal(d.prev, 'prod');
  assert.equal(d.next, 'prod, needs-review');
});

test('add-tag.describe: idempotent when tag already present', () => {
  const d = addTag.describe({ id: 1, name: 's1', tags: ['needs-review', 'prod'] }, { tag: 'needs-review' });
  assert.equal(d.willChange, false);
  assert.match(d.note, /no-op/i);
});

test('add-tag.describe: unknown tag list (cache miss) still shapes a preview', () => {
  const d = addTag.describe({ id: 1, name: 's1' }, { tag: 'x' });
  assert.equal(d.willChange, true);
  assert.equal(d.prev, '(tags unknown)');
  assert.equal(d.next, '+ x');
});

test('add-tag.commit calls client.addServerTag and returns shape', async () => {
  let called = null;
  const client = {
    addServerTag: async (id, tags) => {
      called = { id, tags };
      return { status: 200, tagsBefore: ['prod'], tagsAfter: ['prod', 'needs-review'], addedTags: ['needs-review'], removedTags: [] };
    }
  };
  const r = await addTag.commit({ id: 42 }, { tag: 'needs-review' }, { client });
  assert.deepEqual(called, { id: 42, tags: ['needs-review'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.addedTags, ['needs-review']);
  assert.equal(r.noop, false);
});

test('add-tag.commit: empty addedTags surfaces noop=true', async () => {
  const client = {
    addServerTag: async () => ({ status: 200, tagsBefore: ['x'], tagsAfter: ['x'], addedTags: [], removedTags: [] })
  };
  const r = await addTag.commit({ id: 1 }, { tag: 'x' }, { client });
  assert.equal(r.noop, true);
});

// ---- remove-tag ----

test('remove-tag.describe: removes when present', () => {
  const d = removeTag.describe({ id: 1, name: 's1', tags: ['a', 'b'] }, { tag: 'a' });
  assert.equal(d.willChange, true);
  assert.equal(d.prev, 'a, b');
  assert.equal(d.next, 'b');
});

test('remove-tag.describe: no-op when missing', () => {
  const d = removeTag.describe({ id: 1, tags: ['a'] }, { tag: 'b' });
  assert.equal(d.willChange, false);
  assert.match(d.note, /not present/i);
});

test('remove-tag.describe: removing last tag yields "(none)"', () => {
  const d = removeTag.describe({ id: 1, tags: ['only-one'] }, { tag: 'only-one' });
  assert.equal(d.next, '(none)');
});

test('remove-tag.commit calls client.removeServerTag', async () => {
  let called = null;
  const client = {
    removeServerTag: async (id, tags) => {
      called = { id, tags };
      return { status: 200, tagsBefore: ['a', 'b'], tagsAfter: ['b'], addedTags: [], removedTags: ['a'] };
    }
  };
  const r = await removeTag.commit({ id: 7 }, { tag: 'a' }, { client });
  assert.deepEqual(called, { id: 7, tags: ['a'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.removedTags, ['a']);
});

// ---- apply-template ----

test('apply-template.validate: missing templateUrl rejected', () => {
  const r = applyTemplate.validate({});
  assert.equal(r.ok, false);
});

test('apply-template.validate: minimal params resolve with continuous=true default', () => {
  const r = applyTemplate.validate({ templateUrl: 'https://api2.panopta.com/v2/server_template/123' });
  assert.equal(r.ok, true);
  assert.equal(r.value.continuous, true);
});

test('apply-template.validate: continuous=false respected', () => {
  const r = applyTemplate.validate({ templateUrl: 'x', continuous: false });
  assert.equal(r.value.continuous, false);
});

test('apply-template.describe: new template surfaced', () => {
  const d = applyTemplate.describe(
    { id: 1, name: 's1', template_names: ['ServerStandard'] },
    { templateUrl: 'x', templateName: 'WindowsBaseline' }
  );
  assert.equal(d.willChange, true);
  assert.equal(d.prev, 'ServerStandard');
  assert.equal(d.next, 'ServerStandard, WindowsBaseline');
});

test('apply-template.describe: idempotent when name already in list', () => {
  const d = applyTemplate.describe(
    { id: 1, template_names: ['WindowsBaseline'] },
    { templateUrl: 'x', templateName: 'WindowsBaseline' }
  );
  assert.equal(d.willChange, false);
  assert.match(d.note, /already attached/i);
});

test('apply-template.commit: skips when listServerTemplateMappings already contains url', async () => {
  let attachCalled = false;
  const client = {
    listServerTemplateMappings: async () => [{ templateUrl: 'x', templateId: 9 }],
    attachTemplate: async () => { attachCalled = true; return {}; }
  };
  const r = await applyTemplate.commit({ id: 1 }, { templateUrl: 'x', templateId: 9 }, { client });
  assert.equal(attachCalled, false);
  assert.equal(r.noop, true);
  assert.equal(r.reason, 'already-attached');
});

test('apply-template.commit: attaches when not in mappings', async () => {
  let attachArgs = null;
  const client = {
    listServerTemplateMappings: async () => [],
    attachTemplate: async (id, opts) => { attachArgs = { id, ...opts }; return { status: 201, resourceId: 555 }; }
  };
  const r = await applyTemplate.commit(
    { id: 42 },
    { templateUrl: 'https://api2.panopta.com/v2/server_template/123', templateId: 123, continuous: true },
    { client }
  );
  assert.equal(r.noop, false);
  assert.equal(r.status, 201);
  assert.equal(r.mappingId, 555);
  assert.equal(attachArgs.id, 42);
  assert.equal(attachArgs.continuous, true);
});

test('apply-template.commit: matches by templateId when url differs', async () => {
  let attachCalled = false;
  const client = {
    listServerTemplateMappings: async () => [{ templateUrl: 'different-url', templateId: 123 }],
    attachTemplate: async () => { attachCalled = true; return {}; }
  };
  const r = await applyTemplate.commit(
    { id: 42 },
    { templateUrl: 'x', templateId: 123 },
    { client }
  );
  assert.equal(attachCalled, false);
  assert.equal(r.noop, true);
});
