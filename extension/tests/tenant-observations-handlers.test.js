import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTenantObservationsHandlers,
  runTenantObservations,
  OBSERVATIONS_RUN_KEY,
  OBSERVATIONS_RESULT_KEY
} from '../src/background/tenant-observations-handlers.js';
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

// FMN-256: the run is detached now, so run-audit returns before the crawl
// finishes. Poll get-run-status the way the page does until a terminal
// state, then return it. Bails after a generous attempt cap so a hung run
// fails the test instead of hanging it.
async function waitForRun(handlers, { attempts = 200, intervalMs = 5 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const s = await handlers['observations:get-run-status']({});
    if (s.status !== 'running' && s.status !== 'none') return s;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitForRun: run did not reach a terminal state');
}

// Default no-op keep-alive for handler tests so no real interval leaks
// into the Node test process.
const noKeepAlive = () => () => {};

function buildBaselineFetch() {
  // Minimal mock: every list endpoint returns []; group/template details
  // return empty objects. Sufficient for runTenantObservations to complete cleanly.
  return createFetchMock(async (url) => {
    if (/\/server_attribute_type/.test(url)) return listResponse('server_attribute_type_list', []);
    if (/\?limit=/.test(url)) return jsonResponse({});
    return jsonResponse({});
  });
}

test('createTenantObservationsHandlers: observations:abort returns aborted=false when no run is active', async () => {
  const handlers = createTenantObservationsHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: buildBaselineFetch() }),
    storage: createStorageMock()
  });
  const r = await handlers['observations:abort']({});
  assert.equal(r.aborted, false);
  assert.match(r.reason, /no active run/);
});

test('createTenantObservationsHandlers: rejects concurrent observations:run-audit calls', async () => {
  // Block the first run by making the fetch hang until we resolve it.
  let resolveFirst;
  const slowFetch = createFetchMock(async (_url) => {
    await new Promise((res) => { resolveFirst = res; });
    return jsonResponse({});
  });
  const handlers = createTenantObservationsHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: slowFetch }),
    storage: createStorageMock()
  });
  const first = handlers['observations:run-audit']({});
  // Wait one tick so the first run has registered itself.
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(
    () => handlers['observations:run-audit']({}),
    /already in progress/
  );
  // Tear down
  await handlers['observations:abort']({});
  if (resolveFirst) resolveFirst();
  await first.catch(() => {});
});

test('createTenantObservationsHandlers: observations:abort while running surfaces as a cancelled status (FMN-256)', async () => {
  let resolveFirst;
  const slowFetch = createFetchMock(async (_url) => {
    await new Promise((res) => { resolveFirst = res; });
    return jsonResponse({});
  });
  const handlers = createTenantObservationsHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: slowFetch }),
    storage: createStorageMock(),
    keepAlive: noKeepAlive
  });
  // run-audit returns immediately now; the crawl runs detached.
  const handle = await handlers['observations:run-audit']({});
  assert.equal(handle.status, 'started');
  await new Promise((r) => setTimeout(r, 10));
  const abortResult = await handlers['observations:abort']({});
  assert.equal(abortResult.aborted, true);
  if (resolveFirst) resolveFirst();
  // The detached run records a 'cancelled' terminal state.
  const terminal = await waitForRun(handlers);
  assert.equal(terminal.status, 'cancelled');
  assert.match(terminal.error, /cancelled/i);
  // get-run-result refuses to hand back a non-done run.
  await assert.rejects(
    () => handlers['observations:get-run-result']({}),
    /not done/
  );
});

test('createTenantObservationsHandlers: observations:run-audit returns a small handle immediately and stages the full result on completion (FMN-256)', async () => {
  const storage = createStorageMock();
  const handlers = createTenantObservationsHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: buildBaselineFetch() }),
    storage,
    keepAlive: noKeepAlive
  });
  const handle = await handlers['observations:run-audit']({});
  // Handle is small: keys + status, no payload.
  assert.equal(handle.runKey, OBSERVATIONS_RUN_KEY);
  assert.equal(handle.resultKey, OBSERVATIONS_RESULT_KEY);
  assert.equal(handle.status, 'started');
  assert.equal(typeof handle.started_at, 'string');
  assert.equal(handle.inventory, undefined);
  assert.equal(handle.analysis, undefined);
  assert.equal(handle.summary, undefined);
  // Once the detached run finishes, the small status key flips to 'done'
  // with a summary, and the big result lands under the SEPARATE result key.
  const terminal = await waitForRun(handlers);
  assert.equal(terminal.status, 'done');
  assert.ok(terminal.summary, 'terminal status carries a small summary');
  assert.equal(typeof terminal.summary.counts, 'object');
  // Status key never carries the multi-MB result.
  assert.equal(terminal.result, undefined, 'status key must not hold the result');
  const raw = storage.__raw();
  assert.equal(raw[OBSERVATIONS_RUN_KEY].status, 'done');
  assert.equal(raw[OBSERVATIONS_RUN_KEY].result, undefined, 'status key must not hold the result');
  assert.ok(raw[OBSERVATIONS_RESULT_KEY]?.inventory, 'full inventory must be staged under the result key');
  assert.ok(raw[OBSERVATIONS_RESULT_KEY]?.analysis, 'full analysis must be staged under the result key');
});

test('createTenantObservationsHandlers: observations:get-run-result returns staged result and clears the slot', async () => {
  const storage = createStorageMock();
  const handlers = createTenantObservationsHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: buildBaselineFetch() }),
    storage,
    keepAlive: noKeepAlive
  });
  await handlers['observations:run-audit']({});
  await waitForRun(handlers);
  const result = await handlers['observations:get-run-result']({});
  assert.ok(result.inventory);
  assert.ok(result.analysis);
  // Both keys should be cleared after consumption.
  assert.equal(storage.__raw()[OBSERVATIONS_RESULT_KEY], undefined);
  assert.equal(storage.__raw()[OBSERVATIONS_RUN_KEY], undefined);
  // Second call must reject - nothing left to read.
  await assert.rejects(
    () => handlers['observations:get-run-result']({}),
    /No staged Observations run result/
  );
});

test('createTenantObservationsHandlers: get-run-status reports none, running, then done (FMN-256)', async () => {
  const storage = createStorageMock();
  // Shared gate: every client request waits on it. It stays resolved once
  // opened, so opening it once lets the whole crawl drain (no re-park).
  let openGate;
  const gate = new Promise((r) => { openGate = r; });
  const gatedFetch = createFetchMock(async (url) => {
    if (/\/server_attribute_type/.test(url)) return listResponse('server_attribute_type_list', []);
    await gate;
    return jsonResponse({});
  });
  const handlers = createTenantObservationsHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: gatedFetch }),
    storage,
    keepAlive: noKeepAlive
  });
  // Before any run: none.
  assert.equal((await handlers['observations:get-run-status']({})).status, 'none');
  await handlers['observations:run-audit']({});
  // Let the detached run reach its first (gated) request.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await handlers['observations:get-run-status']({})).status, 'running');
  // Open the gate; the crawl drains to completion.
  openGate();
  const terminal = await waitForRun(handlers);
  assert.equal(terminal.status, 'done');
});

test('createTenantObservationsHandlers: get-run-status reports lost when a running record has no live run (orphan) (FMN-256)', async () => {
  const storage = createStorageMock();
  // Simulate a worker that died mid-crawl: a 'running' record is on disk
  // but this fresh handlers instance has no in-memory run.
  await storage.set({ [OBSERVATIONS_RUN_KEY]: { status: 'running', started_at: '2026-05-26T00:00:00Z' } });
  const handlers = createTenantObservationsHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: buildBaselineFetch() }),
    storage,
    keepAlive: noKeepAlive
  });
  const s = await handlers['observations:get-run-status']({});
  assert.equal(s.status, 'lost');
  assert.equal(s.started_at, '2026-05-26T00:00:00Z');
});

test('createTenantObservationsHandlers: run-audit records error status when the crawl throws (FMN-256)', async () => {
  const storage = createStorageMock();
  const handlers = createTenantObservationsHandlers({
    events: { emit: () => {} },
    getClient: async () => { throw new Error('boom: no api key'); },
    storage,
    keepAlive: noKeepAlive
  });
  const handle = await handlers['observations:run-audit']({});
  assert.equal(handle.status, 'started');
  const terminal = await waitForRun(handlers);
  assert.equal(terminal.status, 'error');
  assert.match(terminal.error, /boom/);
});

test('createTenantObservationsHandlers: a result-staging quota failure records error, not a half-done state (FMN-256)', async () => {
  // Reproduces the live failure: the crawl succeeds but writing the
  // multi-MB result to storage throws "quota bytes exceeded". The run must
  // record 'error' and leave no readable result behind - never a 'done'
  // status pointing at a missing result.
  const base = createStorageMock();
  const store = {
    get: (k) => base.get(k),
    set: async (obj) => {
      if (Object.prototype.hasOwnProperty.call(obj, OBSERVATIONS_RESULT_KEY)) {
        throw new Error('Session storage quota bytes exceeded. Values were not stored.');
      }
      return base.set(obj);
    },
    remove: (k) => base.remove(k),
    __raw: () => base.__raw()
  };
  const handlers = createTenantObservationsHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: buildBaselineFetch() }),
    storage: store,
    keepAlive: noKeepAlive
  });
  await handlers['observations:run-audit']({});
  const terminal = await waitForRun(handlers);
  assert.equal(terminal.status, 'error');
  assert.match(terminal.error, /quota/i);
  assert.equal(base.__raw()[OBSERVATIONS_RESULT_KEY], undefined, 'no partial result left behind');
  await assert.rejects(() => handlers['observations:get-run-result']({}), /not done|No staged/);
});

test('runTenantObservations: returns inventory + analysis on a tiny baseline fetch', async () => {
  const fetch = buildBaselineFetch();
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const events = [];
  const r = await runTenantObservations({
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

test('runTenantObservations: stages sanitized result.sections (default ["all"]) (FMN-146)', async () => {
  const fetch = buildBaselineFetch();
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const r = await runTenantObservations({ client });
  assert.deepEqual(r.sections, ['all']);
});

test('runTenantObservations: passes through analyzer-scoped sections selection (FMN-146)', async () => {
  const fetch = buildBaselineFetch();
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const r = await runTenantObservations({ client, sections: ['user-activity'] });
  assert.deepEqual(r.sections, ['user-activity']);
});

test('runTenantObservations: invalid sections values are sanitized to ["all"] (FMN-146)', async () => {
  const fetch = buildBaselineFetch();
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const r = await runTenantObservations({ client, sections: ['bogus', 'also-bogus'] });
  assert.deepEqual(r.sections, ['all']);
});

test('createTenantObservationsHandlers: observations:run-audit forwards payload.sections to the staged result (FMN-146)', async () => {
  const storage = createStorageMock();
  const handlers = createTenantObservationsHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: buildBaselineFetch() }),
    storage
  });
  await handlers['observations:run-audit']({ sections: ['template-recommendations', 'monitoring-policy'] });
  await waitForRun(handlers);
  const stored = storage.__raw()[OBSERVATIONS_RESULT_KEY];
  assert.deepEqual(stored.sections, ['template-recommendations', 'monitoring-policy']);
});

test('runTenantObservations: ["user-activity"] runs only the user analyzer and skips frontend templates walk (FMN-149)', async () => {
  const v2Fetch = createFetchMock(async (url) => {
    if (/\/v2\/user\b/.test(url)) {
      return listResponse('user_list', [{
        id: 42, name: 'Alice', contact_info: [{ url: 'https://api2.panopta.com/v2/contact/9001/contact_info/1' }]
      }]);
    }
    return jsonResponse({});
  });
  const frontendUrls = [];
  const frontendFetch = createFetchMock(async (url) => {
    frontendUrls.push(url);
    if (/\/users\/users\/get_edit_user_data/.test(url)) {
      return jsonRes({ success: true, data: { user_id: 42, contact_id: 9001, config_data: { last_login: 'x', created_on: 'y' } } });
    }
    throw new Error('unexpected frontend URL: ' + url);
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch: v2Fetch });
  const r = await runTenantObservations({ client, includeFrontend: true, frontendFetch, sections: ['user-activity'] });

  // Analyzer dispatch: only user-activity result key present.
  assert.deepEqual(Object.keys(r.analysis), ['users']);
  // Frontend walk: only EditUser was hit; monitoring_config_data was NOT.
  assert.ok(frontendUrls.some((u) => /get_edit_user_data/.test(u)));
  assert.equal(frontendUrls.some((u) => /get_monitoring_config_data/.test(u)), false);
  assert.deepEqual(r.sections, ['user-activity']);
});

test('runTenantObservations: ["template-recommendations"] runs only template analyzer + template config walk (FMN-149)', async () => {
  const v2Fetch = createFetchMock(async (url) => {
    if (/\/v2\/server_template\?limit=/.test(url)) {
      return listResponse('server_template_list', [{ id: 101, name: 't1', url: '/v2/server_template/101' }]);
    }
    if (/\/v2\/server_template\/101$/.test(url)) {
      return jsonResponse({ id: 101, name: 't1' });
    }
    return jsonResponse({});
  });
  const frontendUrls = [];
  const frontendFetch = createFetchMock(async (url) => {
    frontendUrls.push(url);
    if (/\/report\/get_monitoring_config_data/.test(url)) {
      return jsonRes({ success: true, categories: { added: [], detected: [] } });
    }
    throw new Error('unexpected frontend URL: ' + url);
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch: v2Fetch });
  const r = await runTenantObservations({ client, includeFrontend: true, frontendFetch, sections: ['template-recommendations'] });
  assert.deepEqual(Object.keys(r.analysis), ['templates']);
  assert.equal(frontendUrls.some((u) => /get_edit_user_data/.test(u)), false);
  assert.ok(frontendUrls.some((u) => /get_monitoring_config_data/.test(u)));
});

test('runTenantObservations: ["incidents"] does not call user-activity or template-config walks (FMN-149)', async () => {
  const fetch = buildBaselineFetch();
  const frontendUrls = [];
  const frontendFetch = createFetchMock(async (url) => {
    frontendUrls.push(url);
    // FMN-221: customer identity is fetched unconditionally from
    // /report/ListReports. Return an empty HTML page so the helper
    // bails to null (no sentry_user in the body). The original FMN-149
    // contract was about skipping the SLOW per-user and per-template
    // walks, not about every session-auth fetch.
    return {
      ok: true, status: 200,
      headers: new Map([['content-type', 'text/html; charset=utf-8']]),
      async text() { return ''; },
    };
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const r = await runTenantObservations({ client, includeFrontend: true, frontendFetch, sections: ['incidents'] });
  assert.equal(frontendUrls.some((u) => /get_edit_user_data/.test(u)), false, 'no per-user activity walk');
  assert.equal(frontendUrls.some((u) => /get_monitoring_config_data/.test(u)), false, 'no per-template config walk');
  // FMN-156 rework: noise is ancillary to incidents, so selecting
  // incidents also produces the noise analyzer's result key.
  assert.deepEqual(Object.keys(r.analysis).sort(), ['incidents', 'noise']);
});

test('runTenantObservations: 401 from any endpoint propagates as PanoptaError(auth)', async () => {
  const fetch = createFetchMock(async () => errorResponse(401));
  const client = new PanoptaClient({ apiKey: 'bad', fetch });
  await assert.rejects(
    () => runTenantObservations({ client }),
    (err) => err instanceof PanoptaError && err.phase === 'auth'
  );
});

// Helper: build a session-auth mock that handles both get_edit_user_data
// and get_monitoring_config_data, so tests exercising the always-on
// template walk don't fall off the end of the routing.
function jsonRes(json) {
  return {
    ok: true, status: 200,
    headers: new Map([['content-type', 'application/json; charset=utf-8']]),
    async text() { return JSON.stringify(json); },
    async json() { return json; }
  };
}

test('runTenantObservations: includeFrontend walks EditUser pages and enriches inventory (FMN-135)', async () => {
  // Baseline v2 fetch returns one user with the v2-shaped contact_info
  // that carries the contact_id (a different number space from the user
  // id). The frontend fetch should hit EditUser?contact_id={contactId}
  // and the result should be keyed by the user id.
  const v2Fetch = createFetchMock(async (url) => {
    if (/\/v2\/user\b/.test(url)) {
      return listResponse('user_list', [{
        id: 42,
        name: 'Alice',
        email: 'a@x',
        contact_info: [{ url: 'https://api2.panopta.com/v2/contact/9001/contact_info/1' }]
      }]);
    }
    if (/\/server_attribute_type/.test(url)) return listResponse('server_attribute_type_list', []);
    return jsonResponse({});
  });
  const frontendFetch = createFetchMock(async (url) => {
    if (/\/users\/users\/get_edit_user_data/.test(url)) {
      assert.match(url, /contact_id=9001/);
      return jsonRes({
        success: true,
        data: {
          user_id: 42, contact_id: 9001,
          config_data: { last_login: '2026-04-30 12:34:56 UTC', created_on: 'Jan 1, 2024' }
        }
      });
    }
    if (/\/report\/get_monitoring_config_data/.test(url)) {
      return jsonRes({ success: true, categories: { added: [], detected: [] } });
    }
    throw new Error('unexpected frontend URL: ' + url);
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch: v2Fetch });
  const events = [];
  const r = await runTenantObservations({
    client,
    includeFrontend: true,
    frontendFetch,
    onProgress: (e) => events.push(e)
  });
  assert.equal(r.include_frontend, true);
  // Result map keyed by USER id (42), even though the URL used CONTACT id (9001).
  assert.deepEqual(r.inventory.frontend_user_data, {
    '42': { last_login: '2026-04-30 12:34:56 UTC', created_on: 'Jan 1, 2024' }
  });
  // Analyzer picked up the merged data.
  const alice = r.analysis.users.details.find((d) => d.id === 42);
  assert.ok(alice, 'analyzer detail for user 42 missing');
  assert.equal(alice.last_login, '2026-04-30 12:34:56 UTC');
  // FMN-143: last_login_manual was removed (no manual fallback).
  assert.equal(alice.last_login_manual, undefined);
  assert.equal(alice.created_on, 'Jan 1, 2024');
  // Frontend lifecycle events fired (both the user phase and the
  // template phase fire on every includeFrontend run).
  const phases = events.map((e) => e.phase);
  assert.ok(phases.includes('frontend:start'));
  assert.ok(phases.includes('frontend:done'));
  assert.ok(phases.includes('frontend-templates:start'));
  assert.ok(phases.includes('frontend-templates:done'));
});

test('runTenantObservations: frontendOrigin (string) routes session-auth fetches to the resolved tenant host (FMN-144)', async () => {
  const REGIONAL = 'https://my.us02.fortimonitor.com';
  const seenUrls = [];
  const v2Fetch = createFetchMock(async (url) => {
    if (/\/v2\/user\b/.test(url)) {
      return listResponse('user_list', [{
        id: 7, name: 'Pat', contact_info: [{ url: 'https://api2.panopta.com/v2/contact/55/contact_info/1' }]
      }]);
    }
    if (/\/server_attribute_type/.test(url)) return listResponse('server_attribute_type_list', []);
    return jsonResponse({});
  });
  const frontendFetch = createFetchMock(async (url) => {
    seenUrls.push(url);
    if (/\/users\/users\/get_edit_user_data/.test(url)) {
      return jsonRes({ success: true, data: {
        user_id: 7, contact_id: 55,
        config_data: { last_login: '2026-04-30 11:00 UTC', created_on: 'Jan 1, 2024' }
      }});
    }
    if (/\/report\/get_monitoring_config_data/.test(url)) {
      return jsonRes({ success: true, categories: { added: [], detected: [] } });
    }
    throw new Error('unexpected frontend URL: ' + url);
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch: v2Fetch });
  const r = await runTenantObservations({
    client,
    includeFrontend: true,
    frontendFetch,
    frontendOrigin: REGIONAL
  });
  // Every frontend URL must hit the resolved regional origin, never
  // the federation URL.
  assert.ok(seenUrls.length > 0, 'frontend phase should have made requests');
  for (const u of seenUrls) {
    assert.ok(u.startsWith(REGIONAL), `expected URL on ${REGIONAL}, got ${u}`);
    assert.equal(u.startsWith('https://fortimonitor.forticloud.com'), false);
  }
  // Data still flows through (sanity).
  assert.equal(r.analysis.users.details[0].last_login, '2026-04-30 11:00 UTC');
});

test('runTenantObservations: frontendOrigin (thunk) is awaited and applied (FMN-144)', async () => {
  const REGIONAL = 'https://my.us03.fortimonitor.com';
  let resolverCalls = 0;
  const v2Fetch = createFetchMock(async (url) => {
    if (/\/v2\/user\b/.test(url)) return listResponse('user_list', [
      { id: 1, name: 'A', contact_info: [{ url: 'https://api2.panopta.com/v2/contact/10/contact_info/1' }] }
    ]);
    if (/\/server_attribute_type/.test(url)) return listResponse('server_attribute_type_list', []);
    return jsonResponse({});
  });
  const frontendFetch = createFetchMock(async (url) => {
    if (/\/users\/users\/get_edit_user_data/.test(url)) {
      assert.ok(url.startsWith(REGIONAL), `expected ${REGIONAL}, got ${url}`);
      return jsonRes({ success: true, data: { user_id: 1, contact_id: 10,
        config_data: { last_login: '2026-04-30 09:00 UTC', created_on: 'x' } } });
    }
    if (/\/report\/get_monitoring_config_data/.test(url)) {
      return jsonRes({ success: true, categories: { added: [], detected: [] } });
    }
    throw new Error('unexpected frontend URL: ' + url);
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch: v2Fetch });
  await runTenantObservations({
    client,
    includeFrontend: true,
    frontendFetch,
    frontendOrigin: async () => { resolverCalls += 1; return REGIONAL; }
  });
  assert.equal(resolverCalls, 1, 'thunk should be awaited exactly once');
});

test('runTenantObservations: includeFrontend always walks template configs (FMN-135 follow-up)', async () => {
  const v2Fetch = createFetchMock(async (url) => {
    if (/\/v2\/user\b/.test(url)) return listResponse('user_list', []);
    if (/\/v2\/server_template\b/.test(url)) return listResponse('server_template_list', [
      { id: 100, name: 'Stock Linux', url: 'https://api2.panopta.com/v2/server_template/100' },
      { id: 200, name: 'Tuned',       url: 'https://api2.panopta.com/v2/server_template/200' }
    ]);
    if (/\/server_attribute_type/.test(url)) return listResponse('server_attribute_type_list', []);
    return jsonResponse({});
  });
  const frontendFetch = createFetchMock(async (url) => {
    if (/\/report\/get_monitoring_config_data/.test(url)) {
      const m = url.match(/server_id=(\d+)/);
      const id = parseInt(m?.[1] ?? '0', 10);
      // template 100: 2 metrics, 0 alerts (default-only)
      // template 200: 2 metrics, 2 alerts (tuned)
      const metrics = id === 100
        ? [{ id: -1, name: 'CPU', alert_items: [] }, { id: -2, name: 'Memory', alert_items: [] }]
        : [{ id: -3, name: 'CPU', alert_items: [['warn']] }, { id: -4, name: 'Disk', alert_items: [['crit']] }];
      return jsonRes({ success: true, categories: { added: [{ name: 'Test', textkey: 'x', metrics }], detected: [] } });
    }
    throw new Error('unexpected frontend URL: ' + url);
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch: v2Fetch });
  const r = await runTenantObservations({ client, includeFrontend: true, frontendFetch });

  assert.ok(r.inventory.template_monitoring_configs, 'template_monitoring_configs missing');
  assert.equal(r.inventory.template_monitoring_configs['100'].total_metrics, 2);
  assert.equal(r.inventory.template_monitoring_configs['100'].alerts_count, 0);
  assert.equal(r.inventory.template_monitoring_configs['200'].alerts_count, 2);

  // The analyzer should now flag template 100 as default-only.
  assert.equal(r.analysis.templates.available, true);
  const flagged = r.analysis.templates.default_only_templates.map((t) => t.template);
  assert.deepEqual(flagged, ['Stock Linux']);
});

test('runTenantObservations: includeFrontend records auth failure on inventory.errors and continues to analyzers', async () => {
  const v2Fetch = createFetchMock(async (url) => {
    if (/\/v2\/user\b/.test(url)) {
      return listResponse('user_list', [
        { id: 1, name: 'Alice', contact_info: [{ url: 'https://api2.panopta.com/v2/contact/100/contact_info/1' }] },
        { id: 2, name: 'Bob',   contact_info: [{ url: 'https://api2.panopta.com/v2/contact/200/contact_info/1' }] }
      ]);
    }
    if (/\/server_attribute_type/.test(url)) return listResponse('server_attribute_type_list', []);
    return jsonResponse({});
  });
  // Unauthenticated FortiMonitor: the get_edit_user_data endpoint
  // returns 200 with the SPA shell HTML rather than JSON. The fetcher
  // distinguishes by Content-Type.
  const frontendFetch = createFetchMock(async () => ({
    ok: true, status: 200,
    headers: new Map([['content-type', 'text/html; charset=utf-8']]),
    async text() { return '<!DOCTYPE html>...spa shell...'; },
    async json() { throw new Error('not json'); }
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch: v2Fetch });
  const r = await runTenantObservations({
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

test('runTenantObservations: AbortSignal aborts mid-collection', async () => {
  const ctl = new AbortController();
  let calls = 0;
  const fetch = createFetchMock(async () => {
    calls += 1;
    if (calls === 1) ctl.abort();
    return jsonResponse({});
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  await assert.rejects(
    () => runTenantObservations({ client, signal: ctl.signal }),
    (err) => err.name === 'AbortError'
  );
});
