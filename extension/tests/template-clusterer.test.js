import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateClusters, CLUSTER_KEY_SEPARATOR } from '../src/lib/template-clusterer.js';

// =====================================================================
// Fixtures
// =====================================================================

function fortigate(id, { model = 'FGVMA6', metrics = [], portScope = null } = {}) {
  return {
    id,
    name: `device-${id}`,
    fabricSystemData: { model_name: 'FortiGate', model_number: model, os_version: 'v7.6.3' },
    monitoring_config: [
      { textkey: 'fortinet.fortigate', name: 'FortiGate Stats', metrics }
    ],
    port_scope: portScope
  };
}

function metric(textkey, name, alertItems = []) {
  return { textkey, name, alert_items: alertItems };
}

// =====================================================================
// Happy paths
// =====================================================================

test('two identical FortiGates cluster together', () => {
  const m = [metric('cpu', 'CPU Usage'), metric('memory', 'Memory Usage')];
  const out = buildTemplateClusters([
    fortigate(1, { metrics: m }),
    fortigate(2, { metrics: m })
  ]);
  assert.equal(out.clusters.length, 1);
  assert.deepEqual(out.clusters[0].applies_to_server_ids, [1, 2]);
  assert.deepEqual(out.clusters[0].resource_signature, ['cpu', 'memory']);
  assert.equal(out.clusters[0].proposed_template_name, 'FortiGate FGVMA6 Best Practice');
  assert.equal(out.clusters[0].proposed_resources.length, 2);
  assert.equal(out.clusters[0].sample_device_id, 1);
});

test('different make/model do not cluster', () => {
  const out = buildTemplateClusters([
    fortigate(1, { model: 'FGVMA6' }),
    fortigate(2, { model: 'FG-100F' })
  ]);
  assert.equal(out.clusters.length, 2);
  const fgvm = out.clusters.find((c) => c.model === 'FGVMA6');
  const fg100 = out.clusters.find((c) => c.model === 'FG-100F');
  assert.deepEqual(fgvm.applies_to_server_ids, [1]);
  assert.deepEqual(fg100.applies_to_server_ids, [2]);
});

test('same make/model but different resource sets split into two clusters', () => {
  const out = buildTemplateClusters([
    fortigate(1, { metrics: [metric('cpu', 'CPU')] }),
    fortigate(2, { metrics: [metric('cpu', 'CPU'), metric('memory', 'Memory')] })
  ]);
  assert.equal(out.clusters.length, 2);
});

test('same resource set but different thresholds split into two clusters', () => {
  const out = buildTemplateClusters([
    fortigate(1, { metrics: [metric('cpu', 'CPU', [['critical', 'CRIT', 'tl', '> 80%', []]])] }),
    fortigate(2, { metrics: [metric('cpu', 'CPU', [['critical', 'CRIT', 'tl', '> 90%', []]])] })
  ]);
  assert.equal(out.clusters.length, 2);
});

test('same resource set + thresholds but different port scope split into two clusters', () => {
  const m = [metric('cpu', 'CPU')];
  const out = buildTemplateClusters([
    fortigate(1, { metrics: m, portScope: [0, 1, 2] }),
    fortigate(2, { metrics: m, portScope: [0, 1, 2, 3] })
  ]);
  assert.equal(out.clusters.length, 2);
});

test('port scope null vs empty array are distinct signatures', () => {
  const m = [metric('cpu', 'CPU')];
  const out = buildTemplateClusters([
    fortigate(1, { metrics: m, portScope: null }),
    fortigate(2, { metrics: m, portScope: [] })
  ]);
  assert.equal(out.clusters.length, 2);
  const nullCluster = out.clusters.find((c) => c.port_signature === null);
  const emptyCluster = out.clusters.find((c) => Array.isArray(c.port_signature) && c.port_signature.length === 0);
  assert.ok(nullCluster);
  assert.ok(emptyCluster);
});

test('port-scope order does not affect clustering (signature is sorted)', () => {
  const m = [metric('cpu', 'CPU')];
  const out = buildTemplateClusters([
    fortigate(1, { metrics: m, portScope: [1, 2, 3] }),
    fortigate(2, { metrics: m, portScope: [3, 2, 1] })
  ]);
  assert.equal(out.clusters.length, 1);
});

test('mixed identical + outlier yields multi-member + single-member clusters', () => {
  const m = [metric('cpu', 'CPU')];
  const out = buildTemplateClusters([
    fortigate(1, { metrics: m }),
    fortigate(2, { metrics: m }),
    fortigate(3, { metrics: m }),
    fortigate(4, { metrics: [...m, metric('memory', 'Memory')] })  // outlier
  ]);
  assert.equal(out.clusters.length, 2);
  const big = out.clusters.find((c) => c.applies_to_server_ids.length === 3);
  const small = out.clusters.find((c) => c.applies_to_server_ids.length === 1);
  assert.deepEqual(big.applies_to_server_ids, [1, 2, 3]);
  assert.deepEqual(small.applies_to_server_ids, [4]);
});

// =====================================================================
// Proposed_resources content
// =====================================================================

test('proposed_resources carries plugin_textkey from the category', () => {
  const out = buildTemplateClusters([
    fortigate(1, { metrics: [metric('cpu', 'CPU')] })
  ]);
  assert.equal(out.clusters[0].proposed_resources[0].plugin_textkey, 'fortinet.fortigate');
  assert.equal(out.clusters[0].proposed_resources[0].resource_textkey, 'cpu');
  assert.equal(out.clusters[0].proposed_resources[0].name, 'CPU');
});

test('proposed_resources deep-clones alert_items so callers cannot mutate the cluster', () => {
  const alertItems = [['critical', 'CRIT', 'tl', '> 80%', []]];
  const out = buildTemplateClusters([
    fortigate(1, { metrics: [metric('cpu', 'CPU', alertItems)] })
  ]);
  out.clusters[0].proposed_resources[0].alert_items.push('INJECTED');
  assert.equal(alertItems.length, 1, 'original threshold list untouched');
});

test('proposed_resources order is sorted by resource_textkey (stable across runs)', () => {
  const m = [metric('memory', 'Memory'), metric('cpu', 'CPU'), metric('disk', 'Disk')];
  const out = buildTemplateClusters([fortigate(1, { metrics: m })]);
  const keys = out.clusters[0].proposed_resources.map((r) => r.resource_textkey);
  assert.deepEqual(keys, ['cpu', 'disk', 'memory']);
});

// =====================================================================
// Unclassified paths
// =====================================================================

test('device with no id is unclassified', () => {
  const out = buildTemplateClusters([{ fabricSystemData: { model_name: 'FortiGate', model_number: 'FGVMA6' } }]);
  assert.equal(out.clusters.length, 0);
  assert.equal(out.unclassified.length, 1);
  assert.match(out.unclassified[0].reason, /id/);
});

test('device without fabricSystemData make/model is unclassified', () => {
  const out = buildTemplateClusters([{ id: 1, monitoring_config: [] }]);
  assert.equal(out.clusters.length, 0);
  assert.equal(out.unclassified.length, 1);
  assert.match(out.unclassified[0].reason, /fabricSystemData/);
});

test('device with empty monitoring_config still clusters (legitimate empty-template case)', () => {
  const out = buildTemplateClusters([
    fortigate(1, { metrics: [] })
  ]);
  assert.equal(out.clusters.length, 1);
  assert.deepEqual(out.clusters[0].resource_signature, []);
  assert.deepEqual(out.clusters[0].proposed_resources, []);
});

test('null monitoring_config is treated as empty (legitimate)', () => {
  const out = buildTemplateClusters([
    { id: 1, fabricSystemData: { model_name: 'FortiGate', model_number: 'FGVMA6' }, monitoring_config: null }
  ]);
  assert.equal(out.clusters.length, 1);
});

test('empty inputs return empty output', () => {
  const a = buildTemplateClusters([]);
  const b = buildTemplateClusters(null);
  const c = buildTemplateClusters(undefined);
  assert.deepEqual(a, { clusters: [], unclassified: [] });
  assert.deepEqual(b, { clusters: [], unclassified: [] });
  assert.deepEqual(c, { clusters: [], unclassified: [] });
});

// =====================================================================
// Customization hooks
// =====================================================================

test('custom resourceKey extractor can override default identity', () => {
  // Treat metrics by name only, ignoring textkey - useful when callers
  // know the read-side metric records lack textkeys.
  const out = buildTemplateClusters(
    [
      fortigate(1, { metrics: [{ textkey: '', name: 'CPU Usage' }] }),
      fortigate(2, { metrics: [{ textkey: '', name: 'CPU Usage' }] })
    ],
    { resourceKey: (m) => m.name }
  );
  assert.equal(out.clusters.length, 1);
  assert.equal(out.clusters[0].applies_to_server_ids.length, 2);
});

test('custom thresholdSignature extractor changes the cluster key', () => {
  // Ignore thresholds entirely - everything with same resources clusters.
  const out = buildTemplateClusters(
    [
      fortigate(1, { metrics: [metric('cpu', 'CPU', [['warn', 'WARN', 't', '> 50%', []]])] }),
      fortigate(2, { metrics: [metric('cpu', 'CPU', [['critical', 'CRIT', 't', '> 90%', []]])] })
    ],
    { thresholdSignature: () => '' }
  );
  assert.equal(out.clusters.length, 1);
});

// =====================================================================
// Cluster key shape
// =====================================================================

test('cluster key has the canonical separator and identifying parts', () => {
  const out = buildTemplateClusters([
    fortigate(1, { metrics: [metric('cpu', 'CPU')], portScope: [0, 1] })
  ]);
  const key = out.clusters[0].key;
  assert.ok(key.startsWith(`FortiGate${CLUSTER_KEY_SEPARATOR}FGVMA6${CLUSTER_KEY_SEPARATOR}`));
  assert.match(key, /::r=cpu::t=[a-z0-9]+::p=0,1$/);
});

// =====================================================================
// Exact-match union/intersection / member_signatures (FMN-209)
// =====================================================================

test('exact-match (threshold=1.0) populates union/intersection equal to representative', () => {
  const m = [metric('cpu', 'CPU'), metric('memory', 'Memory')];
  const out = buildTemplateClusters([
    fortigate(1, { metrics: m }),
    fortigate(2, { metrics: m })
  ]);
  assert.equal(out.clusters.length, 1);
  const c = out.clusters[0];
  assert.deepEqual(c.resource_union, ['cpu', 'memory']);
  assert.deepEqual(c.resource_intersection, ['cpu', 'memory']);
  assert.equal(c.resource_strategy, 'union');
});

test('member_signatures records per-device resource keys + port keys', () => {
  const m = [metric('cpu', 'CPU')];
  const out = buildTemplateClusters([
    fortigate(1, { metrics: m, portScope: [0, 1] }),
    fortigate(2, { metrics: m, portScope: [0, 1] })
  ]);
  const c = out.clusters[0];
  assert.equal(c.member_signatures.length, 2);
  assert.deepEqual(c.member_signatures[0].resource_keys, ['cpu']);
  assert.deepEqual(c.member_signatures[0].port_keys, ['0', '1']);
  assert.equal(c.member_signatures[0].server_id, 1);
  assert.equal(c.member_signatures[1].server_id, 2);
});

// =====================================================================
// Jaccard similarity clustering (FMN-209)
// =====================================================================

test('jaccard=1.0 behaves like exact match (default)', () => {
  const out1 = buildTemplateClusters([
    fortigate(1, { metrics: [metric('cpu', 'CPU')] }),
    fortigate(2, { metrics: [metric('cpu', 'CPU'), metric('memory', 'Memory')] })
  ]);
  const out2 = buildTemplateClusters(
    [
      fortigate(1, { metrics: [metric('cpu', 'CPU')] }),
      fortigate(2, { metrics: [metric('cpu', 'CPU'), metric('memory', 'Memory')] })
    ],
    { threshold: 1.0 }
  );
  assert.equal(out1.clusters.length, 2);
  assert.equal(out2.clusters.length, 2);
});

test('jaccard threshold 0.5 merges near-identical devices (32/33 resources)', () => {
  const baseMetrics = Array.from({ length: 31 }, (_, i) => metric(`r${i}`, `R${i}`));
  const dev32 = [...baseMetrics, metric('r31', 'R31')];                                 // 32 resources
  const dev33 = [...baseMetrics, metric('r31', 'R31'), metric('r32', 'R32')];            // 33 resources
  // jaccard(32, 33) = 32 / 33 ~= 0.97
  const out = buildTemplateClusters(
    [fortigate(1, { metrics: dev32 }), fortigate(2, { metrics: dev33 })],
    { threshold: 0.8 }
  );
  assert.equal(out.clusters.length, 1);
  const c = out.clusters[0];
  assert.equal(c.resource_union.length, 33);
  assert.equal(c.resource_intersection.length, 32);
});

test('jaccard threshold 0.8 isolates a wildly different device (0 vs 32 resources)', () => {
  const m32 = Array.from({ length: 32 }, (_, i) => metric(`r${i}`, `R${i}`));
  const out = buildTemplateClusters(
    [
      fortigate(1, { metrics: [] }),     // empty
      fortigate(2, { metrics: m32 }),
      fortigate(3, { metrics: m32 })
    ],
    { threshold: 0.8 }
  );
  // empty vs 32 has jaccard 0/32 = 0; below threshold so separate cluster
  assert.equal(out.clusters.length, 2);
  const empty = out.clusters.find((c) => c.applies_to_server_ids.length === 1);
  const big = out.clusters.find((c) => c.applies_to_server_ids.length === 2);
  assert.deepEqual(empty.applies_to_server_ids, [1]);
  assert.deepEqual(big.applies_to_server_ids, [2, 3]);
});

test('jaccard never merges different make/model regardless of threshold', () => {
  const m = [metric('cpu', 'CPU')];
  const out = buildTemplateClusters(
    [fortigate(1, { model: 'FGVMA6', metrics: m }), fortigate(2, { model: 'FG-100F', metrics: m })],
    { threshold: 0.1 }
  );
  assert.equal(out.clusters.length, 2);
});

test('resourceStrategy=intersection populates proposed_resources from intersection', () => {
  const baseMetrics = Array.from({ length: 31 }, (_, i) => metric(`r${i}`, `R${i}`));
  const dev32 = [...baseMetrics, metric('r31', 'R31')];
  const dev33 = [...baseMetrics, metric('r31', 'R31'), metric('r32', 'R32')];
  const out = buildTemplateClusters(
    [fortigate(1, { metrics: dev32 }), fortigate(2, { metrics: dev33 })],
    { threshold: 0.5, resourceStrategy: 'intersection' }
  );
  assert.equal(out.clusters.length, 1);
  const c = out.clusters[0];
  assert.equal(c.resource_strategy, 'intersection');
  assert.equal(c.proposed_resources.length, 32);
});

test('resourceStrategy=union (default) populates proposed_resources from union', () => {
  const baseMetrics = Array.from({ length: 31 }, (_, i) => metric(`r${i}`, `R${i}`));
  const dev32 = [...baseMetrics, metric('r31', 'R31')];
  const dev33 = [...baseMetrics, metric('r31', 'R31'), metric('r32', 'R32')];
  const out = buildTemplateClusters(
    [fortigate(1, { metrics: dev32 }), fortigate(2, { metrics: dev33 })],
    { threshold: 0.5 }
  );
  const c = out.clusters[0];
  assert.equal(c.resource_strategy, 'union');
  assert.equal(c.proposed_resources.length, 33);
});

test('jaccard cluster key carries make+model+j::idx form', () => {
  const out = buildTemplateClusters(
    [
      fortigate(1, { metrics: [metric('cpu', 'CPU')] }),
      fortigate(2, { metrics: [] })       // disjoint -> different cluster
    ],
    { threshold: 0.5 }
  );
  assert.equal(out.clusters.length, 2);
  for (const c of out.clusters) {
    assert.match(c.key, /^FortiGate::FGVMA6::j::\d+$/);
  }
});

test('jaccard threshold out of range is clamped (negative -> 0)', () => {
  const out = buildTemplateClusters(
    [
      fortigate(1, { metrics: [metric('cpu', 'CPU')] }),
      fortigate(2, { metrics: [metric('memory', 'Memory')] })
    ],
    { threshold: -1 }
  );
  // threshold=0 means everything in same make+model merges
  assert.equal(out.clusters.length, 1);
  assert.equal(out.clusters[0].resource_union.length, 2);
  assert.equal(out.clusters[0].resource_intersection.length, 0);
});

test('jaccard threshold >1 is clamped to 1 (exact match)', () => {
  const out = buildTemplateClusters(
    [
      fortigate(1, { metrics: [metric('cpu', 'CPU')] }),
      fortigate(2, { metrics: [metric('cpu', 'CPU'), metric('memory', 'Memory')] })
    ],
    { threshold: 5 }
  );
  assert.equal(out.clusters.length, 2);
});

test('jaccard groups disjoint resource sets into separate clusters', () => {
  const out = buildTemplateClusters(
    [
      fortigate(1, { metrics: [metric('cpu', 'CPU')] }),
      fortigate(2, { metrics: [metric('memory', 'Memory')] })
    ],
    { threshold: 0.5 }
  );
  // jaccard = 0 / 2 = 0; below threshold; separate clusters
  assert.equal(out.clusters.length, 2);
});

// =====================================================================
// Per-member rationale + jaccard (FMN-209 fix)
// =====================================================================

test('seed member has rationale + jaccard=1.0 in exact-match mode', () => {
  const out = buildTemplateClusters([
    fortigate(1, { metrics: [metric('cpu', 'CPU')] }),
    fortigate(2, { metrics: [metric('cpu', 'CPU')] })
  ]);
  const c = out.clusters[0];
  assert.equal(c.member_signatures.length, 2);
  assert.equal(c.member_signatures[0].jaccard_to_representative, 1.0);
  assert.match(c.member_signatures[0].rationale, /Seeded cluster/);
  assert.equal(c.member_signatures[1].jaccard_to_representative, 1.0);
  assert.match(c.member_signatures[1].rationale, /Identical signature/);
});

test('jaccard mode: subsequent members carry the computed score + threshold rationale', () => {
  const baseMetrics = Array.from({ length: 31 }, (_, i) => metric(`r${i}`, `R${i}`));
  const dev32 = [...baseMetrics, metric('r31', 'R31')];
  const dev33 = [...baseMetrics, metric('r31', 'R31'), metric('r32', 'R32')];
  const out = buildTemplateClusters(
    [fortigate(1, { metrics: dev32 }), fortigate(2, { metrics: dev33 })],
    { threshold: 0.8 }
  );
  const c = out.clusters[0];
  assert.equal(c.member_signatures.length, 2);
  assert.equal(c.member_signatures[0].jaccard_to_representative, 1.0);
  assert.match(c.member_signatures[0].rationale, /Seeded cluster/);
  const joinedJaccard = c.member_signatures[1].jaccard_to_representative;
  assert.ok(joinedJaccard >= 0.8 && joinedJaccard < 1.0, `expected 0.8 <= jaccard < 1.0, got ${joinedJaccard}`);
  assert.match(c.member_signatures[1].rationale, /Joined cluster.*Jaccard.*threshold 0\.80/);
});

test('member snapshot carries device_name when device.name is set', () => {
  const out = buildTemplateClusters([
    fortigate(1, { metrics: [metric('cpu', 'CPU')] })
  ]);
  assert.equal(out.clusters[0].member_signatures[0].device_name, 'device-1');
});
