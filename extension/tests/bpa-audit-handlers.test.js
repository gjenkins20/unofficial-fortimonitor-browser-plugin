import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBpaAuditHandlers,
  runBpaAudit,
  BPA_RUN_KEY
} from '../src/background/bpa-audit-handlers.js';
import { PanoptaClient, PanoptaError } from '../src/lib/panopta-client.js';
import {
  createFetchMock,
  createStorageMock,
  jsonResponse,
  errorResponse
} from './fixtures/chrome-mocks.js';

function listResponse(envelopeKey, items, total = items.length) {
  return jsonResponse({ [envelopeKey]: items, meta: { total_count: total } });
}

function buildBaselineFetch() {
  // Minimal mock: every list endpoint returns []; group/template details
  // return empty objects. Sufficient for runBpaAudit to complete cleanly.
  return createFetchMock(async (url) => {
    if (/\/server_attribute_type/.test(url)) return listResponse('server_attribute_type_list', []);
    if (/\?limit=/.test(url)) return jsonResponse({});
    return jsonResponse({});
  });
}

test('createBpaAuditHandlers: bpa:abort returns aborted=false when no run is active', async () => {
  const handlers = createBpaAuditHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: buildBaselineFetch() }),
    storage: createStorageMock()
  });
  const r = await handlers['bpa:abort']({});
  assert.equal(r.aborted, false);
  assert.match(r.reason, /no active run/);
});

test('createBpaAuditHandlers: rejects concurrent bpa:run-audit calls', async () => {
  // Block the first run by making the fetch hang until we resolve it.
  let resolveFirst;
  const slowFetch = createFetchMock(async (_url) => {
    await new Promise((res) => { resolveFirst = res; });
    return jsonResponse({});
  });
  const handlers = createBpaAuditHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: slowFetch }),
    storage: createStorageMock()
  });
  const first = handlers['bpa:run-audit']({});
  // Wait one tick so the first run has registered itself.
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(
    () => handlers['bpa:run-audit']({}),
    /already in progress/
  );
  // Tear down
  await handlers['bpa:abort']({});
  if (resolveFirst) resolveFirst();
  await first.catch(() => {});
});

test('createBpaAuditHandlers: bpa:abort while running surfaces an AbortError to the caller', async () => {
  let resolveFirst;
  const slowFetch = createFetchMock(async (_url) => {
    await new Promise((res) => { resolveFirst = res; });
    return jsonResponse({});
  });
  const handlers = createBpaAuditHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: slowFetch }),
    storage: createStorageMock()
  });
  const runPromise = handlers['bpa:run-audit']({});
  await new Promise((r) => setTimeout(r, 10));
  const abortResult = await handlers['bpa:abort']({});
  assert.equal(abortResult.aborted, true);
  if (resolveFirst) resolveFirst();
  // The run rejects with AbortError reshaped to "BPA audit cancelled".
  await assert.rejects(runPromise, (err) => err.name === 'AbortError' && /cancelled/i.test(err.message));
});

test('createBpaAuditHandlers: bpa:run-audit stages full result in storage and returns small handle', async () => {
  const storage = createStorageMock();
  const handlers = createBpaAuditHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: buildBaselineFetch() }),
    storage
  });
  const handle = await handlers['bpa:run-audit']({});
  assert.equal(handle.runKey, BPA_RUN_KEY);
  assert.ok(handle.summary);
  assert.equal(typeof handle.summary.started_at, 'string');
  assert.equal(typeof handle.summary.counts, 'object');
  // Full result should be in storage, not in the handle.
  assert.equal(handle.inventory, undefined);
  assert.equal(handle.analysis, undefined);
  const stored = storage.__raw()[BPA_RUN_KEY];
  assert.ok(stored?.inventory, 'full inventory must be staged in storage');
  assert.ok(stored?.analysis, 'full analysis must be staged in storage');
});

test('createBpaAuditHandlers: bpa:get-run-result returns staged result and clears the slot', async () => {
  const storage = createStorageMock();
  const handlers = createBpaAuditHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: buildBaselineFetch() }),
    storage
  });
  await handlers['bpa:run-audit']({});
  const result = await handlers['bpa:get-run-result']({});
  assert.ok(result.inventory);
  assert.ok(result.analysis);
  // Slot should be cleared after consumption.
  assert.equal(storage.__raw()[BPA_RUN_KEY], undefined);
  // Second call must reject - nothing left to read.
  await assert.rejects(
    () => handlers['bpa:get-run-result']({}),
    /No staged BPA run result/
  );
});

test('runBpaAudit: returns inventory + analysis on a tiny baseline fetch', async () => {
  const fetch = buildBaselineFetch();
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const events = [];
  const r = await runBpaAudit({
    client,
    onProgress: (e) => events.push(e)
  });
  assert.ok(r.started_at);
  assert.ok(r.finished_at);
  assert.equal(r.deep, false);
  assert.ok(r.inventory);
  assert.ok(r.analysis);
  assert.equal(typeof r.analysis.incidents, 'object');
  assert.equal(typeof r.analysis.users, 'object');
  // Must have emitted lifecycle events:
  const phases = events.map((e) => e.phase);
  assert.ok(phases.includes('collect:start'));
  assert.ok(phases.includes('analyze:start'));
  assert.ok(phases.includes('analyze:done'));
});

test('runBpaAudit: 401 from any endpoint propagates as PanoptaError(auth)', async () => {
  const fetch = createFetchMock(async () => errorResponse(401));
  const client = new PanoptaClient({ apiKey: 'bad', fetch });
  await assert.rejects(
    () => runBpaAudit({ client }),
    (err) => err instanceof PanoptaError && err.phase === 'auth'
  );
});

test('runBpaAudit: includeFrontend walks EditUser pages and enriches inventory (FMN-135)', async () => {
  // Baseline v2 fetch returns one user; the frontend fetch returns
  // a tiny EditUser HTML stub for that user.
  const v2Fetch = createFetchMock(async (url) => {
    if (/\/v2\/user\b/.test(url)) {
      return listResponse('user_list', [{ id: 42, name: 'Alice', email: 'a@x' }]);
    }
    if (/\/server_attribute_type/.test(url)) return listResponse('server_attribute_type_list', []);
    return jsonResponse({});
  });
  const frontendFetch = createFetchMock(async (url) => {
    assert.match(url, /\/users\/users\/EditUser\?contact_id=42/);
    const html = `
      <p class="pa-txt_secondary pa-mb-6 pa-txt_xs">Last Login</p>
      <p>2026-04-30 12:34:56 UTC</p>
      <p class="pa-txt_secondary pa-mb-6 pa-txt_xs">Created On</p>
      <p>Jan 1, 2024</p>
    `;
    return {
      ok: true, status: 200,
      headers: new Map([['content-type', 'text/html']]),
      async text() { return html; },
      async json() { throw new Error('not json'); }
    };
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch: v2Fetch });
  const events = [];
  const r = await runBpaAudit({
    client,
    includeFrontend: true,
    frontendFetch,
    onProgress: (e) => events.push(e)
  });
  assert.equal(r.include_frontend, true);
  assert.deepEqual(r.inventory.frontend_user_data, {
    '42': { last_login: '2026-04-30 12:34:56 UTC', created_on: 'Jan 1, 2024' }
  });
  // Analyzer picked up the merged data.
  const alice = r.analysis.users.details.find((d) => d.id === 42);
  assert.ok(alice, 'analyzer detail for user 42 missing');
  assert.equal(alice.last_login, '2026-04-30 12:34:56 UTC');
  assert.equal(alice.last_login_manual, false);
  assert.equal(alice.created_on, 'Jan 1, 2024');
  // Frontend lifecycle events fired.
  const phases = events.map((e) => e.phase);
  assert.ok(phases.includes('frontend:start'));
  assert.ok(phases.includes('frontend:done'));
});

test('runBpaAudit: includeFrontend records auth failure on inventory.errors and continues to analyzers', async () => {
  const v2Fetch = createFetchMock(async (url) => {
    if (/\/v2\/user\b/.test(url)) {
      return listResponse('user_list', [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);
    }
    if (/\/server_attribute_type/.test(url)) return listResponse('server_attribute_type_list', []);
    return jsonResponse({});
  });
  const frontendFetch = createFetchMock(async () => ({
    ok: true, status: 200,
    headers: new Map([['content-type', 'text/html']]),
    async text() { return '<form id="login-form"><input type="password"></form>'; },
    async json() { throw new Error('not json'); }
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch: v2Fetch });
  const r = await runBpaAudit({
    client,
    includeFrontend: true,
    frontendFetch
  });
  // Auth failure on first user is fatal for the frontend phase but the
  // overall run still produces analysis from the v2-only inventory.
  assert.ok(r.inventory.errors.some((e) => /frontend.*FortiMonitor session not detected/i.test(e)));
  assert.ok(r.analysis.users.details.length === 2);
  assert.equal(r.inventory.frontend_user_data, undefined);
});

test('runBpaAudit: AbortSignal aborts mid-collection', async () => {
  const ctl = new AbortController();
  let calls = 0;
  const fetch = createFetchMock(async () => {
    calls += 1;
    if (calls === 1) ctl.abort();
    return jsonResponse({});
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(
    () => runBpaAudit({ client, signal: ctl.signal }),
    (err) => err.name === 'AbortError'
  );
});
