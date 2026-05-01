import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBpaAuditHandlers, runBpaAudit } from '../src/background/bpa-audit-handlers.js';
import { PanoptaClient, PanoptaError } from '../src/lib/panopta-client.js';
import { createFetchMock, jsonResponse, errorResponse } from './fixtures/chrome-mocks.js';

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
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: buildBaselineFetch() })
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
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: slowFetch })
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
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: slowFetch })
  });
  const runPromise = handlers['bpa:run-audit']({});
  await new Promise((r) => setTimeout(r, 10));
  const abortResult = await handlers['bpa:abort']({});
  assert.equal(abortResult.aborted, true);
  if (resolveFirst) resolveFirst();
  // The run rejects with AbortError reshaped to "BPA audit cancelled".
  await assert.rejects(runPromise, (err) => err.name === 'AbortError' && /cancelled/i.test(err.message));
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
