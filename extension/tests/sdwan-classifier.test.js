import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyInterface,
  classifyMetric,
  classifyOidMetricType,
  extractInterfaceCandidate,
  compilePatterns,
  SDWAN_OVERLAY_PATTERNS,
  SDWAN_UNDERLAY_PATTERNS,
  SDWAN_GENERIC_PATTERNS
} from '../src/lib/sdwan-classifier.js';

// =====================================================================
// classifyInterface (regex lists)
// =====================================================================

test('classifyInterface: hits overlay patterns', () => {
  assert.equal(classifyInterface('overlay-corp-vpn'), 'overlay');
  assert.equal(classifyInterface('IPsec_Tunnel_HQ'), 'overlay');
  assert.equal(classifyInterface('vpn0'), 'overlay');
  assert.equal(classifyInterface('vxlan100'), 'overlay');
  assert.equal(classifyInterface('gre-tunnel-3'), 'overlay');
  assert.equal(classifyInterface('ssl.root'), 'overlay');
});

test('classifyInterface: hits underlay patterns', () => {
  assert.equal(classifyInterface('wan1'), 'underlay');
  assert.equal(classifyInterface('WAN'), 'underlay');
  assert.equal(classifyInterface('mpls-cloud'), 'underlay');
  assert.equal(classifyInterface('LTE-Modem'), 'underlay');
  assert.equal(classifyInterface('5G-uplink'), 'underlay');
  assert.equal(classifyInterface('Internet'), 'underlay');
  assert.equal(classifyInterface('ISP1'), 'underlay');
  assert.equal(classifyInterface('Fiber-WAN'), 'underlay');
});

test('classifyInterface: generic patterns win over underlay (sd-wan link contains "wan")', () => {
  assert.equal(classifyInterface('SD-WAN Link Packet Loss Google_DNS'), 'generic');
  assert.equal(classifyInterface('SD-WAN SLA target_3'), 'generic');
  assert.equal(classifyInterface('SD-WAN Health Check'), 'generic');
  assert.equal(classifyInterface('SDWAN_Performance'), 'generic');
  assert.equal(classifyInterface('virtual.wan.1'), 'generic');
});

test('classifyInterface: returns null on no match and on null/undefined', () => {
  assert.equal(classifyInterface('eth0'), null);
  assert.equal(classifyInterface('management'), null);
  assert.equal(classifyInterface(''), null);
  assert.equal(classifyInterface(null), null);
  assert.equal(classifyInterface(undefined), null);
});

// =====================================================================
// extractInterfaceCandidate
// =====================================================================

test('extractInterfaceCandidate: pulls suffix after last " - "', () => {
  assert.equal(extractInterfaceCandidate({ name: 'Bandwidth: kb in/sec - wan1' }), 'wan1');
  assert.equal(extractInterfaceCandidate({ formatted_name: 'SD-WAN Link Packet Loss Google_DNS - wan1' }), 'wan1');
  assert.equal(extractInterfaceCandidate({ name: 'Disk: disk % used - /dev/root mounted at /' }), '/dev/root');
});

test('extractInterfaceCandidate: prefers formatted_name over name', () => {
  assert.equal(
    extractInterfaceCandidate({ formatted_name: 'SD-WAN - vpn0', name: 'fallback - eth1' }),
    'vpn0'
  );
});

test('extractInterfaceCandidate: returns empty string when no separator', () => {
  assert.equal(extractInterfaceCandidate({ name: 'no-separator' }), '');
  assert.equal(extractInterfaceCandidate({}), '');
  assert.equal(extractInterfaceCandidate(null), '');
});

// =====================================================================
// classifyMetric (full pipeline)
// =====================================================================

test('classifyMetric: classifies via suffix when present', () => {
  const r = classifyMetric({ formatted_name: 'Bandwidth: kb in/sec - wan1' });
  assert.equal(r.classification, 'underlay');
  assert.equal(r.interfaceName, 'wan1');
});

test('classifyMetric: SD-WAN SNMP suffix wan1 is tagged underlay (matches Python)', () => {
  // The candidate ("wan1") is the first try; it hits underlay before the
  // full name ("...SD-WAN Link...") is evaluated. The Python source has
  // the same order. The downstream SD-WAN report keeps any non-null
  // classification, so the metric still lands in the report.
  const r = classifyMetric({ formatted_name: 'SD-WAN Link Packet Loss Google_DNS - wan1' });
  assert.equal(r.classification, 'underlay');
  assert.equal(r.interfaceName, 'wan1');
});

test('classifyMetric: SD-WAN name without suffix classifies as generic', () => {
  // No " - " separator -> candidate is empty -> the full name is the
  // first non-empty try, and the generic regex wins (checked first).
  const r = classifyMetric({ formatted_name: 'SD-WAN Health Check overall' });
  assert.equal(r.classification, 'generic');
});

test('classifyMetric: falls back to label / description when name has no suffix', () => {
  const r1 = classifyMetric({ name: 'metric-7', label: 'IPsec health' });
  assert.equal(r1.classification, 'overlay');
  const r2 = classifyMetric({ name: 'metric-7', description: 'ISP-Comcast latency' });
  assert.equal(r2.classification, 'underlay');
});

test('classifyMetric: returns null classification when nothing matches', () => {
  const r = classifyMetric({ name: 'cpu_usage' });
  assert.equal(r.classification, null);
});

test('classifyMetric: handles missing / nullish inputs', () => {
  assert.deepEqual(classifyMetric(null), { interfaceName: '', classification: null });
  assert.deepEqual(classifyMetric({}), { interfaceName: '', classification: null });
});

// =====================================================================
// classifyOidMetricType (FortiGate SD-WAN MIB)
// =====================================================================

test('classifyOidMetricType: maps the 3 SD-WAN sub-OIDs', () => {
  assert.equal(classifyOidMetricType('1.3.6.1.4.1.12356.101.4.9.2.1.4.1.0'), 'latency');
  assert.equal(classifyOidMetricType('1.3.6.1.4.1.12356.101.4.9.2.1.5.1.0'), 'jitter');
  assert.equal(classifyOidMetricType('1.3.6.1.4.1.12356.101.4.9.2.1.9.1.0'), 'loss');
});

test('classifyOidMetricType: returns null for unrelated OIDs and bad inputs', () => {
  assert.equal(classifyOidMetricType('1.3.6.1.2.1.2.2.1.10'), null);
  assert.equal(classifyOidMetricType(''), null);
  assert.equal(classifyOidMetricType(null), null);
  assert.equal(classifyOidMetricType(undefined), null);
});

// =====================================================================
// compilePatterns (override path)
// =====================================================================

test('compilePatterns: defaults map to the exported pattern lists', () => {
  const compiled = compilePatterns();
  assert.equal(compiled.overlay.length, SDWAN_OVERLAY_PATTERNS.length);
  assert.equal(compiled.underlay.length, SDWAN_UNDERLAY_PATTERNS.length);
  assert.equal(compiled.generic.length, SDWAN_GENERIC_PATTERNS.length);
});

test('compilePatterns: overrides take effect through classifyInterface', () => {
  const compiled = compilePatterns({ overlay: ['^foo$'], underlay: ['bar'], generic: [] });
  assert.equal(classifyInterface('foo', compiled), 'overlay');
  assert.equal(classifyInterface('bar-thing', compiled), 'underlay');
  assert.equal(classifyInterface('overlay', compiled), null,
    'default overlay pattern should not match when an override list is supplied');
});
