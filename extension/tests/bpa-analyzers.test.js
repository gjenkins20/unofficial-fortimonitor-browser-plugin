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
import { counter, mostCommon, parseTimestamp, extractTrailingId } from '../src/lib/bpa-analyzers/_helpers.js';

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
  // Issues: duplicate Alice (case-insensitive collapse), and 2 users with 0 contact methods.
  assert.ok(r.issues.some((s) => /duplicate user.*alice/i.test(s)));
  assert.ok(r.issues.some((s) => /2 user\(s\) have no contact methods/.test(s)));
  // FMN-135: with no frontend_user_data, last_login is empty and remains
  // an engineer-fillable manual annotation.
  for (const d of r.details) {
    assert.equal(d.last_login, '');
    assert.equal(d.last_login_manual, true);
    assert.equal(d.created_on, '');
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
  assert.equal(byName.Alice.last_login_manual, false);
  assert.equal(byName.Alice.created_on, 'Jan 1, 2024');
  // Bob falls back to manual since no frontend datum was provided.
  assert.equal(byName.Bob.last_login, '');
  assert.equal(byName.Bob.last_login_manual, true);
  assert.equal(byName.Bob.created_on, '');
  // Carol: frontend datum exists but last_login is null - manual fallback.
  assert.equal(byName.Carol.last_login, '');
  assert.equal(byName.Carol.last_login_manual, true);
  assert.equal(byName.Carol.created_on, 'Mar 1, 2024');
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
  const cMissing = r.missing_settings.find((f) => f.server === 'C' && f.missing === 'Memory');
  assert.ok(cMissing, 'expected C to be flagged as missing Memory');
  assert.equal(cMissing.type, 'Resource');
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
});

// =============================================================================
// TemplateAnalyzer
// =============================================================================

test('analyzeTemplates: without server_template_details returns available:false', () => {
  const r = analyzeTemplates({});
  assert.equal(r.available, false);
});

test('analyzeTemplates: default_only_templates flags templates that include metrics but no thresholds', () => {
  const r = analyzeTemplates({
    server_template_details: {
      '1': {
        name: 'Default Linux',
        agent_resource_type: [
          { name: 'CPU', agent_resource_threshold: [] },
          { name: 'Memory' }
        ]
      },
      '2': {
        name: 'Custom Linux',
        agent_resource_type: [
          { name: 'CPU', agent_resource_threshold: [{ warning: 80 }] }
        ]
      },
      '3': { name: 'Empty Template' }                     // no metrics; should NOT flag
    }
  });
  const names = r.default_only_templates.map((t) => t.template);
  assert.deepEqual(names, ['Default Linux']);
});

test('analyzeTemplates: manual_threshold_candidates groups identical thresholds across servers', () => {
  const inv = {
    server_template_details: { '0': { name: 'tmpl' } },   // forces analyzer to run
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

test('analyzeTemplates: cleanup_candidates flags templates >=50% unchanged', () => {
  const r = analyzeTemplates({
    server_template_details: {
      '1': {
        name: 'Mostly Default',
        agent_resource_type: [
          { name: 'CPU', agent_resource_threshold: [] },
          { name: 'Memory', agent_resource_threshold: [] },
          { name: 'Disk', agent_resource_threshold: [{ warning: 90 }] }
        ]
      },
      '2': {
        name: 'All Tuned',
        agent_resource_type: [
          { name: 'CPU', agent_resource_threshold: [{ warning: 80 }] },
          { name: 'Memory', agent_resource_threshold: [{ warning: 85 }] }
        ]
      }
    }
  });
  const flagged = r.cleanup_candidates.map((c) => c.template);
  assert.deepEqual(flagged, ['Mostly Default']);
});

test('analyzeTemplates: overlapping_templates flags Jaccard >= 0.6', () => {
  const r = analyzeTemplates({
    server_template_details: {
      '1': {
        name: 'A',
        agent_resource_type: [{ name: 'CPU' }, { name: 'Memory' }, { name: 'Disk' }]
      },
      '2': {
        name: 'B',
        agent_resource_type: [{ name: 'CPU' }, { name: 'Memory' }, { name: 'Disk' }, { name: 'Network' }]
      },
      '3': {
        name: 'C',
        agent_resource_type: [{ name: 'IPMI' }, { name: 'Power' }]   // disjoint from A/B
      }
    }
  });
  const ab = r.overlapping_templates.find(
    (o) => (o.template_1 === 'A' && o.template_2 === 'B') ||
           (o.template_1 === 'B' && o.template_2 === 'A')
  );
  assert.ok(ab, 'A vs B should overlap');
  assert.equal(ab.shared_metrics, 3);
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

test('runAllAnalyzers: returns the 5-key combined shape FMN-133 expects', () => {
  const r = runAllAnalyzers({});
  assert.deepEqual(Object.keys(r).sort(), [
    'incidents', 'instances', 'monitoring_policy', 'templates', 'users'
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
