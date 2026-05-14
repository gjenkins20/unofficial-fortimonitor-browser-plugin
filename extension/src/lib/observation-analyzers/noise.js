// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// NoiseAnalyzer (FMN-156).
//
// Walks the inventory.outages list and ranks instances and metrics by
// behavioral noisiness over the last 30 days: outage count, total
// duration, MTTR, and flap rate (outages per 24h). Pure function over
// the ObservationsInventory; no IO, no DOM, no chrome.* APIs.
//
// Source data shape: see docs/api-discovery/outages.md. Each outage
// carries at minimum `start_time`, `end_time?`, `severity`, `status`,
// `server_id`, `server_name`, `description` (the check / metric name).
// Some fixtures and the legacy IncidentAnalyzer represent active state
// as a boolean `active`; we support both.

import { extractTrailingId, parseTimestamp } from './_helpers.js';

const TOP_INSTANCE_LIMIT = 20;
const TOP_METRIC_LIMIT = 20;
// Window of interest. The v2 endpoint already trims to roughly the last
// 30 days by default; this filter is belt-and-suspenders for any fixture
// or future expansion that returns older records.
const WINDOW_DAYS = 30;
// Flap threshold for the observation label. Anything above this is
// labelled as flap-pattern; below gets a milder volume / mttr label.
// Matches the FMN-156 ticket's heuristic boundary.
const FLAP_THRESHOLD_PER_24H = 1.5;
const HIGH_VOLUME_THRESHOLD = 5;

/**
 * @typedef {Object} NoisyInstanceRow
 * @property {string} server_id
 * @property {string} server_name
 * @property {number} outage_count_30d
 * @property {number} total_duration_min   sum of resolved-outage durations
 * @property {number} mttr_min             mean time to recovery (resolved outages only)
 * @property {number} flap_rate_per_24h    outage_count_30d / 30 (rounded to 2dp)
 * @property {string} observation
 */

/**
 * @typedef {Object} NoisyMetricRow
 * @property {string} metric_name
 * @property {string} server_id
 * @property {string} server_name
 * @property {number} count_30d
 * @property {string} observation
 */

/**
 * @typedef {Object} NoiseResult
 * @property {NoisyInstanceRow[]} top_noisy_instances
 * @property {NoisyMetricRow[]}   top_noisy_metrics
 * @property {{
 *   instances_with_outages: number,
 *   total_outages_30d:      number,
 *   median_mttr_min:        number,
 *   window_days:            number
 * }} summary
 */

/**
 * Run the noise analyzer over an inventory.
 *
 * @param {Object} inventory  ObservationsInventory dict from FMN-131's ObservationsFetcher
 * @param {Date}   [now]      injectable clock for tests
 * @returns {NoiseResult}
 */
export function analyzeNoise(inventory = {}, now = new Date()) {
  const outages = Array.isArray(inventory.outages) ? inventory.outages : [];
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * 86400000);

  // Filter to outages that started within the last WINDOW_DAYS days.
  // Outages with unparseable start_time are dropped (we cannot use them
  // for any duration / flap math).
  const inWindow = [];
  for (const o of outages) {
    const start = parseTimestamp(o?.start_time);
    if (!start) continue;
    if (start < cutoff) continue;
    inWindow.push({ outage: o, start });
  }

  // Group by server_id (preferred) / server_name fallback for older
  // fixtures that omit server_id.
  const byServer = new Map();
  for (const entry of inWindow) {
    const key = serverKey(entry.outage);
    let bucket = byServer.get(key);
    if (!bucket) {
      bucket = {
        server_id: key,
        server_name: serverName(entry.outage),
        entries: []
      };
      byServer.set(key, bucket);
    }
    bucket.entries.push(entry);
  }

  const allMttrSamples = [];
  const noisyInstances = [];
  for (const bucket of byServer.values()) {
    const count = bucket.entries.length;
    let totalDurationSec = 0;
    let resolvedCount = 0;
    const mttrSamples = [];
    for (const { outage, start } of bucket.entries) {
      if (!isResolved(outage)) continue;
      const end = parseTimestamp(outage?.end_time);
      if (!end) continue;
      const seconds = (end.getTime() - start.getTime()) / 1000;
      if (!Number.isFinite(seconds) || seconds < 0) continue;
      totalDurationSec += seconds;
      resolvedCount++;
      mttrSamples.push(seconds);
      allMttrSamples.push(seconds);
    }
    const totalDurationMin = Math.round(totalDurationSec / 60);
    const mttrMin = resolvedCount > 0
      ? Math.round((totalDurationSec / resolvedCount) / 60)
      : 0;
    const flapPer24h = Math.round((count / WINDOW_DAYS) * 100) / 100;
    noisyInstances.push({
      server_id: String(bucket.server_id),
      server_name: bucket.server_name,
      outage_count_30d: count,
      total_duration_min: totalDurationMin,
      mttr_min: mttrMin,
      flap_rate_per_24h: flapPer24h,
      observation: instanceObservation(count, flapPer24h, mttrMin)
    });
  }

  noisyInstances.sort((a, b) => {
    if (b.outage_count_30d !== a.outage_count_30d) {
      return b.outage_count_30d - a.outage_count_30d;
    }
    return b.total_duration_min - a.total_duration_min;
  });

  // Top noisy metrics: group by (server_id, description). Description
  // carries the check / metric label - see docs/api-discovery/outages.md.
  // Outages without a non-empty description are dropped from this list
  // (we cannot label the row meaningfully).
  const byMetric = new Map();
  for (const { outage } of inWindow) {
    const metric = metricName(outage);
    if (!metric) continue;
    const serverId = serverKey(outage);
    const key = `${serverId}::${metric}`;
    let bucket = byMetric.get(key);
    if (!bucket) {
      bucket = {
        metric_name: metric,
        server_id: String(serverId),
        server_name: serverName(outage),
        count: 0
      };
      byMetric.set(key, bucket);
    }
    bucket.count++;
  }
  const noisyMetrics = [...byMetric.values()]
    .filter((row) => row.count >= 2)
    .map((row) => ({
      metric_name: row.metric_name,
      server_id: row.server_id,
      server_name: row.server_name,
      count_30d: row.count,
      observation: metricObservation(row.count)
    }))
    .sort((a, b) => b.count_30d - a.count_30d)
    .slice(0, TOP_METRIC_LIMIT);

  return {
    top_noisy_instances: noisyInstances.slice(0, TOP_INSTANCE_LIMIT),
    top_noisy_metrics: noisyMetrics,
    summary: {
      instances_with_outages: byServer.size,
      total_outages_30d: inWindow.length,
      median_mttr_min: Math.round(median(allMttrSamples) / 60),
      window_days: WINDOW_DAYS
    }
  };
}

function isResolved(outage) {
  // The live /v2/outage shape uses `status: 'resolved' | 'active' | ...`;
  // legacy fixtures use `active: true | false` (no `status`). Treat as
  // resolved when status === 'resolved' OR (no status field and
  // active !== true). See docs/api-discovery/outages.md.
  const status = outage?.status;
  if (typeof status === 'string' && status) {
    return status === 'resolved';
  }
  return outage?.active !== true;
}

function serverKey(outage) {
  if (!outage) return 'unknown';
  if (outage.server_id != null && outage.server_id !== '') return String(outage.server_id);
  // Some records nest the id behind a `/v2/server/{id}` URL.
  if (typeof outage.server === 'string') {
    const id = extractTrailingId(outage.server);
    if (id) return id;
  }
  if (typeof outage.server_name === 'string' && outage.server_name) return outage.server_name;
  return 'unknown';
}

function serverName(outage) {
  if (!outage) return 'Unknown';
  if (typeof outage.server_name === 'string' && outage.server_name) return outage.server_name;
  if (outage.server && typeof outage.server === 'object' && typeof outage.server.name === 'string' && outage.server.name) {
    return outage.server.name;
  }
  if (typeof outage.server_fqdn === 'string' && outage.server_fqdn) return outage.server_fqdn;
  return 'Unknown';
}

function metricName(outage) {
  if (!outage) return '';
  // Live shape: description carries the check/metric label
  // (e.g. 'Agent Heartbeat'). The legacy fixture path may store the
  // metric on a nested `metric` or in the outage_logs sidecar, but the
  // shape we see in the wild is `description`.
  if (typeof outage.description === 'string' && outage.description.trim()) {
    return outage.description.trim();
  }
  return '';
}

function instanceObservation(count, flapPer24h, mttrMin) {
  if (flapPer24h >= FLAP_THRESHOLD_PER_24H) {
    return `Flap rate ${flapPer24h.toFixed(2)}/24h (${count} outages in ${WINDOW_DAYS} days).`;
  }
  if (count >= HIGH_VOLUME_THRESHOLD) {
    return `${count} outages in ${WINDOW_DAYS} days on this instance.`;
  }
  if (mttrMin <= 5 && count >= 3) {
    return `${count} outages in ${WINDOW_DAYS} days, MTTR ${mttrMin} min (short-lived dominant).`;
  }
  return `${count} outages in ${WINDOW_DAYS} days.`;
}

function metricObservation(count) {
  if (count >= 10) {
    return `${count} alerts fired on this metric in ${WINDOW_DAYS} days.`;
  }
  if (count >= 5) {
    return `${count} alerts fired on this metric in ${WINDOW_DAYS} days.`;
  }
  return `${count} alerts fired on this metric in ${WINDOW_DAYS} days.`;
}

function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
