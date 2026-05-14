// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// IncidentAnalyzer port (FMN-132). Source: fortimonitor_audit.py / class IncidentAnalyzer.
//
// Pure function over the BpaInventory. No IO, no DOM, no chrome.* APIs.

import { counter, mostCommon, serverDisplayName, parseTimestamp } from './_helpers.js';

const TOP_INSTANCE_LIMIT = 15;
const TOP_TYPE_LIMIT = 15;
const NOISY_LIMIT = 20;
// Outages shorter than 30 minutes count as "short-lived" for the noise heuristic.
const SHORT_LIVED_SECONDS = 1800;

/**
 * @typedef {Object} IncidentResult
 * @property {number} active_count
 * @property {number} resolved_count
 * @property {{key:string,count:number}[]} top_by_instance
 * @property {{key:string,count:number}[]} top_by_type
 * @property {Object[]} active_details
 * @property {Object} trending
 * @property {Object[]} noisy_metrics
 */

/**
 * Run the incident analyzer.
 * @param {Object} inventory  BpaInventory dict from FMN-131's BpaFetcher.
 * @returns {IncidentResult}
 */
export function analyzeIncidents(inventory = {}) {
  const outages = Array.isArray(inventory.outages) ? inventory.outages : [];
  const active = outages.filter((o) => o?.active === true);
  const resolved = outages.filter((o) => o?.active !== true);

  return {
    active_count: active.length,
    resolved_count: resolved.length,
    top_by_instance: topByInstance(outages),
    top_by_type: topByType(outages, inventory.outage_logs ?? {}),
    active_details: activeDetails(active),
    trending: trending(inventory),
    noisy_metrics: noisyMetrics(outages)
  };
}

function topByInstance(outages) {
  return mostCommon(counter(outages, serverDisplayName), TOP_INSTANCE_LIMIT);
}

function topByType(outages, outageLogs) {
  const typeOf = (o) => {
    const oid = String(o?.id ?? '');
    const logs = Array.isArray(outageLogs?.[oid]) ? outageLogs[oid] : [];
    const fromLogs = extractCheckType(logs);
    if (fromLogs) return fromLogs;
    const sev = o?.severity ?? 'unknown';
    return capitalize(String(sev));
  };
  return mostCommon(counter(outages, typeOf), TOP_TYPE_LIMIT);
}

/**
 * Pull a check-type string out of an outage log. Mirrors the Python regexes:
 *   "Incident detected <CheckType> (host)"
 *   "detected ... for|on <thing>"
 */
export function extractCheckType(logs) {
  for (const entry of logs) {
    const desc = String(entry?.description ?? entry?.text ?? '');
    const m1 = desc.match(/Incident detected\s+(.+?)\s*\(/);
    if (m1) return m1[1].trim();
    const m2 = desc.match(/detected.*?(?:for|on)\s+(.+?)(?:\.|$)/);
    if (m2) return m2[1].trim();
  }
  return null;
}

function activeDetails(active) {
  return active.map((o) => ({
    server: serverDisplayName(o),
    id: o?.id ?? '',
    severity: o?.severity ?? 'unknown',
    acknowledged: Boolean(o?.acknowledged),
    started: o?.start_time ?? o?.created ?? ''
  }));
}

function trending(inventory) {
  const stats7  = inventory.outage_stats_7d  ?? {};
  const stats30 = inventory.outage_stats_30d ?? {};
  const stats60 = inventory.outage_stats_60d ?? {};

  const total7  = readTotal(stats7);
  const total30 = readTotal(stats30);
  const total60 = readTotal(stats60);

  // Week-over-week: estimate the prior 7 days as (30d - last 7d) / ~3.
  const priorWeek = total30 > total7 ? Math.floor(Math.max(0, total30 - total7) / 3) : 0;
  // Month-over-month: prior 30 days = days 31-60 = total60 - total30.
  const priorMonth = Math.max(0, total60 - total30);

  return {
    last_7d:          total7,
    prior_week_est:   priorWeek,
    week_change:      total7 - priorWeek,
    week_trend:       trendLabel(total7, priorWeek),
    last_30d:         total30,
    prior_month_est:  priorMonth,
    month_change:     total30 - priorMonth,
    month_trend:      trendLabel(total30, priorMonth),
    critical_7d:      readSeverity(stats7,  'critical'),
    warning_7d:       readSeverity(stats7,  'warning'),
    critical_30d:     readSeverity(stats30, 'critical'),
    warning_30d:      readSeverity(stats30, 'warning'),
    stats_7d:         stats7,
    stats_30d:        stats30
  };
}

function readTotal(s) {
  if (!s || typeof s !== 'object') return 0;
  const t = s.total ?? s.total_outages ?? 0;
  return Number.isFinite(t) ? t : 0;
}

function readSeverity(s, key) {
  if (!s || typeof s !== 'object') return 0;
  const bySev = s.by_severity ?? s.severity_breakdown ?? {};
  if (!bySev || typeof bySev !== 'object') return 0;
  const v = bySev[key];
  return Number.isFinite(v) ? v : 0;
}

/**
 * Stable / Up N% / Down N% / New activity label. Threshold ±20% matches Python.
 */
export function trendLabel(current, previous) {
  if (previous === 0 && current === 0) return 'Stable';
  if (previous === 0) return 'New activity';
  const pct = ((current - previous) / previous) * 100;
  if (pct > 20)  return `Up ${Math.round(pct)}%`;
  if (pct < -20) return `Down ${Math.round(Math.abs(pct))}%`;
  return 'Stable';
}

function noisyMetrics(outages) {
  // Group resolved outages by server.
  const byServer = new Map();
  for (const o of outages) {
    if (o?.active === true) continue;
    const name = serverDisplayName(o);
    let arr = byServer.get(name);
    if (!arr) { arr = []; byServer.set(name, arr); }
    arr.push(o);
  }

  const noisy = [];
  for (const [server, outs] of byServer) {
    if (outs.length < 3) continue;
    let shortLived = 0;
    for (const o of outs) {
      const start = parseTimestamp(o?.start_time);
      const end   = parseTimestamp(o?.end_time);
      if (start && end) {
        const seconds = (end.getTime() - start.getTime()) / 1000;
        if (Number.isFinite(seconds) && seconds < SHORT_LIVED_SECONDS) shortLived++;
      }
    }
    if (shortLived >= 2 || outs.length >= 5) {
      noisy.push({
        server,
        total_incidents: outs.length,
        short_lived: shortLived,
        observation: shortLived >= 2
          ? `${shortLived} of ${outs.length} resolved outages on this server were short-lived (under 30 min).`
          : `${outs.length} resolved outages on this server, none short-lived.`
      });
    }
  }

  noisy.sort((a, b) => b.total_incidents - a.total_incidents);
  return noisy.slice(0, NOISY_LIMIT);
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
