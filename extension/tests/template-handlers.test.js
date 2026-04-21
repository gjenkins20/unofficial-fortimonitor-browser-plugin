import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planBatch,
  executeBatch,
  createTemplateHandlers,
  isRetryable
} from '../src/background/template-handlers.js';
import { PanoptaError } from '../src/lib/panopta-client.js';

const TEMPLATE_URL = 'https://api2.panopta.com/v2/server_template/40430873';
const TEMPLATE_ID = 40430873;

function fakeClient({ mappingsByServer = {}, attachImpl, detachImpl } = {}) {
  return {
    async listServerTemplateMappings(serverId) {
      return mappingsByServer[serverId] ?? [];
    },
    async attachTemplate(serverId, args) {
      if (attachImpl) return attachImpl(serverId, args);
      return { status: 201, resourceId: `m-${serverId}`, location: null };
    },
    async detachTemplate(serverId, templateId, opts) {
      if (detachImpl) return detachImpl(serverId, templateId, opts);
      return { status: 204 };
    },
    async listTemplates() {
      return [];
    },
    async lookupServersByName() {
      return [];
    }
  };
}

// ----- isRetryable --------------------

test('isRetryable: auth errors never retry', () => {
  const err = new PanoptaError('bad key', { status: 401, phase: 'auth' });
  assert.equal(isRetryable(err), false);
});

test('isRetryable: 5xx retries', () => {
  const err = new PanoptaError('server', { status: 503, phase: 'write' });
  assert.equal(isRetryable(err), true);
});

test('isRetryable: 400 does not retry', () => {
  const err = new PanoptaError('bad req', { status: 400, phase: 'write' });
  assert.equal(isRetryable(err), false);
});

test('isRetryable: AbortError does not retry', () => {
  const err = new Error('aborted'); err.name = 'AbortError';
  assert.equal(isRetryable(err), false);
});

// ----- planBatch - attach mode --------------------

test('planBatch (attach): not attached → plan=attach, attached → plan=skip', async () => {
  const targets = [
    { input: 'a', status: 'resolved', serverId: 1, displayName: 'a' },
    { input: 'b', status: 'resolved', serverId: 2, displayName: 'b' }
  ];
  const client = fakeClient({
    mappingsByServer: {
      1: [], // not attached
      2: [{ continuous: true, templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID }]
    }
  });
  const rows = await planBatch({
    targets, operation: 'attach', templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID, client, concurrency: 2
  });
  assert.equal(rows[0].plan, 'attach');
  assert.equal(rows[0].attached, null);
  assert.equal(rows[1].plan, 'skip');
  assert.equal(rows[1].attached.continuous, true);
});

test('planBatch (attach): matches by URL, not by id alone', async () => {
  const otherUrl = 'https://api2.panopta.com/v2/server_template/99';
  const targets = [{ input: 'a', status: 'resolved', serverId: 1, displayName: 'a' }];
  const client = fakeClient({
    mappingsByServer: {
      1: [{ continuous: true, templateUrl: otherUrl, templateId: 99 }]
    }
  });
  const rows = await planBatch({
    targets, operation: 'attach', templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID, client
  });
  assert.equal(rows[0].plan, 'attach'); // other template attached, not this one
});

test('planBatch (attach): preflight errors become plan=error', async () => {
  const targets = [{ input: 'a', status: 'resolved', serverId: 1, displayName: 'a' }];
  const client = {
    listServerTemplateMappings: async () => {
      throw new PanoptaError('boom', { status: 500, phase: 'read' });
    }
  };
  const rows = await planBatch({
    targets, operation: 'attach', templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID, client
  });
  assert.equal(rows[0].plan, 'error');
  assert.equal(rows[0].errorStatus, 500);
});

test('planBatch: unresolved targets pass through as plan=error', async () => {
  const targets = [{ input: 'bad', status: 'error', error: 'Name not found' }];
  const client = fakeClient();
  const rows = await planBatch({
    targets, operation: 'attach', templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID, client
  });
  assert.equal(rows[0].plan, 'error');
  assert.equal(rows[0].error, 'Name not found');
});

// ----- planBatch - detach mode --------------------

test('planBatch (detach, dissociate): attached → plan=detach, not attached → plan=skip', async () => {
  const targets = [
    { input: 'a', status: 'resolved', serverId: 1, displayName: 'a' },
    { input: 'b', status: 'resolved', serverId: 2, displayName: 'b' }
  ];
  const client = fakeClient({
    mappingsByServer: {
      1: [{ continuous: true, templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID }],
      2: []
    }
  });
  const rows = await planBatch({
    targets, operation: 'detach', templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID, strategy: 'dissociate', client
  });
  assert.equal(rows[0].plan, 'detach');
  assert.equal(rows[1].plan, 'skip');
});

test('planBatch (detach, delete): attached → plan=destroy', async () => {
  const targets = [{ input: 'a', status: 'resolved', serverId: 1, displayName: 'a' }];
  const client = fakeClient({
    mappingsByServer: {
      1: [{ continuous: true, templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID }]
    }
  });
  const rows = await planBatch({
    targets, operation: 'detach', templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID, strategy: 'delete', client
  });
  assert.equal(rows[0].plan, 'destroy');
});

test('planBatch: operation must be attach or detach', async () => {
  const client = fakeClient();
  await assert.rejects(
    () => planBatch({ targets: [], operation: 'nope', templateUrl: TEMPLATE_URL, client }),
    TypeError
  );
});

test('planBatch: templateId required for detach', async () => {
  const client = fakeClient();
  await assert.rejects(
    () => planBatch({ targets: [], operation: 'detach', templateUrl: TEMPLATE_URL, client }),
    TypeError
  );
});

// ----- executeBatch --------------------

test('executeBatch: attach rows call attachTemplate with continuous flag', async () => {
  const calls = [];
  const client = fakeClient({
    attachImpl: async (serverId, args) => {
      calls.push({ serverId, args });
      return { status: 201, resourceId: `m-${serverId}` };
    }
  });
  const plan = [
    { input: 'a', serverId: 1, plan: 'attach', status: 'resolved' }
  ];
  const res = await executeBatch({
    plan, templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID,
    continuous: false, client, concurrency: 1, maxAttempts: 1, sleep: async () => {}
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { templateUrl: TEMPLATE_URL, continuous: false });
  assert.equal(res[0].status, 'succeeded');
  assert.equal(res[0].mappingId, 'm-1');
});

test('executeBatch: detach rows call detachTemplate with strategy=dissociate', async () => {
  const calls = [];
  const client = fakeClient({
    detachImpl: async (serverId, templateId, opts) => {
      calls.push({ serverId, templateId, opts });
      return { status: 204 };
    }
  });
  const plan = [{ input: 'a', serverId: 1, plan: 'detach', status: 'resolved' }];
  await executeBatch({
    plan, templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID,
    strategy: 'delete', // even if strategy says delete, plan='detach' rows use dissociate
    client, concurrency: 1, maxAttempts: 1, sleep: async () => {}
  });
  assert.deepEqual(calls[0].opts, { strategy: 'dissociate' });
});

test('executeBatch: destroy rows call detachTemplate with strategy=delete', async () => {
  const calls = [];
  const client = fakeClient({
    detachImpl: async (serverId, templateId, opts) => {
      calls.push({ serverId, templateId, opts });
      return { status: 204 };
    }
  });
  const plan = [{ input: 'a', serverId: 1, plan: 'destroy', status: 'resolved' }];
  await executeBatch({
    plan, templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID,
    strategy: 'delete', client, concurrency: 1, maxAttempts: 1, sleep: async () => {}
  });
  assert.deepEqual(calls[0].opts, { strategy: 'delete' });
});

test('executeBatch: skip rows become status=skipped without network call', async () => {
  let called = false;
  const client = fakeClient({
    attachImpl: async () => { called = true; return { status: 201 }; }
  });
  const plan = [{ input: 'a', serverId: 1, plan: 'skip', status: 'resolved' }];
  const res = await executeBatch({
    plan, templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID,
    client, concurrency: 1, maxAttempts: 1, sleep: async () => {}
  });
  assert.equal(res[0].status, 'skipped');
  assert.equal(called, false);
});

test('executeBatch: error rows become status=error without network call', async () => {
  const client = fakeClient();
  const plan = [{ input: 'bad', plan: 'error', status: 'error', error: 'Name not found' }];
  const res = await executeBatch({
    plan, templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID,
    client, concurrency: 1, maxAttempts: 1, sleep: async () => {}
  });
  assert.equal(res[0].status, 'error');
});

test('executeBatch: write failures surface as status=failed with error text', async () => {
  const client = fakeClient({
    attachImpl: async () => { throw new PanoptaError('conflict', { status: 400, phase: 'write' }); }
  });
  const plan = [{ input: 'a', serverId: 1, plan: 'attach', status: 'resolved' }];
  const res = await executeBatch({
    plan, templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID,
    client, concurrency: 1, maxAttempts: 1, sleep: async () => {}
  });
  assert.equal(res[0].status, 'failed');
  assert.equal(res[0].errorStatus, 400);
  assert.equal(res[0].error, 'conflict');
});

test('executeBatch: emits onEntryStart/onEntryDone per row', async () => {
  const starts = [];
  const dones = [];
  const client = fakeClient();
  const plan = [
    { input: 'a', serverId: 1, plan: 'attach', status: 'resolved' },
    { input: 'b', plan: 'skip', status: 'resolved' }
  ];
  await executeBatch({
    plan, templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID,
    client, concurrency: 1, maxAttempts: 1, sleep: async () => {},
    onEntryStart: (i, row) => starts.push(row.input),
    onEntryDone: (i, row) => dones.push({ input: row.input, status: row.status })
  });
  assert.deepEqual(starts.sort(), ['a', 'b']);
  assert.equal(dones.length, 2);
});

test('executeBatch: templateUrl required', async () => {
  const client = fakeClient();
  await assert.rejects(
    () => executeBatch({ plan: [], client }),
    TypeError
  );
});

// ----- createTemplateHandlers (factory + currentRun guard) --------------

test('createTemplateHandlers: tmpl:abort returns aborted=false when no run', async () => {
  const h = createTemplateHandlers({ getClient: async () => fakeClient() });
  const out = await h['tmpl:abort']();
  assert.deepEqual(out, { aborted: false, reason: 'no active run' });
});

test('createTemplateHandlers: concurrent execute-batch is rejected', async () => {
  // Hold up the first run with a detach that never resolves, then fire
  // a second - must reject with "already running".
  let release;
  const slow = new Promise((r) => { release = r; });
  const client = fakeClient({
    attachImpl: async () => { await slow; return { status: 201, resourceId: 'm' }; }
  });
  const h = createTemplateHandlers({ getClient: async () => client });
  const first = h['tmpl:execute-batch']({
    plan: [{ input: 'a', serverId: 1, plan: 'attach', status: 'resolved' }],
    templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID
  });
  // Wait a tick so the guard flips
  await new Promise((r) => setTimeout(r, 0));
  await assert.rejects(
    () => h['tmpl:execute-batch']({ plan: [], templateUrl: TEMPLATE_URL, templateId: TEMPLATE_ID }),
    /already running/
  );
  release();
  await first;
});

test('createTemplateHandlers: tmpl:list-templates delegates to client', async () => {
  const client = {
    async listTemplates() {
      return [{ id: 1, name: 'T', resourceUrl: 'u', templateType: 'x', serverGroupUrl: 'g', appliedServerUrls: [] }];
    }
  };
  const h = createTemplateHandlers({ getClient: async () => client });
  const out = await h['tmpl:list-templates']();
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'T');
});
