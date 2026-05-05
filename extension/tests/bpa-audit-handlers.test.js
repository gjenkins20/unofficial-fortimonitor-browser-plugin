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

test('runBpaAudit: stages sanitized result.sections (default ["all"]) (FMN-146)', async () => {
  const fetch = buildBaselineFetch();
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const r = await runBpaAudit({ client });
  assert.deepEqual(r.sections, ['all']);
});

test('runBpaAudit: passes through analyzer-scoped sections selection (FMN-146)', async () => {
  const fetch = buildBaselineFetch();
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const r = await runBpaAudit({ client, sections: ['user-activity'] });
  assert.deepEqual(r.sections, ['user-activity']);
});

test('runBpaAudit: invalid sections values are sanitized to ["all"] (FMN-146)', async () => {
  const fetch = buildBaselineFetch();
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const r = await runBpaAudit({ client, sections: ['bogus', 'also-bogus'] });
  assert.deepEqual(r.sections, ['all']);
});

test('createBpaAuditHandlers: bpa:run-audit forwards payload.sections to the staged result (FMN-146)', async () => {
  const storage = createStorageMock();
  const handlers = createBpaAuditHandlers({
    events: { emit: () => {} },
    getClient: async () => new PanoptaClient({ apiKey: 'k', fetch: buildBaselineFetch() }),
    storage
  });
  await handlers['bpa:run-audit']({ sections: ['template-recommendations', 'monitoring-policy'] });
  const stored = storage.__raw()[BPA_RUN_KEY];
  assert.deepEqual(stored.sections, ['template-recommendations', 'monitoring-policy']);
});

test('runBpaAudit: ["user-activity"] runs only the user analyzer and skips frontend templates walk (FMN-149)', async () => {
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
  const r = await runBpaAudit({ client, includeFrontend: true, frontendFetch, sections: ['user-activity'] });

  // Analyzer dispatch: only user-activity result key present.
  assert.deepEqual(Object.keys(r.analysis), ['users']);
  // Frontend walk: only EditUser was hit; monitoring_config_data was NOT.
  assert.ok(frontendUrls.some((u) => /get_edit_user_data/.test(u)));
  assert.equal(frontendUrls.some((u) => /get_monitoring_config_data/.test(u)), false);
  assert.deepEqual(r.sections, ['user-activity']);
});

test('runBpaAudit: ["template-recommendations"] runs only template analyzer + template config walk (FMN-149)', async () => {
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
  const r = await runBpaAudit({ client, includeFrontend: true, frontendFetch, sections: ['template-recommendations'] });
  assert.deepEqual(Object.keys(r.analysis), ['templates']);
  assert.equal(frontendUrls.some((u) => /get_edit_user_data/.test(u)), false);
  assert.ok(frontendUrls.some((u) => /get_monitoring_config_data/.test(u)));
});

test('runBpaAudit: ["incidents"] does not call frontend fetcher at all (FMN-149)', async () => {
  const fetch = buildBaselineFetch();
  let frontendCalled = false;
  const frontendFetch = createFetchMock(async () => {
    frontendCalled = true;
    return jsonRes({ success: true });
  });
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const r = await runBpaAudit({ client, includeFrontend: true, frontendFetch, sections: ['incidents'] });
  assert.equal(frontendCalled, false, 'frontend fetcher must not run when neither user-activity nor templates is selected');
  assert.deepEqual(Object.keys(r.analysis), ['incidents']);
});

test('runBpaAudit: 401 from any endpoint propagates as PanoptaError(auth)', async () => {
  const fetch = createFetchMock(async () => errorResponse(401));
  const client = new PanoptaClient({ apiKey: 'bad', fetch });
  await assert.rejects(
    () => runBpaAudit({ client }),
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

test('runBpaAudit: includeFrontend walks EditUser pages and enriches inventory (FMN-135)', async () => {
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
  const r = await runBpaAudit({
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

test('runBpaAudit: frontendOrigin (string) routes session-auth fetches to the resolved tenant host (FMN-144)', async () => {
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
  const r = await runBpaAudit({
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

test('runBpaAudit: frontendOrigin (thunk) is awaited and applied (FMN-144)', async () => {
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
  await runBpaAudit({
    client,
    includeFrontend: true,
    frontendFetch,
    frontendOrigin: async () => { resolverCalls += 1; return REGIONAL; }
  });
  assert.equal(resolverCalls, 1, 'thunk should be awaited exactly once');
});

test('runBpaAudit: includeFrontend always walks template configs (FMN-135 follow-up)', async () => {
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
  const r = await runBpaAudit({ client, includeFrontend: true, frontendFetch });

  assert.ok(r.inventory.template_monitoring_configs, 'template_monitoring_configs missing');
  assert.equal(r.inventory.template_monitoring_configs['100'].total_metrics, 2);
  assert.equal(r.inventory.template_monitoring_configs['100'].alerts_count, 0);
  assert.equal(r.inventory.template_monitoring_configs['200'].alerts_count, 2);

  // The analyzer should now flag template 100 as default-only.
  assert.equal(r.analysis.templates.available, true);
  const flagged = r.analysis.templates.default_only_templates.map((t) => t.template);
  assert.deepEqual(flagged, ['Stock Linux']);
});

test('runBpaAudit: includeFrontend records auth failure on inventory.errors and continues to analyzers', async () => {
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
