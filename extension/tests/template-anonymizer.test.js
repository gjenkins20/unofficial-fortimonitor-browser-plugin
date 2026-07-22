// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-298: template-anonymizer tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anonymizeTemplateInventory,
  assertAnonymizedInventory,
  TemplateAnonymizeError
} from '../src/lib/template-anonymizer.js';
import { analyzeTemplates } from '../src/lib/observation-analyzers/template.js';

// Realistic slice: two custom templates (one default-only, one cleanup
// candidate) sharing every metric name (so they overlap), plus one stock
// template in the "Default Monitoring Templates" group. Tags + metric names
// deliberately carry client identifiers to prove they never survive.
function makeSlice() {
  return {
    server_group_details: {
      '10': { name: 'Default Monitoring Templates' },
      '20': { name: 'Acme Production Sites' }
    },
    server_templates: [
      {
        id: '100', name: 'Acme FGT Edge', template_type: 'fabric_template',
        server_group: '/v2/server_group/20/', tags: ['client:acme', 'site:hq'],
        applied_servers: ['/v2/server/1', '/v2/server/2']
      },
      {
        id: '101', name: 'Acme FGT Core', template_type: 'fabric_template',
        server_group: '/v2/server_group/20/', tags: ['client:acme'],
        applied_servers: ['/v2/server/3']
      },
      {
        id: '200', name: 'FortiGate', template_type: 'fabric_template',
        server_group: '/v2/server_group/10/', tags: [], applied_servers: []
      }
    ],
    template_monitoring_configs: {
      '100': {
        total_metrics: 4, alerts_count: 0,
        metric_names: ['CPU Usage', 'Memory', 'Interface WAN-AcmeHQ bw', 'Session Count'],
        metrics_without_alerts: ['CPU Usage', 'Memory', 'Interface WAN-AcmeHQ bw', 'Session Count']
      },
      '101': {
        total_metrics: 4, alerts_count: 2,
        metric_names: ['CPU Usage', 'Memory', 'Interface WAN-AcmeHQ bw', 'Session Count'],
        metrics_without_alerts: ['Interface WAN-AcmeHQ bw', 'Session Count']
      },
      '200': {
        total_metrics: 5, alerts_count: 3,
        metric_names: ['CPU', 'Mem', 'Disk', 'Uptime', 'Temp'],
        metrics_without_alerts: ['Disk', 'Temp']
      }
    }
  };
}

test('tokenizes template + group names and synthetic ids', () => {
  const { inventory, tokenMap } = anonymizeTemplateInventory(makeSlice());
  assert.deepEqual(inventory.server_templates.map((t) => t.name).sort(), ['Template 1', 'Template 2', 'Template 3']);
  assert.deepEqual(inventory.server_templates.map((t) => t.id).sort(), ['1', '2', '3']);
  assert.deepEqual([...tokenMap.templates.keys()].sort(), ['100', '101', '200']);
  for (const t of inventory.server_templates) assert.match(t.server_group, /^\/server_group\/\d+$/);
});

test('drops tags, applied_servers, url, template_type (whitelist by construction)', () => {
  const { inventory } = anonymizeTemplateInventory(makeSlice());
  for (const t of inventory.server_templates) {
    for (const k of ['tags', 'applied_servers', 'url', 'template_type']) {
      assert.equal(k in t, false, `template must not carry "${k}"`);
    }
    assert.deepEqual(Object.keys(t).sort(), ['id', 'name', 'server_group']);
  }
});

test('preserves metric/alert counts verbatim', () => {
  const { inventory, tokenMap } = anonymizeTemplateInventory(makeSlice());
  const c100 = inventory.template_monitoring_configs[tokenMap.templates.get('100')];
  const c200 = inventory.template_monitoring_configs[tokenMap.templates.get('200')];
  assert.equal(c100.total_metrics, 4);
  assert.equal(c100.alerts_count, 0);
  assert.equal(c200.total_metrics, 5);
  assert.equal(c200.alerts_count, 3);
});

test('preserves the stock-group name so the analyzer exemption still fires', () => {
  const { inventory, tokenMap } = anonymizeTemplateInventory(makeSlice());
  const stockGid = tail(inventory.server_templates.find((t) => t.id === tokenMap.templates.get('200')).server_group);
  assert.equal(inventory.server_group_details[stockGid].name, 'Default Monitoring Templates');
  const custGid = tail(inventory.server_templates.find((t) => t.id === tokenMap.templates.get('100')).server_group);
  assert.match(inventory.server_group_details[custGid].name, /^Group \d+$/);
});

test('metric names become opaque tokens, consistent across templates', () => {
  const { inventory, tokenMap } = anonymizeTemplateInventory(makeSlice());
  const c100 = inventory.template_monitoring_configs[tokenMap.templates.get('100')];
  const c101 = inventory.template_monitoring_configs[tokenMap.templates.get('101')];
  for (const nm of c100.metric_names) assert.match(nm, /^m\d+$/);
  // "CPU Usage" appears in both templates -> SAME token in both (global map).
  const cpuTok = tokenMap.metrics.get('CPU Usage');
  assert.ok(c100.metric_names.includes(cpuTok));
  assert.ok(c101.metric_names.includes(cpuTok));
  // metrics_without_alerts uses the same token space.
  const wanTok = tokenMap.metrics.get('Interface WAN-AcmeHQ bw');
  assert.ok(c101.metrics_without_alerts.includes(wanTok));
});

test('LEAK GUARD: bare client identifiers in metric names never survive', () => {
  const slice = {
    server_group_details: { '5': { name: 'Acme Sites' } },
    server_templates: [{ id: '9', name: 'Acme Edge', server_group: '/v2/server_group/5/', tags: ['owner:acme'] }],
    template_monitoring_configs: {
      '9': {
        total_metrics: 6, alerts_count: 6,
        metric_names: [
          'Interface WAN-AcmeHQ bandwidth',   // customer interface name
          'VDOM AcmeCorp-Prod sessions',       // customer VDOM
          'SD-WAN member Comcast-Primary',     // carrier
          'FGACMEHQ01 status',                 // bare hostname (no dot)
          'Serial FGTAWS-1234567890 uptime',   // FortiGate cloud serial
          'addr fe80::1 reachability'          // compressed IPv6
        ],
        metrics_without_alerts: []
      }
    }
  };
  const { inventory } = anonymizeTemplateInventory(slice);
  const blob = JSON.stringify(inventory);
  for (const needle of [
    'Acme', 'acme', 'WAN-AcmeHQ', 'AcmeCorp-Prod', 'Comcast', 'FGACMEHQ01',
    'FGTAWS-1234567890', 'fe80::1', 'owner:', 'Edge', 'Sites', '/v2/server'
  ]) {
    assert.equal(blob.includes(needle), false, `leaked "${needle}" into the pack`);
  }
  // Everything in the config is a token.
  for (const nm of inventory.template_monitoring_configs['1'].metric_names) assert.match(nm, /^m\d+$/);
});

test('OVERLAP: distinct per-interface names do NOT manufacture a false overlap', () => {
  // Two fully-alerted templates (so no default-only / cleanup) whose metric
  // names differ per interface. Real overlap is far below 60%. The OLD
  // shape-scrub collapsed "Interface X.acme.com" -> "Interface [host]" and
  // fabricated a 100% overlap; bijective tokenization must not.
  const slice = {
    server_group_details: { '3': { name: 'Prod' } },
    server_templates: [
      { id: '1', name: 'A', server_group: '/v2/server_group/3/' },
      { id: '2', name: 'B', server_group: '/v2/server_group/3/' }
    ],
    template_monitoring_configs: {
      '1': { total_metrics: 4, alerts_count: 4, metrics_without_alerts: [],
        metric_names: ['Interface x1.acme.com bw', 'Interface x2.acme.com bw', 'Interface x3.acme.com bw', 'CPU'] },
      '2': { total_metrics: 4, alerts_count: 4, metrics_without_alerts: [],
        metric_names: ['Interface y1.acme.com bw', 'Interface y2.acme.com bw', 'Interface y3.acme.com bw', 'CPU'] }
    }
  };
  const rawOverlap = analyzeTemplates(slice).overlapping_templates.length;
  const { inventory } = anonymizeTemplateInventory(slice);
  const anonOverlap = analyzeTemplates(inventory).overlapping_templates.length;
  assert.equal(rawOverlap, 0, 'fixture must have no real overlap');
  assert.equal(anonOverlap, rawOverlap, 'anonymization must not fabricate overlap');
});

test('OVERLAP: a genuine overlap is preserved exactly', () => {
  const raw = makeSlice();
  const rawR = analyzeTemplates(raw);
  const { inventory } = anonymizeTemplateInventory(raw);
  const anonR = analyzeTemplates(inventory);
  assert.equal(rawR.overlapping_templates.length, 1);
  assert.equal(anonR.overlapping_templates.length, 1);
});

test('anonymized inventory yields the SAME audit finding counts as raw', () => {
  const raw = makeSlice();
  const rawR = analyzeTemplates(raw);
  const { inventory } = anonymizeTemplateInventory(raw);
  const anonR = analyzeTemplates(inventory);
  assert.equal(anonR.available, true);
  assert.equal(anonR.default_only_templates.length, rawR.default_only_templates.length);
  assert.equal(anonR.cleanup_candidates.length, rawR.cleanup_candidates.length);
  assert.equal(anonR.overlapping_templates.length, rawR.overlapping_templates.length);
  assert.equal(anonR.default_templates.length, rawR.default_templates.length);
  // Fixture exercises each analysis.
  assert.equal(rawR.default_only_templates.length, 1);
  assert.equal(rawR.cleanup_candidates.length, 1);
  assert.equal(rawR.overlapping_templates.length, 1);
  assert.equal(rawR.default_templates.length, 1);
});

test('ORPHAN CONFIG: a config with no template row is still counted (matches raw)', () => {
  // A monitoring config keyed by a tid that has no server_templates entry.
  // analyzeTemplates counts it; the anonymized slice must too.
  const slice = {
    server_group_details: {},
    server_templates: [],
    template_monitoring_configs: {
      '777': { total_metrics: 3, alerts_count: 0, metric_names: ['A', 'B', 'C'], metrics_without_alerts: ['A', 'B', 'C'] }
    }
  };
  const rawR = analyzeTemplates(slice);
  const { inventory } = anonymizeTemplateInventory(slice);
  const anonR = analyzeTemplates(inventory);
  assert.equal(rawR.default_only_templates.length, 1, 'orphan config is a default-only candidate in raw');
  assert.equal(anonR.default_only_templates.length, rawR.default_only_templates.length);
});

test('assertAnonymizedInventory passes on anonymizer output, throws on raw', () => {
  const { inventory } = anonymizeTemplateInventory(makeSlice());
  assert.equal(assertAnonymizedInventory(inventory), true);
  assert.throws(() => assertAnonymizedInventory(makeSlice()),
    (e) => e instanceof TemplateAnonymizeError);
});

test('assertAnonymizedInventory catches a tampered pack (raw metric name / extra field)', () => {
  const { inventory } = anonymizeTemplateInventory(makeSlice());
  const tampered1 = structuredClone(inventory);
  tampered1.template_monitoring_configs['1'].metric_names[0] = 'CPU Usage';
  assert.throws(() => assertAnonymizedInventory(tampered1), /not tokenized/);

  const tampered2 = structuredClone(inventory);
  tampered2.server_templates[0].tags = ['leak'];
  assert.throws(() => assertAnonymizedInventory(tampered2), /unexpected field/);
});

test('anonymize is deterministic across runs', () => {
  const a = anonymizeTemplateInventory(makeSlice()).inventory;
  const b = anonymizeTemplateInventory(makeSlice()).inventory;
  assert.deepEqual(a, b);
});

test('handles an empty / missing slice without throwing', () => {
  const { inventory } = anonymizeTemplateInventory({});
  assert.deepEqual(inventory.server_templates, []);
  assert.deepEqual(inventory.server_group_details, {});
  assert.deepEqual(inventory.template_monitoring_configs, {});
  assert.equal(assertAnonymizedInventory(inventory), true);
});

// Trailing numeric id from a synthetic /server_group/{n} url.
function tail(url) {
  const m = String(url).match(/(\d+)\/?$/);
  return m ? m[1] : null;
}
