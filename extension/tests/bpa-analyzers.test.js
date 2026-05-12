import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeIncidents,
  analyzeUsers,
  analyzeInstances,
  analyzeTemplates,
  analyzeMonitoringPolicy,
  runAllAnalyzers
} from '../src/lib/bpa-analyzers/index.js';
import { trendLabel, extractCheckType } from '../src/lib/bpa-analyzers/incident.js';
import {
  counter,
  mostCommon,
  parseTimestamp,
  extractTrailingId,
  userKeyOf,
  contactIdOf,
  deriveActiveAssessment
} from '../src/lib/bpa-analyzers/_helpers.js';

// =============================================================================
// _helpers
// =============================================================================

test('counter + mostCommon match Python Counter.most_common semantics', () => {
  const c = counter(['a', 'b', 'a', 'c', 'b', 'a']);
  assert.equal(c.get('a'), 3);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 1);
  const top = mostCommon(c, 2);
  assert.deepEqual(top, [{ key: 'a', count: 3 }, { key: 'b', count: 2 }]);
});

test('parseTimestamp handles ISO, ISO-Z, and space-separated forms', () => {
  assert.ok(parseTimestamp('2026-04-30T12:00:00Z') instanceof Date);
  assert.ok(parseTimestamp('2026-04-30T12:00:00') instanceof Date);
  assert.ok(parseTimestamp('2026-04-30 12:00:00') instanceof Date);
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp('not a date'), null);
});

test('extractTrailingId returns digit-string id from any v2-style url', () => {
  assert.equal(extractTrailingId('/v2/server/42024060'), '42024060');
  assert.equal(extractTrailingId('/v2/server/42024060/'), '42024060');
  assert.equal(extractTrailingId('not-a-url'), null);
});

test('userKeyOf prefers explicit id, falls back to /v2/user/{id} from url', () => {
  assert.equal(userKeyOf({ id: 42 }), '42');
  assert.equal(userKeyOf({ id: '42' }), '42');
  assert.equal(userKeyOf({ url: 'https://api2.panopta.com/v2/user/308609' }), '308609');
  assert.equal(userKeyOf({ resource_url: 'https://api2.panopta.com/v2/user/9999/' }), '9999');
  assert.equal(userKeyOf({}), null);
  assert.equal(userKeyOf(null), null);
});

test('contactIdOf parses contact_id from contact_info[].url', () => {
  // Real shape from /v2/user list response.
  const u = {
    contact_info: [
      { url: 'https://api2.panopta.com/v2/contact/545434/contact_info/527812' },
      { url: 'https://api2.panopta.com/v2/contact/545434/contact_info/527813' }
    ]
  };
  assert.equal(contactIdOf(u), '545434');
});

test('contactIdOf returns null when contact_info is missing or empty', () => {
  assert.equal(contactIdOf({}), null);
  assert.equal(contactIdOf({ contact_info: [] }), null);
  assert.equal(contactIdOf({ contact_info: [{ url: 'not-a-contact-url' }] }), null);
  assert.equal(contactIdOf(null), null);
});

test('deriveActiveAssessment buckets by age in days', () => {
  const now = Date.UTC(2026, 4, 1); // 2026-05-01
  // Active: <= 90 days
  assert.equal(deriveActiveAssessment('2026-04-01', now), 'Active');
  assert.equal(deriveActiveAssessment('2026-02-01', now), 'Active');
  // Stale: 91..365 days
  assert.equal(deriveActiveAssessment('2025-10-01', now), 'Stale');
  assert.equal(deriveActiveAssessment('2025-06-01', now), 'Stale');
  // Inactive: > 365 days
  assert.equal(deriveActiveAssessment('2024-12-01', now), 'Inactive');
  assert.equal(deriveActiveAssessment('2020-01-01', now), 'Inactive');
});

test('deriveActiveAssessment handles real EditUser format with TZ abbreviation', () => {
  const now = Date.UTC(2026, 4, 1);
  // FMN-135 capture format - day-precision parse drops the time + TZ.
  assert.equal(deriveActiveAssessment('2025-07-30 17:27 PDT', now), 'Stale');
});

test('deriveActiveAssessment classifies absent / unparseable', () => {
  assert.equal(deriveActiveAssessment(null), 'Never');
  assert.equal(deriveActiveAssessment(''), 'Never');
  assert.equal(deriveActiveAssessment(undefined), 'Never');
  assert.equal(deriveActiveAssessment('never'), 'Unknown');
  assert.equal(deriveActiveAssessment(42), 'Unknown');
});

// =============================================================================
// IncidentAnalyzer
// =============================================================================

test('analyzeIncidents: empty inventory yields zeros and empty lists', () => {
  const r = analyzeIncidents({});
  assert.equal(r.active_count, 0);
  assert.equal(r.resolved_count, 0);
  assert.deepEqual(r.top_by_instance, []);
  assert.deepEqual(r.top_by_type, []);
  assert.deepEqual(r.active_details, []);
  assert.deepEqual(r.noisy_metrics, []);
  assert.equal(r.trending.last_7d, 0);
  assert.equal(r.trending.week_trend, 'Stable');
});

test('analyzeIncidents: counts active vs resolved and ranks top instances', () => {
  const r = analyzeIncidents({
    outages: [
      { id: 1, server_name: 'fgvm-a', active: true,  severity: 'critical' },
      { id: 2, server_name: 'fgvm-a', active: false, severity: 'warning' },
      { id: 3, server_name: 'fgvm-b', active: false, severity: 'warning' },
      { id: 4, server: { name: 'fgvm-c' }, active: true,  severity: 'critical' },
      { id: 5, server: { name: 'fgvm-a' }, active: false, severity: 'warning' }
    ]
  });
  assert.equal(r.active_count, 2);
  assert.equal(r.resolved_count, 3);
  assert.equal(r.top_by_instance[0].key, 'fgvm-a');
  assert.equal(r.top_by_instance[0].count, 3);
  assert.equal(r.active_details.length, 2);
  assert.equal(r.active_details[0].server, 'fgvm-a');
  assert.equal(r.active_details[0].severity, 'critical');
  assert.equal(r.active_details[0].acknowledged, false);
});

test('analyzeIncidents: extractCheckType pulls from "Incident detected X (host)" pattern', () => {
  assert.equal(
    extractCheckType([{ description: 'Incident detected ICMP Ping (host.local)' }]),
    'ICMP Ping'
  );
  assert.equal(
    extractCheckType([{ description: 'detected something unusual on wan1.' }]),
    'wan1'
  );
  assert.equal(extractCheckType([]), null);
  assert.equal(extractCheckType([{ description: 'no pattern here' }]), null);
});

test('analyzeIncidents: top_by_type uses outage_logs when available, falls back to severity', () => {
  const r = analyzeIncidents({
    outages: [
      { id: 1, severity: 'critical' },                    // no log -> Critical
      { id: 2, severity: 'critical' },                    // no log -> Critical
      { id: 3, severity: 'warning' }                      // no log -> Warning
    ],
    outage_logs: {
      '1': [{ description: 'Incident detected SNMP Get (router-a)' }] // overrides
    }
  });
  const types = Object.fromEntries(r.top_by_type.map(({ key, count }) => [key, count]));
  assert.equal(types['SNMP Get'], 1);
  assert.equal(types['Critical'], 1);
  assert.equal(types['Warning'], 1);
});

test('analyzeIncidents: trendLabel thresholds', () => {
  assert.equal(trendLabel(0, 0), 'Stable');
  assert.equal(trendLabel(5, 0), 'New activity');
  assert.equal(trendLabel(150, 100), 'Up 50%');
  assert.equal(trendLabel(50, 100), 'Down 50%');
  assert.equal(trendLabel(110, 100), 'Stable');         // <=20% no trend
});

test('analyzeIncidents: noisy_metrics flags servers with frequent short-lived outages', () => {
  const start = '2026-04-30T12:00:00Z';
  const endShort = '2026-04-30T12:10:00Z';                // 10 min
  const endLong  = '2026-04-30T20:00:00Z';                // 8h
  const o = (server, start_time, end_time) => ({
    server_name: server, active: false, start_time, end_time
  });
  const r = analyzeIncidents({
    outages: [
      o('flappy', start, endShort),
      o('flappy', start, endShort),
      o('flappy', start, endLong),
      // 'stable' has 3 long outages: not flagged.
      o('stable', start, endLong),
      o('stable', start, endLong),
      o('stable', start, endLong)
    ]
  });
  const flappy = r.noisy_metrics.find((n) => n.server === 'flappy');
  assert.ok(flappy, 'flappy should be flagged');
  assert.equal(flappy.short_lived, 2);
  assert.match(flappy.recommendation, /flapping/);
  assert.equal(r.noisy_metrics.find((n) => n.server === 'stable'), undefined);
});

test('analyzeIncidents: trending extracts from outage_stats_*d', () => {
  const r = analyzeIncidents({
    outage_stats_7d:  { total: 10, by_severity: { critical: 3, warning: 7 } },
    outage_stats_30d: { total: 60, by_severity: { critical: 10, warning: 50 } },
    outage_stats_60d: { total: 120 }
  });
  assert.equal(r.trending.last_7d, 10);
  assert.equal(r.trending.last_30d, 60);
  assert.equal(r.trending.critical_7d, 3);
  assert.equal(r.trending.warning_7d, 7);
  assert.equal(r.trending.prior_month_est, 60);          // 120 - 60
  assert.equal(r.trending.month_change, 0);              // 60 vs 60
});

// =============================================================================
// UserAnalyzer
// =============================================================================

test('analyzeUsers: empty inventory', () => {
  const r = analyzeUsers({});
  assert.equal(r.total, 0);
  assert.equal(r.primary_user, null);
  assert.deepEqual(r.details, []);
  assert.deepEqual(r.issues, []);
});

test('analyzeUsers: builds detail rows, picks primary by contact methods, flags duplicates and no-contact', () => {
  const r = analyzeUsers({
    users: [
      { id: 1, name: 'Alice', email: 'a@x', created: '2024-01-01', contact_info: [{}, {}, {}] },
      { id: 2, display_name: 'Bob', email: 'b@x', created: '2025-06-01', contact_info: [{}] },
      { id: 3, name: 'Alice', username: 'alice2@x', created: '2024-03-01', contact_info: [] },
      { id: 4, name: 'Carol', email: 'c@x', created: '2026-04-01' }   // no contact_info field
    ]
  });
  assert.equal(r.total, 4);
  assert.equal(r.primary_user.name, 'Alice');             // most contact_methods
  assert.equal(r.primary_user.contact_methods, 3);
  // Sorted by created ASC -> first detail is the oldest.
  assert.equal(r.details[0].name, 'Alice');
  assert.equal(r.details[0].created, '2024-01-01');
  // FMN-135 follow-up (2026-05-01): the duplicate-name issue was dropped
  // (false positives in real tenants where multi-alias test users share
  // a display name). Only the no-contact-methods issue remains.
  assert.ok(!r.issues.some((s) => /duplicate user/i.test(s)),
    'duplicate-user issue should not be emitted');
  assert.ok(r.issues.some((s) => /2 user\(s\) have no contact methods/.test(s)));
  // FMN-143: with no frontend_user_data, last_login is empty.
  // Active assessment derives from last_login age - 'Never' when no value.
  // The viewer renders 'N/A' for empty last_login (no manual fallback).
  for (const d of r.details) {
    assert.equal(d.last_login, '');
    assert.equal(d.last_login_manual, undefined);
    assert.equal(d.created_on, '');
    assert.equal(d.active_assessment, 'Never');
  }
});

test('analyzeUsers: merges frontend_user_data when present (FMN-135)', () => {
  const r = analyzeUsers({
    users: [
      { id: 1, name: 'Alice', email: 'a@x', created: '2024-01-01', contact_info: [{}] },
      { id: 2, name: 'Bob',   email: 'b@x', created: '2024-02-01', contact_info: [{}] },
      { id: 3, name: 'Carol', email: 'c@x', created: '2024-03-01', contact_info: [{}] }
    ],
    frontend_user_data: {
      '1': { last_login: '2026-04-30 12:00 UTC', created_on: 'Jan 1, 2024' },
      // user 2 has no frontend datum
      '3': { last_login: null, created_on: 'Mar 1, 2024' }
    }
  });
  const byName = Object.fromEntries(r.details.map((d) => [d.name, d]));
  assert.equal(byName.Alice.last_login, '2026-04-30 12:00 UTC');
  assert.equal(byName.Alice.created_on, 'Jan 1, 2024');
  // Bob: no frontend datum. last_login empty (viewer renders 'N/A').
  assert.equal(byName.Bob.last_login, '');
  assert.equal(byName.Bob.created_on, '');
  // Carol: frontend datum exists but last_login is null.
  assert.equal(byName.Carol.last_login, '');
  assert.equal(byName.Carol.created_on, 'Mar 1, 2024');
  // FMN-143: last_login_manual flag was removed (no manual fallback).
  for (const d of r.details) {
    assert.equal(d.last_login_manual, undefined);
  }
});

test('analyzeUsers: keys frontend_user_data by userKeyOf, not raw u.id (FMN-135 QA)', () => {
  // v2 user records carry only `url`, no `id` field. The fetcher and
  // analyzer must agree on userKeyOf as the join key - if the analyzer
  // reads u.id directly (undefined for v2 records), every row falls back
  // to manual even when frontend_user_data is populated. This was the
  // production failure on 2026-05-01.
  const r = analyzeUsers({
    users: [
      {
        url: 'https://api2.panopta.com/v2/user/308609',
        display_name: 'Greg Jenkins',
        email: 'g@x',
        created: '2024-12-11',
        contact_info: [{ url: 'https://api2.panopta.com/v2/contact/545434/contact_info/1' }]
      }
    ],
    frontend_user_data: {
      '308609': { last_login: '2025-07-30 17:27 PDT', created_on: '2025-07-30 17:27 PDT' }
    }
  });
  assert.equal(r.details.length, 1);
  assert.equal(r.details[0].last_login, '2025-07-30 17:27 PDT');
  assert.equal(r.details[0].last_login_manual, undefined);
  assert.equal(r.details[0].created_on, '2025-07-30 17:27 PDT');
  assert.equal(r.details[0].id, '308609');
});

test('analyzeUsers: derives active_assessment from last_login age (FMN-135)', () => {
  const now = Date.UTC(2026, 4, 1); // 2026-05-01
  // Pin "now" by making each last_login relative. We can't pass `now` in,
  // but Date.now() at test execution will be close to the actual present;
  // pick last_login dates with very wide separations so the bucketing is
  // stable regardless of the precise present.
  const r = analyzeUsers({
    users: [
      { id: 'a', name: 'Recent',  contact_info: [{}], created: '2024-01-01' },
      { id: 'b', name: 'Stale',   contact_info: [{}], created: '2024-01-01' },
      { id: 'c', name: 'Ancient', contact_info: [{}], created: '2024-01-01' },
      { id: 'd', name: 'Never',   contact_info: [{}], created: '2024-01-01' }
    ],
    frontend_user_data: {
      // Within ~30 days of any plausible "now" -> Active
      'a': { last_login: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), created_on: '' },
      // ~180 days back -> Stale
      'b': { last_login: new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10), created_on: '' },
      // ~500 days back -> Inactive
      'c': { last_login: new Date(Date.now() - 500 * 86400000).toISOString().slice(0, 10), created_on: '' },
      // Null login -> Never
      'd': { last_login: null, created_on: '' }
    }
  });
  const byName = Object.fromEntries(r.details.map((d) => [d.name, d]));
  assert.equal(byName.Recent.active_assessment, 'Active');
  assert.equal(byName.Stale.active_assessment, 'Stale');
  assert.equal(byName.Ancient.active_assessment, 'Inactive');
  assert.equal(byName.Never.active_assessment, 'Never');
  void now;
});

// =============================================================================
// InstanceAnalyzer
// =============================================================================

test('analyzeInstances: without server_resources returns available:false', () => {
  const r = analyzeInstances({});
  assert.equal(r.available, false);
  assert.match(r.note, /deep mode/i);
});

test('analyzeInstances: missing_settings flags peers in same template group', () => {
  // Three servers share template /v2/server_template/9.
  // Two of them collect "CPU" + "Memory"; the third is missing "Memory".
  const inv = {
    servers: [
      { id: 1, name: 'A', server_template: '/v2/server_template/9' },
      { id: 2, name: 'B', server_template: '/v2/server_template/9' },
      { id: 3, name: 'C', server_template: '/v2/server_template/9' }
    ],
    server_resources: {
      '1': [
        { id: 11, agent_resource_type: { name: 'CPU' } },
        { id: 12, agent_resource_type: { name: 'Memory' } }
      ],
      '2': [
        { id: 21, agent_resource_type: { name: 'CPU' } },
        { id: 22, agent_resource_type: { name: 'Memory' } }
      ],
      '3': [
        { id: 31, agent_resource_type: { name: 'CPU' } }
        // Missing Memory.
      ]
    },
    server_resource_details: {
      // None of the resources have thresholds set.
      '1': { '11': {}, '12': {} },
      '2': { '21': {}, '22': {} },
      '3': { '31': {} }
    }
  };
  const r = analyzeInstances(inv);
  assert.equal(r.available, true);
  // FMN-135 follow-up #4 (2026-05-02): findings now carry server_id +
  // server_name as separate fields with 'n/a' fallback. C has both id=3
  // and name='C', so server_name is 'C' here.
  const cMissing = r.missing_settings.find((f) => f.server_name === 'C' && f.missing === 'Memory');
  assert.ok(cMissing, 'expected C to be flagged as missing Memory');
  assert.equal(cMissing.server_id, '3');
  assert.equal(cMissing.type, 'Resource');
});

test('analyzeInstances: server_id and server_name use n/a fallback when either is missing (FMN-135 #4)', () => {
  // Three peers share a template - one has only an id (no name/fqdn).
  // The other two have both. The "missing" detection still works; the
  // ambiguity is only in how the row identifies the server.
  const inv = {
    servers: [
      { id: 1, name: 'Alpha', server_template: '/v2/server_template/9' },
      { id: 2, name: 'Beta',  server_template: '/v2/server_template/9' },
      { id: 3,                server_template: '/v2/server_template/9' }   // no name, no fqdn
    ],
    server_resources: {
      '1': [{ id: 11, agent_resource_type: { name: 'CPU' } }, { id: 12, agent_resource_type: { name: 'Memory' } }],
      '2': [{ id: 21, agent_resource_type: { name: 'CPU' } }, { id: 22, agent_resource_type: { name: 'Memory' } }],
      '3': [{ id: 31, agent_resource_type: { name: 'CPU' } }]                // missing Memory
    },
    server_resource_details: {
      '1': { '11': {}, '12': {} },
      '2': { '21': {}, '22': {} },
      '3': { '31': {} }
    }
  };
  const r = analyzeInstances(inv);
  const finding = r.missing_settings.find((f) => f.server_id === '3' && f.missing === 'Memory');
  assert.ok(finding, 'expected server id 3 flagged for missing Memory');
  assert.equal(finding.server_id, '3');
  assert.equal(finding.server_name, 'n/a');
});

test('analyzeInstances: valueless_metrics flags resources without thresholds', () => {
  const inv = {
    servers: [{ id: 1, name: 'A' }],
    server_resources: {
      '1': [
        { id: 10, agent_resource_type: { name: 'CPU' } },
        { id: 11, agent_resource_type: { name: 'Memory' } },
        { id: 12, agent_resource_type: { name: 'Disk' } }
      ]
    },
    server_resource_details: {
      '1': {
        '10': { agent_resource_threshold: [{ warning: 80, critical: 90 }] },
        '11': { agent_resource_threshold: [] },           // valueless
        '12': {}                                          // valueless
      }
    }
  };
  const r = analyzeInstances(inv);
  const metrics = r.valueless_metrics.map((f) => f.metric).sort();
  assert.deepEqual(metrics, ['Disk', 'Memory']);
  // Recommendation now points at the FortiMonitor InstanceDetails URL +
  // Monitoring Config tab so the operator has a copy-pasteable workflow
  // (FMN-135 follow-up #3, 2026-05-02).
  for (const f of r.valueless_metrics) {
    assert.match(f.recommendation, /Monitoring Config/);
    assert.match(f.recommendation, /InstanceDetails\?server_id=1/);
  }
});

test('analyzeInstances: valueless_metrics resolves agent_resource_type URL via catalog (FMN-135 #3)', () => {
  // Real /v2/server/{sid}/agent_resource responses carry agent_resource_type
  // as a URL string, not an object. The analyzer must look the id up in
  // the inventory.agent_resource_types catalog and render a friendly
  // "Category: Label (unit)" string instead of the raw API URL.
  const inv = {
    servers: [{ id: 1, name: 'A' }],
    agent_resource_types: [
      {
        url: 'https://api2.panopta.com/v2/agent_resource_type/465',
        category: 'Apache', label: 'Requests/sec', unit: 'reqs/s', platform: 'Linux'
      },
      {
        url: 'https://api2.panopta.com/v2/agent_resource_type/100',
        category: 'System', label: 'CPU % Used', unit: '%', platform: 'Linux'
      }
    ],
    server_resources: {
      '1': [
        { id: 50, agent_resource_type: 'https://api2.panopta.com/v2/agent_resource_type/465' },
        { id: 51, agent_resource_type: 'https://api2.panopta.com/v2/agent_resource_type/100' },
        { id: 52, agent_resource_type: 'https://api2.panopta.com/v2/agent_resource_type/9999' } // unknown id
      ]
    },
    server_resource_details: {
      '1': {
        '50': { agent_resource_threshold: [] },
        '51': { agent_resource_threshold: [] },
        '52': { agent_resource_threshold: [] }
      }
    }
  };
  const r = analyzeInstances(inv);
  const metrics = r.valueless_metrics.map((f) => f.metric).sort();
  // 465 -> "Apache: Requests/sec (reqs/s)"
  // 100 -> "System: CPU % Used (%)"
  // 9999 -> falls back to "Resource #52" (unknown id, no catalog hit)
  assert.deepEqual(metrics, [
    'Apache: Requests/sec (reqs/s)',
    'Resource #52',
    'System: CPU % Used (%)'
  ]);
});

// =============================================================================
// TemplateAnalyzer
// =============================================================================

test('analyzeTemplates: without template_monitoring_configs returns available:false', () => {
  const r = analyzeTemplates({});
  assert.equal(r.available, false);
});

// FMN-135 follow-up (2026-05-01): the analyzer now reads metric+threshold
// data from `template_monitoring_configs` (BpaFrontendFetcher) rather
// than the metadata-only /v2/server_template/{id} response. These
// fixtures mirror the parseMonitoringConfig output shape:
//   { total_metrics, alerts_count, metric_names, metrics_without_alerts }

test('analyzeTemplates: default_only_templates flags templates with metrics but zero alert thresholds (FMN-135)', () => {
  const r = analyzeTemplates({
    server_templates: [
      { id: 1, name: 'Default Linux' },
      { id: 2, name: 'Custom Linux' },
      { id: 3, name: 'Empty Template' }
    ],
    template_monitoring_configs: {
      // metrics defined but no alerts -> default-only
      '1': { total_metrics: 2, alerts_count: 0, metric_names: ['CPU', 'Memory'], metrics_without_alerts: ['CPU', 'Memory'] },
      // metrics with alerts -> NOT flagged
      '2': { total_metrics: 1, alerts_count: 1, metric_names: ['CPU'], metrics_without_alerts: [] },
      // empty template -> NOT flagged
      '3': { total_metrics: 0, alerts_count: 0, metric_names: [], metrics_without_alerts: [] }
    }
  });
  const names = r.default_only_templates.map((t) => t.template);
  assert.deepEqual(names, ['Default Linux']);
});

test('analyzeTemplates: manual_threshold_candidates groups identical thresholds across servers (deep mode)', () => {
  const inv = {
    // Forces analyzer to run by providing template configs.
    template_monitoring_configs: { '0': { total_metrics: 0, alerts_count: 0, metric_names: [], metrics_without_alerts: [] } },
    server_templates: [{ id: 0, name: 'tmpl' }],
    servers: Array.from({ length: 4 }, (_, i) => ({ id: i + 1, name: `s${i + 1}` })),
    server_resource_details: {
      '1': { '10': { agent_resource_type: { name: 'CPU' }, agent_resource_threshold: [{ warning: 80, critical: 90 }] } },
      '2': { '20': { agent_resource_type: { name: 'CPU' }, agent_resource_threshold: [{ warning: 80, critical: 90 }] } },
      '3': { '30': { agent_resource_type: { name: 'CPU' }, agent_resource_threshold: [{ warning: 80, critical: 90 }] } },
      '4': { '40': { agent_resource_type: { name: 'CPU' }, agent_resource_threshold: [{ warning: 70, critical: 85 }] } }  // distinct, count=1, won't qualify
    }
  };
  const r = analyzeTemplates(inv);
  const candidates = r.manual_threshold_candidates;
  const cpuPattern = candidates.find((c) => c.metric_type === 'CPU' && c.warning_threshold === 80);
  assert.ok(cpuPattern, 'should find the (CPU, 80, 90) pattern');
  assert.equal(cpuPattern.server_count, 3);
  assert.match(cpuPattern.example_servers, /s1.*s2.*s3/);
});

test('analyzeTemplates: cleanup_candidates flags templates >=50% unalerted (FMN-135)', () => {
  const r = analyzeTemplates({
    server_templates: [
      { id: 1, name: 'Mostly Default' },
      { id: 2, name: 'All Tuned' },
      { id: 3, name: 'No Alerts At All' }
    ],
    template_monitoring_configs: {
      // 3 metrics, 1 alerted -> 2/3 unalerted -> >=50% -> flag
      '1': { total_metrics: 3, alerts_count: 1, metric_names: ['CPU', 'Memory', 'Disk'], metrics_without_alerts: ['CPU', 'Memory'] },
      // every metric alerted -> NOT flagged
      '2': { total_metrics: 2, alerts_count: 2, metric_names: ['CPU', 'Memory'], metrics_without_alerts: [] },
      // zero alerts -> handled by default_only, NOT cleanup
      '3': { total_metrics: 4, alerts_count: 0, metric_names: ['A','B','C','D'], metrics_without_alerts: ['A','B','C','D'] }
    }
  });
  const flagged = r.cleanup_candidates.map((c) => c.template);
  assert.deepEqual(flagged, ['Mostly Default']);
});

test('analyzeTemplates: default templates are exempt from default_only / cleanup / overlap (FMN-135 follow-up)', () => {
  // Templates 1 and 2 belong to "Default Monitoring Templates" - they
  // must NOT appear in default_only / cleanup / overlapping even when
  // their config matches those criteria. Template 3 is custom and
  // should be flagged as default-only.
  const r = analyzeTemplates({
    server_templates: [
      { id: 1, name: 'Stock Linux',  server_group: 'https://api2.panopta.com/v2/server_group/100' },
      { id: 2, name: 'Stock Windows', server_group: 'https://api2.panopta.com/v2/server_group/100' },
      { id: 3, name: 'Custom Linux', server_group: 'https://api2.panopta.com/v2/server_group/200' }
    ],
    server_group_details: {
      '100': { id: 100, name: 'Default Monitoring Templates' },
      '200': { id: 200, name: 'tenant-templates' }
    },
    template_monitoring_configs: {
      '1': { total_metrics: 5, alerts_count: 0, metric_names: ['CPU', 'Memory', 'Disk', 'Network', 'Uptime'], metrics_without_alerts: ['CPU', 'Memory', 'Disk', 'Network', 'Uptime'] },
      '2': { total_metrics: 5, alerts_count: 0, metric_names: ['CPU', 'Memory', 'Disk', 'Network', 'Uptime'], metrics_without_alerts: ['CPU', 'Memory', 'Disk', 'Network', 'Uptime'] },
      '3': { total_metrics: 2, alerts_count: 0, metric_names: ['CustomA', 'CustomB'], metrics_without_alerts: ['CustomA', 'CustomB'] }
    }
  });
  // Custom default-only fires; stock defaults do not.
  const flaggedDefaultOnly = r.default_only_templates.map((t) => t.template);
  assert.deepEqual(flaggedDefaultOnly, ['Custom Linux']);
  // Stock default templates would have overlapped (Jaccard 1.0) but are
  // exempt from overlap analysis.
  assert.equal(r.overlapping_templates.length, 0);
  // Defaults appear in the dedicated section, sorted by name.
  const defaults = r.default_templates.map((t) => t.template);
  assert.deepEqual(defaults, ['Stock Linux', 'Stock Windows']);
  // Recommendation steers toward custom templates.
  for (const d of r.default_templates) {
    assert.match(d.recommendation, /custom template/i);
  }
});

test('analyzeTemplates: default templates with alerts get a different recommendation tone', () => {
  const r = analyzeTemplates({
    server_templates: [
      { id: 1, name: 'Stock Tuned', server_group: 'https://api2.panopta.com/v2/server_group/100' }
    ],
    server_group_details: {
      '100': { id: 100, name: 'Default Monitoring Templates' }
    },
    template_monitoring_configs: {
      '1': { total_metrics: 4, alerts_count: 3, metric_names: ['A','B','C','D'], metrics_without_alerts: ['D'] }
    }
  });
  assert.equal(r.default_templates.length, 1);
  // Should mention the partial coverage and recommend custom-template
  // approach rather than continuing to edit the stock one.
  assert.match(r.default_templates[0].recommendation, /3 of 4|custom template/i);
});

test('analyzeTemplates: overlapping_templates flags Jaccard >= 0.6 (FMN-135)', () => {
  const r = analyzeTemplates({
    server_templates: [
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
      { id: 3, name: 'C' }
    ],
    template_monitoring_configs: {
      '1': { total_metrics: 3, alerts_count: 0, metric_names: ['CPU', 'Memory', 'Disk'], metrics_without_alerts: ['CPU', 'Memory', 'Disk'] },
      '2': { total_metrics: 4, alerts_count: 0, metric_names: ['CPU', 'Memory', 'Disk', 'Network'], metrics_without_alerts: ['CPU', 'Memory', 'Disk', 'Network'] },
      '3': { total_metrics: 2, alerts_count: 0, metric_names: ['IPMI', 'Power'], metrics_without_alerts: ['IPMI', 'Power'] }
    }
  });
  const ab = r.overlapping_templates.find(
    (o) => (o.template_1 === 'A' && o.template_2 === 'B') ||
           (o.template_1 === 'B' && o.template_2 === 'A')
  );
  assert.ok(ab, 'A vs B should overlap');
  assert.equal(ab.shared_metrics, 3);
  // FMN-147: rows now carry both template IDs so the viewer can link
  // to the FortiMonitor template-edit page.
  const ids = new Set([String(ab.id_1), String(ab.id_2)]);
  assert.deepEqual([...ids].sort(), ['1', '2']);
  // template_1 / id_1 are aligned (same template) - i.e. swapping
  // template_1 with id_1 stays consistent, not crossed.
  if (ab.template_1 === 'A') assert.equal(String(ab.id_1), '1');
  else assert.equal(String(ab.id_1), '2');
  // No A-vs-C or B-vs-C overlap.
  assert.equal(r.overlapping_templates.length, 1);
});

// =============================================================================
// MonitoringPolicyAnalyzer
// =============================================================================

test('analyzeMonitoringPolicy: empty inventory returns three empty arrays', () => {
  const r = analyzeMonitoringPolicy({});
  assert.deepEqual(r.naming_patterns, []);
  assert.deepEqual(r.group_template_mapping, []);
  assert.deepEqual(r.automation_rules, []);
});

test('analyzeMonitoringPolicy: detects shared naming patterns across >=3 servers', () => {
  const r = analyzeMonitoringPolicy({
    servers: [
      { name: 'fgvm-prod-01' }, { name: 'fgvm-prod-02' }, { name: 'fgvm-prod-03' },
      { name: 'switch-prod-01' }
    ]
  });
  const patterns = r.naming_patterns.map((p) => p.pattern);
  // PROD appears 4 times; FGVM appears 3 times.
  assert.ok(patterns.includes('*PROD*'));
  assert.ok(patterns.includes('*FGVM*'));
});

test('analyzeMonitoringPolicy: group_template_mapping flags groups without templates', () => {
  const r = analyzeMonitoringPolicy({
    server_group_details: {
      '1': { name: 'Prod', server_template: { name: 'Linux' }, server_list: [{ id: 1 }, { id: 2 }] },
      '2': { name: 'Dev',  server_list: [{ id: 3 }] }     // no template
    }
  });
  const dev = r.group_template_mapping.find((g) => g.group === 'Dev');
  assert.equal(dev.has_template, false);
  assert.match(dev.recommendation, /Assign a monitoring template/);
  assert.equal(dev.member_count, 1);
});

test('analyzeMonitoringPolicy: automation_rules suggests rules for ungrouped servers, untemplated groups, shared FQDN domains', () => {
  const r = analyzeMonitoringPolicy({
    servers: [
      { id: 1, name: 'a', fqdn: 'a.example.com' },
      { id: 2, name: 'b', fqdn: 'b.example.com' },
      { id: 3, name: 'c', fqdn: 'c.example.com' },
      { id: 4, name: 'orphan' }                            // not in any group
    ],
    server_group_details: {
      '1': {
        name: 'Prod',
        server_list: [{ id: 1 }, { id: 2 }, { id: 3 }]
        // no server_template -> Rule 2 fires
      }
    }
  });
  const rules = r.automation_rules.map((rr) => rr.rule);
  assert.ok(rules.some((s) => /Auto-assign ungrouped/.test(s)));
  assert.ok(rules.some((s) => /Auto-apply templates/.test(s)));
  assert.ok(rules.some((s) => /example\.com/.test(s)));
});

// =============================================================================
// runAllAnalyzers
// =============================================================================

test('runAllAnalyzers: returns the 6-key combined shape (FMN-156 added noise)', () => {
  const r = runAllAnalyzers({});
  assert.deepEqual(Object.keys(r).sort(), [
    'incidents', 'instances', 'monitoring_policy', 'noise', 'templates', 'users'
  ]);
});

test('runAllAnalyzers: each analyzer is a pure function (no inventory mutation)', () => {
  const inv = {
    servers: [{ id: 1, name: 'srv', server_template: '/v2/server_template/9' }],
    outages: [{ id: 1, server_name: 'srv', active: true }],
    users: [{ id: 1, name: 'u', contact_info: [] }],
    server_template_details: { '1': { name: 't' } }
  };
  const before = JSON.parse(JSON.stringify(inv));
  runAllAnalyzers(inv);
  assert.deepEqual(inv, before);
});

test('runAllAnalyzers: ["all"] selection runs every analyzer (FMN-149, FMN-156)', () => {
  const r = runAllAnalyzers({}, { sections: ['all'] });
  assert.deepEqual(Object.keys(r).sort(), [
    'incidents', 'instances', 'monitoring_policy', 'noise', 'templates', 'users'
  ]);
});

test('runAllAnalyzers: single-section selection produces only that result key (FMN-149)', () => {
  const r = runAllAnalyzers({}, { sections: ['user-activity'] });
  assert.deepEqual(Object.keys(r), ['users']);
});

test('runAllAnalyzers: skipped result keys are absent, not empty (FMN-149)', () => {
  const r = runAllAnalyzers({}, { sections: ['user-activity'] });
  assert.equal('users' in r, true);
  assert.equal('incidents' in r, false);
  assert.equal('instances' in r, false);
  assert.equal('templates' in r, false);
  assert.equal('monitoring_policy' in r, false);
});

test('runAllAnalyzers: multi-section selection runs each requested analyzer (FMN-149)', () => {
  const r = runAllAnalyzers({}, { sections: ['template-recommendations', 'monitoring-policy'] });
  assert.deepEqual(Object.keys(r).sort(), ['monitoring_policy', 'templates']);
});
