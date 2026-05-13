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
