import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BpaFrontendFetcher,
  parseEditUserData,
  parseMonitoringConfig,
  EDIT_USER_DATA_PATH,
  MONITORING_CONFIG_PATH
} from '../src/lib/bpa-frontend-fetcher.js';
import { createFetchMock } from './fixtures/chrome-mocks.js';

// JSON / HTML response helpers - chrome-mocks.js only ships json/error
// variants but we need explicit content-type control to exercise the
// auth-failure branch.
function jsonResponse(body, { status = 200 } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', 'application/json; charset=utf-8']]),
    async text() { return text; },
    async json() { return JSON.parse(text); }
  };
}
function htmlResponse(html, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', 'text/html; charset=utf-8']]),
    async text() { return html; },
    async json() { throw new Error('not json'); }
  };
}

// =============================================================================
// parseEditUserData
// =============================================================================

test('parseEditUserData: extracts last_login + created_on from the canonical shape', () => {
  // Real shape captured from production tenant 2026-05-01.
  const json = {
    success: true,
    data: {
      user_id: 308609,
      contact_id: 545434,
      config_data: {
        fullname: 'Greg Jenkins -TCSM',
        last_login: '2026-05-01 20:03 PDT',
        created_on: '2024-12-11 15:24 PST'
      }
    }
  };
  assert.deepEqual(parseEditUserData(json), {
    last_login: '2026-05-01 20:03 PDT',
    created_on: '2024-12-11 15:24 PST'
  });
});

test('parseEditUserData: returns nulls for absent fields, not the whole record', () => {
  const json = { success: true, data: { config_data: { fullname: 'X' } } };
  assert.deepEqual(parseEditUserData(json), { last_login: null, created_on: null });
});

test('parseEditUserData: returns null when shape is unrecognized', () => {
  assert.equal(parseEditUserData(null), null);
  assert.equal(parseEditUserData({}), null);
  assert.equal(parseEditUserData({ success: false }), null);
  assert.equal(parseEditUserData({ success: true }), null);
  assert.equal(parseEditUserData({ success: true, data: {} }), null);
});

// =============================================================================
// BpaFrontendFetcher.collect
// =============================================================================

/**
 * Build a v2-shaped user record with the user-id and contact-id explicitly
 * separated. The endpoint takes the CONTACT id; the result map is keyed
 * by the USER id so the analyzer's userKeyOf(u) lookup hits.
 */
function v2User({ userId, contactId, name = 'User' }) {
  return {
    id: userId,
    name,
    contact_info: [
      { url: `https://api2.panopta.com/v2/contact/${contactId}/contact_info/1` }
    ]
  };
}

function editUserDataJson({ contactId, lastLogin = '2026-05-01 20:03 PDT', createdOn = '2024-12-11 15:24 PST' }) {
  return {
    success: true,
    data: {
      user_id: 999,
      contact_id: Number(contactId),
      config_data: { fullname: `User ${contactId}`, last_login: lastLogin, created_on: createdOn }
    }
  };
}

test('BpaFrontendFetcher.collect: walks users and parses both fields', async () => {
  const fetch = createFetchMock(async (url) => {
    const m = url.match(/contact_id=(\d+)/);
    const id = m?.[1] ?? 'unknown';
    return jsonResponse(editUserDataJson({
      contactId: id,
      lastLogin: `c${id}-last`,
      createdOn: `c${id}-created`
    }));
  });
  const fetcher = new BpaFrontendFetcher({ fetch });
  const users = [
    v2User({ userId: 100, contactId: 500 }),
    v2User({ userId: 101, contactId: 501 }),
    v2User({ userId: 102, contactId: 502 })
  ];
  const result = await fetcher.collect(users);

  // Keyed by USER id; URL parameter was CONTACT id.
  assert.deepEqual(result.users, {
    '100': { last_login: 'c500-last', created_on: 'c500-created' },
    '101': { last_login: 'c501-last', created_on: 'c501-created' },
    '102': { last_login: 'c502-last', created_on: 'c502-created' }
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.stats.requests, 3);
  assert.equal(result.stats.total, 3);
  // Each request hit the get_edit_user_data path with credentials:'include'
  // and Accept: application/json.
  const urls = fetch.calls.map((c) => c.url);
  for (const c of fetch.calls) {
    assert.match(c.url, new RegExp(EDIT_USER_DATA_PATH));
    assert.equal(c.init.credentials, 'include');
    assert.match(c.init.headers.Accept ?? c.init.headers.accept ?? '', /json/);
  }
  assert.ok(urls.some((u) => /contact_id=500\b/.test(u)));
  // Critical: user id must NOT appear as the contact_id parameter.
  assert.ok(!urls.some((u) => /contact_id=100\b/.test(u)));
});

test('BpaFrontendFetcher.collect: records error and skips user with no contact_info', async () => {
  let calls = 0;
  const fetch = createFetchMock(async () => { calls++; return jsonResponse(editUserDataJson({ contactId: '9001' })); });
  const fetcher = new BpaFrontendFetcher({ fetch });
  const result = await fetcher.collect([
    { id: 1 },                                         // missing contact_info -> error, skip
    v2User({ userId: 2, contactId: 9001 })             // ok
  ]);
  assert.equal(calls, 1);
  assert.equal(Object.keys(result.users).length, 1);
  assert.ok(result.users['2']);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /user 1: no contact_info/);
});

test('BpaFrontendFetcher.collect: empty users list -> empty result, no requests', async () => {
  const fetch = createFetchMock(async () => jsonResponse(editUserDataJson({ contactId: '0' })));
  const fetcher = new BpaFrontendFetcher({ fetch });
  const result = await fetcher.collect([]);
  assert.deepEqual(result.users, {});
  assert.equal(result.errors.length, 0);
  assert.equal(result.stats.requests, 0);
  assert.equal(result.stats.total, 0);
});

test('BpaFrontendFetcher.collect: per-user 500 records error and continues', async () => {
  let n = 0;
  const fetch = createFetchMock(async () => {
    n++;
    if (n === 2) return jsonResponse('boom', { status: 500 });
    return jsonResponse(editUserDataJson({ contactId: '0' }));
  });
  const fetcher = new BpaFrontendFetcher({ fetch });
  const users = [
    v2User({ userId: 1, contactId: 1001 }),
    v2User({ userId: 2, contactId: 1002 }),
    v2User({ userId: 3, contactId: 1003 })
  ];
  const result = await fetcher.collect(users);
  assert.equal(Object.keys(result.users).length, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /user 2: HTTP 500/);
});

test('BpaFrontendFetcher.collect: HTML response on first user is fatal (auth failure)', async () => {
  // Unauthenticated FortiMonitor returns 200 + the SPA shell HTML
  // instead of JSON. The fetcher detects this via Content-Type and
  // converts it into a clear "session not detected" error.
  const fetch = createFetchMock(async () => htmlResponse('<!DOCTYPE html>...spa shell...'));
  const fetcher = new BpaFrontendFetcher({ fetch });
  await assert.rejects(
    () => fetcher.collect([
      v2User({ userId: 1, contactId: 1001 }),
      v2User({ userId: 2, contactId: 1002 })
    ]),
    /session not detected|FortiMonitor session/i
  );
});

test('BpaFrontendFetcher.collect: keys by user id even when only url is present', async () => {
  // v2 user records carry only `url`, not `id`. The result map must still
  // be keyed by the user id so the analyzer's userKeyOf lookup hits.
  const captured = [];
  const fetch = createFetchMock(async (url) => {
    captured.push(url);
    return jsonResponse(editUserDataJson({ contactId: '545434', lastLogin: 'L', createdOn: 'C' }));
  });
  const fetcher = new BpaFrontendFetcher({ fetch });
  const result = await fetcher.collect([
    {
      url: 'https://api2.panopta.com/v2/user/308609',
      contact_info: [{ url: 'https://api2.panopta.com/v2/contact/545434/contact_info/1' }]
    }
  ]);
  assert.equal(captured.length, 1);
  assert.match(captured[0], /contact_id=545434/);
  assert.deepEqual(result.users, {
    '308609': { last_login: 'L', created_on: 'C' }
  });
});

test('BpaFrontendFetcher.collect: respects AbortSignal', async () => {
  const ac = new AbortController();
  let calls = 0;
  const fetch = createFetchMock(async () => {
    calls++;
    if (calls === 1) ac.abort();
    return jsonResponse(editUserDataJson({ contactId: '0' }));
  });
  const fetcher = new BpaFrontendFetcher({ fetch, signal: ac.signal });
  await assert.rejects(
    () => fetcher.collect([
      v2User({ userId: 1, contactId: 1001 }),
      v2User({ userId: 2, contactId: 1002 }),
      v2User({ userId: 3, contactId: 1003 })
    ]),
    (err) => err.name === 'AbortError'
  );
});

// =============================================================================
// parseMonitoringConfig
// =============================================================================

test('parseMonitoringConfig: counts metrics + alerts and lists names (FMN-135)', () => {
  // Live shape from /report/get_monitoring_config_data, captured 2026-05-01.
  const json = {
    success: true,
    categories: {
      added: [
        {
          name: 'Linux: CPU',
          textkey: 'system.linux',
          metrics: [
            { id: -1, name: 'CPU % Used', alert_items: [['critical', 'CRITICAL', '...', 'greater than 90%', []]] },
            { id: -2, name: 'Load Average', alert_items: [] }
          ]
        },
        {
          name: 'Linux: Disk',
          textkey: 'system.linux',
          metrics: [
            { id: -3, name: 'Disk: % used', alert_items: [['critical', 'CRITICAL', '...', '>80%', []]] }
          ]
        }
      ],
      detected: []
    }
  };
  const r = parseMonitoringConfig(json);
  assert.equal(r.total_metrics, 3);
  assert.equal(r.alerts_count, 2);
  assert.deepEqual(r.metric_names, ['CPU % Used', 'Load Average', 'Disk: % used']);
  assert.deepEqual(r.metrics_without_alerts, ['Load Average']);
});

test('parseMonitoringConfig: returns null on unrecognized shape', () => {
  assert.equal(parseMonitoringConfig(null), null);
  assert.equal(parseMonitoringConfig({}), null);
  assert.equal(parseMonitoringConfig({ success: false }), null);
  assert.equal(parseMonitoringConfig({ success: true }), null);
  assert.equal(parseMonitoringConfig({ success: true, categories: {} }), null);
});

test('parseMonitoringConfig: empty categories yields zero counts (not null)', () => {
  const r = parseMonitoringConfig({ success: true, categories: { added: [] } });
  assert.deepEqual(r, { total_metrics: 0, alerts_count: 0, metric_names: [], metrics_without_alerts: [] });
});

// =============================================================================
// BpaFrontendFetcher.collectTemplateConfigs
// =============================================================================

function v2Template({ id, name = 'Template' }) {
  return { id, name, url: `https://api2.panopta.com/v2/server_template/${id}` };
}

function monitoringConfigJson({ id, totalMetrics = 1, alertsCount = 0 }) {
  const metrics = [];
  for (let i = 0; i < totalMetrics; i++) {
    metrics.push({
      id: -(id * 1000 + i),
      name: `metric_${id}_${i}`,
      alert_items: i < alertsCount ? [['critical', 'CRITICAL', '...', 'condition', []]] : []
    });
  }
  return {
    success: true,
    categories: {
      added: [{ name: 'Test', textkey: 'test', metrics }],
      detected: []
    }
  };
}

test('BpaFrontendFetcher.collectTemplateConfigs: walks templates and parses each (FMN-135)', async () => {
  const fetch = createFetchMock(async (url) => {
    const m = url.match(/server_id=(\d+)/);
    const id = parseInt(m?.[1] ?? '0', 10);
    return jsonResponse(monitoringConfigJson({
      id,
      totalMetrics: id === 1 ? 2 : 3,
      alertsCount: id === 1 ? 0 : 2
    }));
  });
  const fetcher = new BpaFrontendFetcher({ fetch });
  const result = await fetcher.collectTemplateConfigs([
    v2Template({ id: 1, name: 'Default-Looking' }),
    v2Template({ id: 2, name: 'Tuned' })
  ]);

  assert.equal(result.errors.length, 0);
  assert.equal(result.stats.total, 2);
  assert.equal(result.stats.requests, 2);
  assert.deepEqual(Object.keys(result.configs).sort(), ['1', '2']);
  assert.equal(result.configs['1'].total_metrics, 2);
  assert.equal(result.configs['1'].alerts_count, 0);
  assert.equal(result.configs['2'].total_metrics, 3);
  assert.equal(result.configs['2'].alerts_count, 2);
  // URL hits MONITORING_CONFIG_PATH with credentials:'include'.
  for (const c of fetch.calls) {
    assert.match(c.url, new RegExp(MONITORING_CONFIG_PATH));
    assert.equal(c.init.credentials, 'include');
  }
});

test('BpaFrontendFetcher.collectTemplateConfigs: keys by template url id when id is missing', async () => {
  const captured = [];
  const fetch = createFetchMock(async (url) => {
    captured.push(url);
    return jsonResponse(monitoringConfigJson({ id: 9999 }));
  });
  const fetcher = new BpaFrontendFetcher({ fetch });
  const result = await fetcher.collectTemplateConfigs([
    { url: 'https://api2.panopta.com/v2/server_template/9999', name: 'NoId' }
  ]);
  assert.match(captured[0], /server_id=9999/);
  assert.ok(result.configs['9999']);
});

test('BpaFrontendFetcher.collectTemplateConfigs: HTML response on first template is fatal', async () => {
  const fetch = createFetchMock(async () => htmlResponse('<!DOCTYPE html>...spa shell...'));
  const fetcher = new BpaFrontendFetcher({ fetch });
  await assert.rejects(
    () => fetcher.collectTemplateConfigs([
      v2Template({ id: 1 }),
      v2Template({ id: 2 })
    ]),
    /session not detected|FortiMonitor session/i
  );
});

test('BpaFrontendFetcher.collectTemplateConfigs: per-template 500 records error and continues', async () => {
  let n = 0;
  const fetch = createFetchMock(async () => {
    n++;
    if (n === 2) return jsonResponse('boom', { status: 500 });
    return jsonResponse(monitoringConfigJson({ id: n }));
  });
  const fetcher = new BpaFrontendFetcher({ fetch });
  const result = await fetcher.collectTemplateConfigs([
    v2Template({ id: 1 }),
    v2Template({ id: 2 }),
    v2Template({ id: 3 })
  ]);
  assert.equal(Object.keys(result.configs).length, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /template 2: HTTP 500/);
});
