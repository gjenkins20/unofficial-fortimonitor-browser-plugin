import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanoptaClient, PanoptaError } from '../src/lib/panopta-client.js';
import {
  BpaFetcher,
  createPacedFetch,
  createRetryingFetch,
  createBpaFetch,
  extractTrailingId,
  abortableSleep,
  RATE_LIMIT_PER_SECOND
} from '../src/lib/bpa-fetcher.js';
import { createFetchMock, jsonResponse, errorResponse } from './fixtures/chrome-mocks.js';

// Build a per-endpoint mock router. `routes` is an object mapping a
// regex (or string) pattern to a handler returning a response. Handler
// receives the raw URL string. First match wins.
function routeFetch(routes) {
  const compiled = routes.map(({ match, respond }) => ({
    match: match instanceof RegExp ? match : new RegExp(escapeRe(match)),
    respond
  }));
  return createFetchMock(async (url) => {
    for (const { match, respond } of compiled) {
      if (match.test(url)) return respond(url);
    }
    return errorResponse(404);
  });
}
function escapeRe(s) { return String(s).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'); }
function listResponse(envelopeKey, items, total = items.length) {
  return jsonResponse({ [envelopeKey]: items, meta: { total_count: total } });
}

// =============================================================================
// extractTrailingId
// =============================================================================

test('extractTrailingId pulls numeric id from v2-style url', () => {
  assert.equal(extractTrailingId('https://api2.panopta.com/v2/server/42024060'), 42024060);
  assert.equal(extractTrailingId('https://api2.panopta.com/v2/server/42024060/'), 42024060);
  assert.equal(extractTrailingId('/v2/server_group/123'), 123);
  assert.equal(extractTrailingId(null), null);
  assert.equal(extractTrailingId(''), null);
  assert.equal(extractTrailingId('not-a-url'), null);
});

// =============================================================================
// createPacedFetch
// =============================================================================

test('createPacedFetch spaces calls at 1000/rateLimit ms apart', async () => {
  let now = 0;
  const sleeps = [];
  const fakeSleep = async (ms) => { sleeps.push(ms); now += ms; };
  const baseFetch = async () => { return jsonResponse({}); };
  const paced = createPacedFetch(baseFetch, {
    rateLimit: 5,
    now: () => now,
    sleep: fakeSleep
  });

  // First call: no wait (slot is in the past).
  await paced('http://x');
  // Second call (issued at the same instant): must wait one interval (200ms).
  await paced('http://x');
  // Third call (still same instant): must wait two intervals from the original.
  await paced('http://x');

  // First call no sleep; second sleeps 200; third sleeps 200 more.
  assert.deepEqual(sleeps, [200, 200]);
});

test('createPacedFetch with rateLimit=0 disables pacing', async () => {
  const sleeps = [];
  const baseFetch = async () => jsonResponse({});
  const paced = createPacedFetch(baseFetch, {
    rateLimit: 0,
    now: () => 0,
    sleep: async (ms) => { sleeps.push(ms); }
  });
  await paced('http://x');
  await paced('http://x');
  await paced('http://x');
  assert.deepEqual(sleeps, []);
});

test('RATE_LIMIT_PER_SECOND default matches Python source (5 req/s)', () => {
  assert.equal(RATE_LIMIT_PER_SECOND, 5);
});

// =============================================================================
// createRetryingFetch
// =============================================================================

test('createRetryingFetch retries 5xx with 2s/4s/6s backoff and returns on success', async () => {
  const sleeps = [];
  let calls = 0;
  const baseFetch = async () => {
    calls++;
    if (calls < 3) return errorResponse(503);
    return jsonResponse({ ok: true });
  };
  const retrying = createRetryingFetch(baseFetch, {
    sleep: async (ms) => { sleeps.push(ms); }
  });
  const res = await retrying('http://x');
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [2000, 4000]);
});

test('createRetryingFetch returns the final 5xx after exhausting attempts', async () => {
  const sleeps = [];
  let calls = 0;
  const baseFetch = async () => { calls++; return errorResponse(502); };
  const retrying = createRetryingFetch(baseFetch, {
    sleep: async (ms) => { sleeps.push(ms); }
  });
  const res = await retrying('http://x');
  assert.equal(res.status, 502);
  assert.equal(calls, 4);              // 1 + 3 retries
  assert.deepEqual(sleeps, [2000, 4000, 6000]);
});

test('createRetryingFetch passes through 4xx without retry', async () => {
  let calls = 0;
  const baseFetch = async () => { calls++; return errorResponse(404); };
  const retrying = createRetryingFetch(baseFetch, { sleep: async () => {} });
  const res = await retrying('http://x');
  assert.equal(res.status, 404);
  assert.equal(calls, 1);
});

test('createRetryingFetch retries network errors and re-throws after exhaustion', async () => {
  let calls = 0;
  const baseFetch = async () => { calls++; throw new TypeError('network down'); };
  const retrying = createRetryingFetch(baseFetch, { sleep: async () => {} });
  await assert.rejects(() => retrying('http://x'), /network down/);
  assert.equal(calls, 4);
});

test('createRetryingFetch does not retry AbortError', async () => {
  let calls = 0;
  const baseFetch = async () => {
    calls++;
    const err = new Error('aborted'); err.name = 'AbortError'; throw err;
  };
  const retrying = createRetryingFetch(baseFetch, { sleep: async () => {} });
  await assert.rejects(() => retrying('http://x'), /aborted/);
  assert.equal(calls, 1);
});

// =============================================================================
// createBpaFetch (composed)
// =============================================================================

test('createBpaFetch paces every attempt including retries', async () => {
  let now = 0;
  const sleeps = [];
  const fakeSleep = async (ms) => { sleeps.push(ms); now += ms; };
  let calls = 0;
  const baseFetch = async () => {
    calls++;
    if (calls < 3) return errorResponse(500);
    return jsonResponse({ ok: 1 });
  };
  const fetch = createBpaFetch(baseFetch, {
    rateLimit: 5,
    now: () => now,
    sleep: fakeSleep
  });
  await fetch('http://x');
  // Pacing inserts sleeps based on slot accounting; backoff inserts 2s/4s.
  // We don't pin exact ordering here; we check that all expected sleeps occurred.
  assert.equal(calls, 3);
  assert.ok(sleeps.includes(2000), `expected 2000ms backoff sleep; got ${sleeps}`);
  assert.ok(sleeps.includes(4000), `expected 4000ms backoff sleep; got ${sleeps}`);
});

// =============================================================================
// abortableSleep
// =============================================================================

test('abortableSleep rejects with AbortError when signal aborts mid-flight', async () => {
  const ctl = new AbortController();
  const p = abortableSleep(60000, ctl.signal);
  ctl.abort();
  await assert.rejects(p, (err) => err.name === 'AbortError');
});

test('abortableSleep rejects immediately if signal is already aborted', async () => {
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(abortableSleep(60000, ctl.signal), (err) => err.name === 'AbortError');
});

// =============================================================================
// BpaFetcher: end-to-end inventory walks
// =============================================================================

function makeStandardRoutes({
  servers = [],
  serverGroups = [],
  serverTemplates = [],
  outages = [],
  groupDetails = {},
  templateDetails = {},
  outageStats = { '7': {}, '30': {}, '60': {} }
} = {}) {
  return [
    // Top-level lists
    { match: /\/server\?limit=/,                respond: () => listResponse('server_list', servers) },
    { match: /\/server_group\?limit=/,          respond: () => listResponse('server_group_list', serverGroups) },
    { match: /\/server_template\?limit=/,       respond: () => listResponse('server_template_list', serverTemplates) },
    { match: /\/outage\?limit=/,                respond: () => listResponse('outage_list', outages) },
    { match: /\/compound_service\?limit=/,      respond: () => listResponse('compound_service_list', []) },
    { match: /\/monitoring\/dem\/application\?limit=/, respond: () => listResponse('dem_application_list', []) },
    { match: /\/dashboard\?limit=/,             respond: () => listResponse('dashboard_list', []) },
    { match: /\/status_page\?limit=/,           respond: () => listResponse('status_page_list', []) },
    { match: /\/contact\?limit=/,               respond: () => listResponse('contact_list', []) },
    { match: /\/contact_group\?limit=/,         respond: () => listResponse('contact_group_list', []) },
    { match: /\/notification_schedule\?limit=/, respond: () => listResponse('notification_schedule_list', []) },
    { match: /\/rotating_contact\?limit=/,      respond: () => listResponse('rotating_contact_list', []) },
    { match: /\/maintenance_schedule\?limit=/,  respond: () => listResponse('maintenance_schedule_list', []) },
    { match: /\/onsight\?limit=/,               respond: () => listResponse('onsight_list', []) },
    { match: /\/fabric_connection\?limit=/,     respond: () => listResponse('fabric_connection_list', []) },
    { match: /\/cloud_credential\?limit=/,      respond: () => listResponse('cloud_credential_list', []) },
    { match: /\/snmp_credential\?limit=/,       respond: () => listResponse('snmp_credential_list', []) },
    { match: /\/monitoring_node\?limit=/,       respond: () => listResponse('monitoring_node_list', []) },
    { match: /\/user\?limit=/,                  respond: () => listResponse('user_list', []) },
    // Outage stats
    { match: /\/outage_statistics\?days=7$/,    respond: () => jsonResponse(outageStats['7']) },
    { match: /\/outage_statistics\?days=30$/,   respond: () => jsonResponse(outageStats['30']) },
    { match: /\/outage_statistics\?days=60$/,   respond: () => jsonResponse(outageStats['60']) },
    // Group/template details (single-shot, no ?limit=)
    { match: /\/server_group\/(\d+)$/,          respond: (url) => {
        const id = url.match(/\/server_group\/(\d+)$/)[1];
        return groupDetails[id] ? jsonResponse(groupDetails[id]) : errorResponse(404);
      }
    },
    { match: /\/server_template\/(\d+)$/,       respond: (url) => {
        const id = url.match(/\/server_template\/(\d+)$/)[1];
        return templateDetails[id] ? jsonResponse(templateDetails[id]) : errorResponse(404);
      }
    }
  ];
}

test('BpaFetcher.collectInventory returns all 19 top-level keys plus trending and details', async () => {
  const fetch = routeFetch(makeStandardRoutes({
    servers: [{ id: 1, name: 's1' }, { id: 2, name: 's2' }],
    serverGroups: [{ id: 11, name: 'g1', url: '/v2/server_group/11' }],
    serverTemplates: [{ id: 101, name: 't1', url: '/v2/server_template/101' }],
    outages: [{ id: 5001, active: false }],
    groupDetails: { 11: { id: 11, name: 'g1-detail' } },
    templateDetails: { 101: { id: 101, name: 't1-detail' } }
  }));
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const fetcher = new BpaFetcher({ client });

  const inv = await fetcher.collectInventory();

  // Top-level lists - all present
  for (const k of [
    'servers', 'server_groups', 'server_templates', 'outages',
    'compound_services', 'dem_applications', 'dashboards', 'status_pages',
    'contacts', 'contact_groups', 'notification_schedules', 'rotating_contacts',
    'maintenance_windows', 'onsights', 'fabric_connections', 'cloud_credentials',
    'snmp_credentials', 'monitoring_nodes', 'users'
  ]) {
    assert.ok(Array.isArray(inv[k]), `${k} should be an array`);
  }
  // Sanity: actual data flowed through
  assert.equal(inv.servers.length, 2);
  assert.equal(inv.servers[0].name, 's1');

  // Trending
  assert.ok(Array.isArray(inv.outages_recent));
  assert.deepEqual(inv.outage_stats_7d, {});
  assert.deepEqual(inv.outage_stats_30d, {});
  assert.deepEqual(inv.outage_stats_60d, {});
  assert.deepEqual(inv.outage_logs, {});

  // Details - keyed by id, populated from group/template details routes
  assert.equal(inv.server_group_details['11'].name, 'g1-detail');
  assert.equal(inv.server_template_details['101'].name, 't1-detail');

  // Errors empty, stats present
  assert.deepEqual(inv.errors, []);
  assert.equal(typeof inv.stats.requests, 'number');
  assert.equal(inv.stats.deep, false);
});

test('BpaFetcher.collectInventory: 404 from a list endpoint becomes empty array, not an error', async () => {
  const routes = makeStandardRoutes();
  // Force /compound_service to 404
  routes.unshift({ match: /\/compound_service\?limit=/, respond: () => errorResponse(404) });
  const fetch = routeFetch(routes);
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const fetcher = new BpaFetcher({ client });
  const inv = await fetcher.collectInventory();
  assert.deepEqual(inv.compound_services, []);
  assert.equal(inv.errors.length, 0);
});

test('BpaFetcher.collectInventory: 405 from a list endpoint is silently skipped (FMN-133 status_page)', async () => {
  // Real-world: GET /v2/status_page?limit=200 returns 405 on production
  // tenants. The endpoint is GET-listable for some accounts but not others;
  // either way, we treat it like 404 - empty list, no error noise.
  const routes = makeStandardRoutes();
  routes.unshift({ match: /\/status_page\?limit=/, respond: () => errorResponse(405) });
  const fetch = routeFetch(routes);
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const fetcher = new BpaFetcher({ client });
  const inv = await fetcher.collectInventory();
  assert.deepEqual(inv.status_pages, []);
  assert.equal(inv.errors.length, 0, 'errors[] must NOT contain status_pages 405');
});

test('BpaFetcher.collectInventory: 401 from any list endpoint fails the whole collection', async () => {
  const routes = makeStandardRoutes();
  routes.unshift({ match: /\/server\?limit=/, respond: () => errorResponse(401) });
  const fetch = routeFetch(routes);
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const fetcher = new BpaFetcher({ client });
  await assert.rejects(
    () => fetcher.collectInventory(),
    (err) => err instanceof PanoptaError && err.phase === 'auth'
  );
});

test('BpaFetcher.collectInventory: 500 from a list endpoint records to errors[] and continues', async () => {
  const routes = makeStandardRoutes();
  // /onsight: 500. (PanoptaClient has no retry on its own; if our retrying
  // fetch is bypassed - which it is in this test since we use raw fetch -
  // the 500 propagates and gets recorded.)
  routes.unshift({ match: /\/onsight\?limit=/, respond: () => errorResponse(500) });
  const fetch = routeFetch(routes);
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const fetcher = new BpaFetcher({ client });
  const inv = await fetcher.collectInventory();
  assert.deepEqual(inv.onsights, []);
  assert.equal(inv.errors.length, 1);
  assert.match(inv.errors[0], /^onsights:/);
});

test('BpaFetcher.collectInventory: deep mode collects per-server data', async () => {
  const routes = makeStandardRoutes({
    servers: [
      { id: 7, name: 'fgvm', url: '/v2/server/7' }
    ]
  });
  // Add per-server routes
  routes.push(
    { match: /\/server\/7$/, respond: () => jsonResponse({ id: 7, name: 'fgvm' }) },
    { match: /\/server\/7\/agent_resource\?limit=/, respond: () =>
        listResponse('agent_resource_list', [{ id: 555, url: '/v2/server/7/agent_resource/555' }])
    },
    { match: /\/server\/7\/agent_resource\/555$/, respond: () =>
        jsonResponse({ id: 555, threshold: 90 })
    },
    { match: /\/server\/7\/network_service\?limit=/, respond: () =>
        listResponse('network_service_list', [{ id: 9001 }])
    },
    { match: /\/server\/7\/attribute\?limit=/, respond: () =>
        listResponse('server_attribute_list', [{ id: 12, name: 'role', value: 'sd-wan' }])
    }
  );
  const fetch = routeFetch(routes);
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const fetcher = new BpaFetcher({ client });
  const inv = await fetcher.collectInventory({ deep: true });
  assert.equal(inv.server_details['7'].name, 'fgvm');
  assert.equal(inv.server_resources['7'].length, 1);
  assert.equal(inv.server_resource_details['7']['555'].threshold, 90);
  assert.equal(inv.server_network_services['7'].length, 1);
  assert.equal(inv.server_attributes['7'].length, 1);
  assert.equal(inv.stats.deep, true);
});

test('BpaFetcher.collectInventory: deep mode honors maxServers cap', async () => {
  const routes = makeStandardRoutes({
    servers: [
      { id: 1, url: '/v2/server/1' },
      { id: 2, url: '/v2/server/2' },
      { id: 3, url: '/v2/server/3' }
    ]
  });
  // Per-server stubs that respond for any id
  routes.push(
    { match: /\/server\/\d+$/, respond: (u) => {
        const id = Number(u.match(/\/server\/(\d+)$/)[1]);
        return jsonResponse({ id });
      }
    },
    { match: /\/server\/\d+\/agent_resource\?limit=/, respond: () => listResponse('agent_resource_list', []) },
    { match: /\/server\/\d+\/network_service\?limit=/, respond: () => listResponse('network_service_list', []) },
    { match: /\/server\/\d+\/attribute\?limit=/, respond: () => listResponse('server_attribute_list', []) }
  );
  const fetch = routeFetch(routes);
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const fetcher = new BpaFetcher({ client });
  const inv = await fetcher.collectInventory({ deep: true, maxServers: 2 });
  assert.deepEqual(Object.keys(inv.server_details).sort(), ['1', '2']);
});

test('BpaFetcher.collectInventory: AbortSignal abort halts collection', async () => {
  const ctl = new AbortController();
  let calls = 0;
  // Fail on /server_group? to make sure we hit /server first, then abort.
  const fetch = routeFetch([
    { match: /\/server\?limit=/, respond: () => {
        calls++;
        // Abort right after first request lands, before collection returns
        // and moves on to /server_group.
        ctl.abort();
        return listResponse('server_list', [{ id: 1 }]);
      }
    },
    { match: /\/server_group\?limit=/, respond: () => {
        calls++; return listResponse('server_group_list', []);
      }
    }
  ]);
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const fetcher = new BpaFetcher({ client, signal: ctl.signal });
  await assert.rejects(
    () => fetcher.collectInventory(),
    (err) => err.name === 'AbortError'
  );
  // We made the first call; the abort was checked before /server_group ran.
  assert.equal(calls, 1);
});

test('BpaFetcher.collectInventory: paginated active-outage logs are walked, capped at 50', async () => {
  // Synthesize 60 active outages; collector should pull logs for the first 50.
  const outages = Array.from({ length: 60 }, (_, i) => ({ id: 100 + i, active: true }));
  const routes = makeStandardRoutes({ outages });
  let logCalls = 0;
  routes.push({ match: /\/outage\/(\d+)\/log\?limit=/, respond: () => {
      logCalls++;
      return listResponse('outage_log_list', [{ event: 'check' }]);
    }
  });
  const fetch = routeFetch(routes);
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const fetcher = new BpaFetcher({ client });
  const inv = await fetcher.collectInventory();
  assert.equal(logCalls, 50);
  assert.equal(Object.keys(inv.outage_logs).length, 50);
  // First & last keyed by outage id
  assert.ok(inv.outage_logs['100']);
  assert.ok(inv.outage_logs['149']);
  assert.equal(inv.outage_logs['150'], undefined);
});

test('BpaFetcher.collectInventory: onProgress events fire for endpoint lifecycle', async () => {
  const events = [];
  const fetch = routeFetch(makeStandardRoutes());
  const client = new PanoptaClient({ apiKey: 'k', fetch });
  const fetcher = new BpaFetcher({ client, onProgress: (e) => events.push(e) });
  await fetcher.collectInventory();
  assert.ok(events[0].type === 'collect-start');
  assert.ok(events.at(-1).type === 'collect-done');
  // Every top-level list emits a start + done pair (no errors expected here).
  const startNames = events.filter((e) => e.type === 'endpoint-start').map((e) => e.name);
  const doneNames = events.filter((e) => e.type === 'endpoint-done').map((e) => e.name);
  for (const n of ['servers', 'server_groups', 'server_templates', 'outages']) {
    assert.ok(startNames.includes(n), `missing start for ${n}`);
    assert.ok(doneNames.includes(n), `missing done for ${n}`);
  }
});

test('BpaFetcher constructor rejects non-PanoptaClient inputs', () => {
  assert.throws(() => new BpaFetcher({}), /requires a PanoptaClient/);
  assert.throws(() => new BpaFetcher({ client: { getJson: () => {} } }), /requires a PanoptaClient/);
});
