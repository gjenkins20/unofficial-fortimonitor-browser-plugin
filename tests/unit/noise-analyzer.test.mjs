// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-156 unit tests for the noise analyzer.
//
// Pure-function tests over a synthetic inventory. No chrome.* needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeNoise } from '../../extension/src/lib/bpa-analyzers/noise.js';

const NOW = new Date('2026-05-11T00:00:00Z');

// Helper: build an outage record matching the live /v2/outage shape
// (see docs/api-discovery/outages.md).
function outage({
  id = 1, server_id = 100, server_name = 'srv',
  status = 'resolved',
  severity = 'critical',
  description = '',
  start_time = '2026-05-01T12:00:00Z',
  end_time = '2026-05-01T12:05:00Z'
} = {}) {
  return { id, server_id, server_name, status, severity, description, start_time, end_time };
}

test('empty inventory yields zeroed summary and empty arrays', () => {
  const out = analyzeNoise({ outages: [] }, NOW);
  assert.deepEqual(out.top_noisy_instances, []);
  assert.deepEqual(out.top_noisy_metrics, []);
  assert.equal(out.summary.instances_with_outages, 0);
  assert.equal(out.summary.total_outages_30d, 0);
  assert.equal(out.summary.median_mttr_min, 0);
  assert.equal(out.summary.window_days, 30);
});

test('ranks instances by 30-day outage count', () => {
  const inventory = {
    outages: [
      outage({ id: 1, server_id: 1, server_name: 'a' }),
      outage({ id: 2, server_id: 1, server_name: 'a' }),
      outage({ id: 3, server_id: 1, server_name: 'a' }),
      outage({ id: 4, server_id: 2, server_name: 'b' })
    ]
  };
  const out = analyzeNoise(inventory, NOW);
  assert.equal(out.top_noisy_instances.length, 2);
  assert.equal(out.top_noisy_instances[0].server_name, 'a');
  assert.equal(out.top_noisy_instances[0].outage_count_30d, 3);
  assert.equal(out.top_noisy_instances[1].server_name, 'b');
  assert.equal(out.top_noisy_instances[1].outage_count_30d, 1);
});

test('excludes outages outside the 30-day window', () => {
  const inventory = {
    outages: [
      // 60 days old -> dropped
      outage({ id: 1, server_id: 1, start_time: '2026-03-01T00:00:00Z', end_time: '2026-03-01T00:05:00Z' }),
      // 1 day old -> kept
      outage({ id: 2, server_id: 1, start_time: '2026-05-10T00:00:00Z', end_time: '2026-05-10T00:05:00Z' })
    ]
  };
  const out = analyzeNoise(inventory, NOW);
  assert.equal(out.summary.total_outages_30d, 1);
  assert.equal(out.top_noisy_instances[0].outage_count_30d, 1);
});

test('MTTR and total_duration computed from resolved outages only', () => {
  const inventory = {
    outages: [
      // 10 min
      outage({ id: 1, server_id: 1, start_time: '2026-05-01T00:00:00Z', end_time: '2026-05-01T00:10:00Z' }),
      // 30 min
      outage({ id: 2, server_id: 1, start_time: '2026-05-02T00:00:00Z', end_time: '2026-05-02T00:30:00Z' }),
      // active - excluded from duration math
      outage({ id: 3, server_id: 1, status: 'active', start_time: '2026-05-10T00:00:00Z', end_time: null })
    ]
  };
  const out = analyzeNoise(inventory, NOW);
  const row = out.top_noisy_instances[0];
  assert.equal(row.outage_count_30d, 3);
  assert.equal(row.total_duration_min, 40); // 10 + 30
  assert.equal(row.mttr_min, 20);           // 40 / 2
});

test('flap_rate_per_24h = count / window_days', () => {
  // 6 outages over 30 days -> 0.2/24h
  const outages = [];
  for (let i = 0; i < 6; i++) {
    outages.push(outage({ id: i, server_id: 1,
      start_time: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      end_time:   `2026-05-${String(i + 1).padStart(2, '0')}T00:05:00Z` }));
  }
  const out = analyzeNoise({ outages }, NOW);
  assert.equal(out.top_noisy_instances[0].flap_rate_per_24h, 0.2);
});

test('high flap rate triggers threshold/dwell-time recommendation', () => {
  // 60 outages in 30d -> 2.0 flap/24h (above 1.5 threshold)
  const outages = [];
  for (let i = 0; i < 60; i++) {
    outages.push(outage({ id: i, server_id: 1,
      start_time: '2026-05-10T00:00:00Z',
      end_time:   '2026-05-10T00:05:00Z' }));
  }
  const out = analyzeNoise({ outages }, NOW);
  const rec = out.top_noisy_instances[0].recommendation;
  assert.match(rec, /flap rate/i);
  assert.match(rec, /P95/);
});

test('high volume but low flap triggers volume recommendation', () => {
  // 10 outages, but spread over many distinct days -> volume threshold
  // triggers but flap (10/30 = 0.33) is below 1.5
  const outages = [];
  for (let i = 0; i < 10; i++) {
    outages.push(outage({ id: i, server_id: 1,
      start_time: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      end_time:   `2026-05-${String(i + 1).padStart(2, '0')}T03:00:00Z` })); // long duration -> not "short"
  }
  const out = analyzeNoise({ outages }, NOW);
  const rec = out.top_noisy_instances[0].recommendation;
  assert.match(rec, /volume/i);
});

test('top noisy metrics grouped by (server_id, description)', () => {
  const inventory = {
    outages: [
      outage({ id: 1, server_id: 1, description: 'Agent Heartbeat' }),
      outage({ id: 2, server_id: 1, description: 'Agent Heartbeat' }),
      outage({ id: 3, server_id: 1, description: 'CPU' }),
      outage({ id: 4, server_id: 2, description: 'Agent Heartbeat' }),
      outage({ id: 5, server_id: 2, description: 'Agent Heartbeat' })
    ]
  };
  const out = analyzeNoise(inventory, NOW);
  // (1, Agent Heartbeat) = 2; (2, Agent Heartbeat) = 2; (1, CPU) = 1
  // Only those with count >= 2 show.
  assert.equal(out.top_noisy_metrics.length, 2);
  assert.ok(out.top_noisy_metrics.every((m) => m.count_30d >= 2));
  for (const m of out.top_noisy_metrics) {
    assert.equal(m.metric_name, 'Agent Heartbeat');
  }
});

test('metric rows without a description are dropped', () => {
  const inventory = {
    outages: [
      outage({ id: 1, server_id: 1, description: '' }),
      outage({ id: 2, server_id: 1, description: '' }),
      outage({ id: 3, server_id: 1, description: 'CPU' }),
      outage({ id: 4, server_id: 1, description: 'CPU' })
    ]
  };
  const out = analyzeNoise(inventory, NOW);
  assert.equal(out.top_noisy_metrics.length, 1);
  assert.equal(out.top_noisy_metrics[0].metric_name, 'CPU');
});

test('legacy active=true fixtures are filtered out of duration math', () => {
  // Legacy IncidentAnalyzer fixture shape: uses `active: true|false`
  // and omits `status`. Active outages should not contribute to duration.
  const inventory = {
    outages: [
      { id: 1, server_id: 1, server_name: 'a', active: true,
        start_time: '2026-05-10T00:00:00Z', end_time: null, severity: 'critical' },
      { id: 2, server_id: 1, server_name: 'a', active: false,
        start_time: '2026-05-01T00:00:00Z', end_time: '2026-05-01T00:10:00Z', severity: 'warning' }
    ]
  };
  const out = analyzeNoise(inventory, NOW);
  const row = out.top_noisy_instances[0];
  assert.equal(row.outage_count_30d, 2);
  // Only the resolved (active:false) outage contributes 10 min.
  assert.equal(row.total_duration_min, 10);
  assert.equal(row.mttr_min, 10);
});

test('server_id falls back to /v2/server/{id} URL when bare server_id is missing', () => {
  const inventory = {
    outages: [
      { id: 1, server: 'https://api2.panopta.com/v2/server/12345', server_name: 'fmtest',
        status: 'resolved',
        start_time: '2026-05-01T00:00:00Z', end_time: '2026-05-01T00:05:00Z' },
      { id: 2, server: 'https://api2.panopta.com/v2/server/12345', server_name: 'fmtest',
        status: 'resolved',
        start_time: '2026-05-02T00:00:00Z', end_time: '2026-05-02T00:05:00Z' }
    ]
  };
  const out = analyzeNoise(inventory, NOW);
  assert.equal(out.top_noisy_instances.length, 1);
  assert.equal(out.top_noisy_instances[0].server_id, '12345');
  assert.equal(out.top_noisy_instances[0].outage_count_30d, 2);
});

test('top_noisy_instances tie-broken by total_duration descending', () => {
  const inventory = {
    outages: [
      // Both servers have 2 outages.
      // Server 1: 2x 5 min = 10 min total
      outage({ id: 1, server_id: 1, server_name: 'a',
        start_time: '2026-05-01T00:00:00Z', end_time: '2026-05-01T00:05:00Z' }),
      outage({ id: 2, server_id: 1, server_name: 'a',
        start_time: '2026-05-02T00:00:00Z', end_time: '2026-05-02T00:05:00Z' }),
      // Server 2: 2x 30 min = 60 min total -> ranks higher despite same count
      outage({ id: 3, server_id: 2, server_name: 'b',
        start_time: '2026-05-01T00:00:00Z', end_time: '2026-05-01T00:30:00Z' }),
      outage({ id: 4, server_id: 2, server_name: 'b',
        start_time: '2026-05-02T00:00:00Z', end_time: '2026-05-02T00:30:00Z' })
    ]
  };
  const out = analyzeNoise(inventory, NOW);
  assert.equal(out.top_noisy_instances[0].server_name, 'b');
  assert.equal(out.top_noisy_instances[1].server_name, 'a');
});

test('median_mttr_min computed across all resolved outages', () => {
  // Durations (seconds): 60, 300, 600 -> median = 300 sec = 5 min
  const inventory = {
    outages: [
      outage({ id: 1, server_id: 1, start_time: '2026-05-01T00:00:00Z', end_time: '2026-05-01T00:01:00Z' }),
      outage({ id: 2, server_id: 1, start_time: '2026-05-02T00:00:00Z', end_time: '2026-05-02T00:05:00Z' }),
      outage({ id: 3, server_id: 2, start_time: '2026-05-03T00:00:00Z', end_time: '2026-05-03T00:10:00Z' })
    ]
  };
  const out = analyzeNoise(inventory, NOW);
  assert.equal(out.summary.median_mttr_min, 5);
});
