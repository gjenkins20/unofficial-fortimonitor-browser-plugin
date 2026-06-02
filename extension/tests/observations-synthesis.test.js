import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExecutiveSummary,
  buildFeatureUtilization,
  buildLabs,
  buildRawCounts,
  buildInstanceBreakdown
} from '../src/lib/observations-synthesis.js';

// =============================================================================
// buildExecutiveSummary
// =============================================================================

test('buildExecutiveSummary: empty inventory yields baseline rows with HEALTHY status', () => {
  const rows = buildExecutiveSummary({}, {});
  const map = new Map(rows.map((r) => [r.key, r.value]));
  assert.equal(map.get('Servers (Direct)'), 0);
  assert.equal(map.get('Active Incidents'), 0);
  assert.equal(map.get('Overall Status'), 'HEALTHY');
  assert.match(String(map.get('Status Reasoning')), /No active incidents/);
  assert.equal(map.get('Customer'), undefined); // omitted when blank
});

test('buildExecutiveSummary: customer name surfaces as first row', () => {
  const rows = buildExecutiveSummary({}, {}, 'Acme Corp');
  assert.equal(rows[0].key, 'Customer');
  assert.equal(rows[0].value, 'Acme Corp');
});

test('buildExecutiveSummary: deployment model = Fabric-Managed when fabric > servers', () => {
  const rows = buildExecutiveSummary({
    servers: [{ id: 1 }],
    fabric_connections: [{ id: 11 }, { id: 12 }, { id: 13 }]
  }, {});
  const map = new Map(rows.map((r) => [r.key, r.value]));
  assert.equal(map.get('Deployment Model'), 'Fabric-Managed');
});

test('buildExecutiveSummary: 3+ critical active incidents flips status to CRITICAL', () => {
  const rows = buildExecutiveSummary({
    outages: [
      { id: 1, active: true, severity: 'critical' },
      { id: 2, active: true, severity: 'critical' },
      { id: 3, active: true, severity: 'critical' },
      { id: 4, active: true, severity: 'warning' }
    ]
  }, {});
  const map = new Map(rows.map((r) => [r.key, r.value]));
  assert.equal(map.get('Active Incidents'), 4);
  assert.equal(map.get('Overall Status'), 'CRITICAL');
});

test('buildExecutiveSummary: acknowledgment rate uses 1-decimal percent', () => {
  const rows = buildExecutiveSummary({
    outages: [
      { id: 1, active: true, acknowledged: true },
      { id: 2, active: true, acknowledged: false }
    ]
  }, {});
  const map = new Map(rows.map((r) => [r.key, r.value]));
  assert.equal(map.get('Acknowledgment Rate'), '50.0%');
});

test('buildExecutiveSummary: trend rows added when analysis provides them', () => {
  const rows = buildExecutiveSummary({}, {
    incidents: { trending: { week_trend: 'Up 50%', month_trend: 'Stable' } }
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  assert.equal(map.get('Week-over-week'), 'Up 50%');
  assert.equal(map.get('Month-over-month'), 'Stable');
});

// =============================================================================
// buildFeatureUtilization
// =============================================================================

test('buildFeatureUtilization: empty inventory yields all underutilized rows, no actively-used rows', () => {
  const r = buildFeatureUtilization({});
  assert.deepEqual(r.active, []);
  const features = new Set(r.underutilized.map((u) => u.feature));
  for (const feat of [
    'DEM Applications', 'Server Templates', 'Cloud Discovery', 'Contact Groups',
    'Compound Services', 'SNMP Monitoring', 'Rotating Contacts (On-Call)', 'Status Pages'
  ]) {
    assert.ok(features.has(feat), `expected ${feat} flagged as underutilized`);
  }
});

test('buildFeatureUtilization: fabric presence wins server-monitoring section over direct', () => {
  const r = buildFeatureUtilization({
    servers: [{ id: 1 }, { id: 2 }],
    fabric_connections: [{ id: 11 }]
  });
  const fabricRow = r.active.find((a) => a.feature === 'Server Monitoring (Fabric)');
  const directRow = r.active.find((a) => a.feature === 'Server Monitoring (Direct)');
  assert.ok(fabricRow);
  assert.equal(directRow, undefined);
});

test('buildFeatureUtilization: 5+ templates removes the "only N templates" underutilized row', () => {
  const r = buildFeatureUtilization({
    server_templates: Array.from({ length: 7 }, (_, i) => ({ id: i }))
  });
  const tmplUnder = r.underutilized.find((u) => u.feature === 'Server Templates');
  assert.equal(tmplUnder, undefined);
  const tmplActive = r.active.find((a) => a.feature === 'Server Templates');
  assert.ok(tmplActive);
});

// FMN-218: buildRecommendations removed. The tenant observations no longer synthesizes a
// prioritized recommendations list - per-analyzer findings ship as neutral
// observations and there is no opinion layer above them.

// =============================================================================
// buildLabs
// =============================================================================

test('buildLabs: empty tenant yields conditional labs + 2 always-included labs', () => {
  const labs = buildLabs({});
  const titles = labs.map((l) => l.title);
  // Conditionals
  assert.ok(titles.includes('Populate Contact Groups & Test Alert Routing'));
  assert.ok(titles.includes('SNMP Discovery on Network Devices'));
  // Always
  assert.ok(titles.includes('Deploy an Automated Countermeasure'));
  assert.ok(titles.includes('Path Monitoring for Network Troubleshooting'));
});

test('buildLabs: feature presence removes the conditional lab', () => {
  const labs = buildLabs({
    contact_groups: [{}],
    compound_services: [{}],
    dem_applications: [{}],
    snmp_credentials: [{}],
    status_pages: [{}],
    cloud_credentials: [{}]
  });
  const titles = labs.map((l) => l.title);
  assert.equal(titles.includes('Populate Contact Groups & Test Alert Routing'), false);
  assert.equal(titles.includes('SNMP Discovery on Network Devices'), false);
  // Always-included survive
  assert.ok(titles.includes('Deploy an Automated Countermeasure'));
});

// =============================================================================
// buildRawCounts
// =============================================================================

test('buildRawCounts: counts servers by status and core resource lists', () => {
  const rows = buildRawCounts({
    servers: [
      { id: 1, status: 'active' },
      { id: 2, status: 'paused' },
      { id: 3, status: 'inactive' },
      { id: 4 } // unknown status — counted in total only
    ],
    fabric_connections: [{}, {}],
    server_groups: [{}, {}, {}]
  });
  const map = new Map(rows.map((r) => [r.resource, r.count]));
  assert.equal(map.get('Servers (Direct)'), 4);
  assert.equal(map.get('  Active'), 1);
  assert.equal(map.get('  Paused'), 1);
  assert.equal(map.get('  Inactive'), 1);
  assert.equal(map.get('Fabric Connections'), 2);
  assert.equal(map.get('Server Groups (total)'), 3);
});

test('buildRawCounts: missing inventory keys default to 0', () => {
  const rows = buildRawCounts({});
  const allCounts = rows.map((r) => r.count);
  for (const c of allCounts) assert.equal(c, 0);
});

// =============================================================================
// buildInstanceBreakdown (FMN-263)
// =============================================================================

test('buildInstanceBreakdown: empty inventory yields zero totals and empty byType', () => {
  const { totals, byType } = buildInstanceBreakdown({});
  const map = new Map(totals.map((r) => [r.resource, r.count]));
  assert.equal(map.get('Total Monitored Instances'), 0);
  assert.equal(map.get('  Servers / Devices'), 0);
  assert.equal(map.get('  OnSight Appliances'), 0);
  assert.equal(map.get('  Compound Services'), 0);
  assert.deepEqual(byType, []);
});

test('buildInstanceBreakdown: total counts servers + appliances + compound', () => {
  const { totals } = buildInstanceBreakdown({
    servers: [{ device_type: 'server' }, { device_type: 'server' }, { device_type: 'cloud' }],
    onsights: [{}, {}],
    compound_services: [{}]
  });
  const map = new Map(totals.map((r) => [r.resource, r.count]));
  assert.equal(map.get('Total Monitored Instances'), 6); // 3 + 2 + 1
  assert.equal(map.get('  Servers / Devices'), 3);
  assert.equal(map.get('  OnSight Appliances'), 2);
  assert.equal(map.get('  Compound Services'), 1);
});

test('buildInstanceBreakdown: all-null sub_type device_type has no child rows', () => {
  const { byType } = buildInstanceBreakdown({
    servers: [{ device_type: 'server' }, { device_type: 'server' }]
  });
  // Just the parent row, no indented children.
  assert.deepEqual(byType, [{ type: 'Server', count: 2 }]);
});

test('buildInstanceBreakdown: named sub_types render as indented children, count desc', () => {
  const { byType } = buildInstanceBreakdown({
    servers: [
      { device_type: 'cloud', device_sub_type: 'aws.ec2' },
      { device_type: 'cloud', device_sub_type: 'aws.ec2' },
      { device_type: 'cloud', device_sub_type: 'azure.vm' }
    ]
  });
  assert.deepEqual(byType, [
    { type: 'Cloud', count: 3 },
    { type: '  aws.ec2', count: 2 },
    { type: '  azure.vm', count: 1 }
  ]);
});

test('buildInstanceBreakdown: mixed null/named sub_types group nulls as (unspecified) last', () => {
  const { byType } = buildInstanceBreakdown({
    servers: [
      { device_type: 'network_device', device_sub_type: 'fortinet.fortigate' },
      { device_type: 'network_device', device_sub_type: 'fortinet.fortigate' },
      { device_type: 'network_device' },
      { device_type: 'network_device', device_sub_type: null }
    ]
  });
  assert.deepEqual(byType, [
    { type: 'Network Device', count: 4 },
    { type: '  fortinet.fortigate', count: 2 },
    { type: '  (unspecified)', count: 2 }
  ]);
});

test('buildInstanceBreakdown: device_types ordered by total count descending', () => {
  const { byType } = buildInstanceBreakdown({
    servers: [
      { device_type: 'cloud', device_sub_type: 'aws.ec2' },
      { device_type: 'server' },
      { device_type: 'server' },
      { device_type: 'server' }
    ]
  });
  // server (3) before cloud (1); parents appear in that order.
  const parents = byType.filter((r) => !r.type.startsWith('  ')).map((r) => r.type);
  assert.deepEqual(parents, ['Server', 'Cloud']);
});

test('buildInstanceBreakdown: unknown device_type is humanized via title-case fallback', () => {
  const { byType } = buildInstanceBreakdown({
    servers: [{ device_type: 'edge_gateway' }]
  });
  assert.deepEqual(byType, [{ type: 'Edge Gateway', count: 1 }]);
});

test('buildInstanceBreakdown: null device_type bucketed as (unspecified)', () => {
  const { byType } = buildInstanceBreakdown({
    servers: [{ device_type: null }, {}]
  });
  assert.deepEqual(byType, [{ type: '(unspecified)', count: 2 }]);
});
