// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155 unit tests: bulk-composer:commit handler with a stub client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBulkComposerHandlers } from '../../extension/src/background/bulk-composer-handlers.js';

function makeStubClient(overrides = {}) {
  return {
    addServerTag: async (id, tags) => ({
      status: 200,
      tagsBefore: [],
      tagsAfter: tags,
      addedTags: tags,
      removedTags: []
    }),
    removeServerTag: async (id, tags) => ({
      status: 200,
      tagsBefore: tags,
      tagsAfter: [],
      addedTags: [],
      removedTags: tags
    }),
    listTemplates: async () => ([
      { id: 1, name: 'Stock', resourceUrl: 'https://api2.panopta.com/v2/server_template/1', templateType: null }
    ]),
    listServerTemplateMappings: async () => [],
    attachTemplate: async () => ({ status: 201, resourceId: 9 }),
    ...overrides
  };
}

test('bulk-composer:commit add-tag: succeeds across N targets', async () => {
  const client = makeStubClient();
  const handlers = createBulkComposerHandlers({ getClient: () => client });
  const emitted = [];
  const handlersWithEmit = createBulkComposerHandlers({
    events: { emit: (e, p) => emitted.push({ e, p }) },
    getClient: () => client
  });
  const result = await handlersWithEmit['bulk-composer:commit']({
    actionId: 'add-tag',
    params: { tag: 'needs-review' },
    targets: [
      { id: 1, name: 's1', tags: [] },
      { id: 2, name: 's2', tags: [] }
    ],
    concurrency: 2
  });
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].status, 'succeeded');
  // Per-row events were emitted.
  assert.ok(emitted.some((m) => m.e === 'bulk-composer:row-start'));
  assert.ok(emitted.some((m) => m.e === 'bulk-composer:row-done'));
});

test('bulk-composer:commit: unknown actionId rejected', async () => {
  const handlers = createBulkComposerHandlers({ getClient: () => makeStubClient() });
  await assert.rejects(
    () => handlers['bulk-composer:commit']({ actionId: 'no-such', params: {}, targets: [{ id: 1 }] }),
    /Unknown action/
  );
});

test('bulk-composer:commit: empty targets rejected', async () => {
  const handlers = createBulkComposerHandlers({ getClient: () => makeStubClient() });
  await assert.rejects(
    () => handlers['bulk-composer:commit']({ actionId: 'add-tag', params: { tag: 'x' }, targets: [] }),
    /No targets/
  );
});

test('bulk-composer:commit: invalid params surfaced before commit', async () => {
  const handlers = createBulkComposerHandlers({ getClient: () => makeStubClient() });
  await assert.rejects(
    () => handlers['bulk-composer:commit']({ actionId: 'add-tag', params: { tag: '' }, targets: [{ id: 1 }] }),
    /Invalid action params/
  );
});

test('bulk-composer:commit: per-row failure isolates and surfaces in summary', async () => {
  let call = 0;
  const client = makeStubClient({
    addServerTag: async () => {
      call++;
      if (call === 2) throw new Error('boom on row 2');
      return { status: 200, tagsBefore: [], tagsAfter: ['x'], addedTags: ['x'], removedTags: [] };
    }
  });
  const handlers = createBulkComposerHandlers({ getClient: () => client });
  const result = await handlers['bulk-composer:commit']({
    actionId: 'add-tag',
    params: { tag: 'x' },
    targets: [
      { id: 1, name: 's1' },
      { id: 2, name: 's2' },
      { id: 3, name: 's3' }
    ],
    concurrency: 1
  });
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.rows.find((r) => r.id === 2).status, 'failed');
  assert.match(result.rows.find((r) => r.id === 2).error, /boom/);
});

test('bulk-composer:commit: apply-template short-circuits on already-attached', async () => {
  let attachCalls = 0;
  const client = makeStubClient({
    listServerTemplateMappings: async (id) =>
      id === 2 ? [{ templateUrl: 'https://api2.panopta.com/v2/server_template/1', templateId: 1 }] : [],
    attachTemplate: async () => { attachCalls++; return { status: 201, resourceId: 99 }; }
  });
  const handlers = createBulkComposerHandlers({ getClient: () => client });
  const result = await handlers['bulk-composer:commit']({
    actionId: 'apply-template',
    params: {
      templateUrl: 'https://api2.panopta.com/v2/server_template/1',
      templateId: 1,
      templateName: 'Stock',
      continuous: true
    },
    targets: [{ id: 1 }, { id: 2 }, { id: 3 }],
    concurrency: 1
  });
  assert.equal(attachCalls, 2); // skipped id=2
  assert.equal(result.succeeded, 3);
  assert.equal(result.noops, 1);
  assert.equal(result.rows.find((r) => r.id === 2).noop, true);
});

test('bulk-composer:list-templates passes through client.listTemplates', async () => {
  const handlers = createBulkComposerHandlers({ getClient: () => makeStubClient() });
  const r = await handlers['bulk-composer:list-templates']();
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'Stock');
});

test('bulk-composer over-cap rejected', async () => {
  const handlers = createBulkComposerHandlers({ getClient: () => makeStubClient() });
  const targets = Array.from({ length: 501 }, (_, i) => ({ id: i + 1 }));
  await assert.rejects(
    () => handlers['bulk-composer:commit']({ actionId: 'add-tag', params: { tag: 'x' }, targets }),
    /Too many targets/
  );
});
