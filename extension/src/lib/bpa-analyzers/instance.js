// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// InstanceAnalyzer port (FMN-132). Source: fortimonitor_audit.py / class InstanceAnalyzer.
//
// Operates over deep-mode inventory (server_resources + server_resource_details).
// Without those keys, returns { available: false, note }.

import { counter, rowName } from './_helpers.js';

const COMMON_THRESHOLD_PCT = 0.7;        // resource type must appear in >=70% of peers
const MISSING_FINDING_LIMIT = 50;
const VALUELESS_TOP_SERVERS = 20;
const VALUELESS_FINDING_LIMIT = 100;

/**
 * @typedef {Object} InstanceResult
 * @property {boolean} available
 * @property {string} [note]
 * @property {Object[]} [missing_settings]
 * @property {Object[]} [valueless_metrics]
 */

export function analyzeInstances(inventory = {}) {
  const sr = inventory.server_resources;
  if (!sr || typeof sr !== 'object' || Object.keys(sr).length === 0) {
    return {
      available: false,
      note: 'Run with deep mode (deep:true) for full instance analysis.'
    };
  }
  return {
    available: true,
    missing_settings: findMissingSettings(inventory),
    valueless_metrics: findValuelessMetrics(inventory)
  };
}

/**
 * Group servers by template URL. Within each group of >=2 servers, find
 * resource types that >=70% of peers have but this server is missing,
 * AND threshold sets that most peers have configured.
 */
function findMissingSettings(inventory) {
  const servers = Array.isArray(inventory.servers) ? inventory.servers : [];
  const serverResources = inventory.server_resources ?? {};
  const serverResourceDetails = inventory.server_resource_details ?? {};

  // template_url -> [server, ...]
  const templateGroups = new Map();
  for (const s of servers) {
    const tmpl = s?.server_template;
    let key = null;
    if (typeof tmpl === 'string' && tmpl) key = tmpl;
    else if (tmpl && typeof tmpl === 'object') key = tmpl.url ?? 'none';
    if (key == null) continue;
    let bucket = templateGroups.get(key);
    if (!bucket) { bucket = []; templateGroups.set(key, bucket); }
    bucket.push(s);
  }

  const findings = [];
  for (const [, groupServers] of templateGroups) {
    if (groupServers.length < 2) continue;

    /** @type {Map<string, Set<string>>} server-id -> resource-type names present */
    const resourceSets = new Map();
    /** @type {Map<string, Set<string>>} server-id -> type names with thresholds */
    const thresholdSets = new Map();

    for (const s of groupServers) {
      const sid = String(s?.id ?? '');
      const resources = Array.isArray(serverResources[sid]) ? serverResources[sid] : [];
      const resTypes = new Set();
      const threshTypes = new Set();
      for (const r of resources) {
        const typeName = resourceTypeName(r);
        if (typeName) resTypes.add(typeName);
        const rid = String(r?.id ?? '');
        const detail = serverResourceDetails[sid]?.[rid] ?? {};
        const thresholds = Array.isArray(detail.agent_resource_threshold)
          ? detail.agent_resource_threshold : [];
        if (thresholds.length > 0 && typeName) threshTypes.add(typeName);
      }
      resourceSets.set(sid, resTypes);
      thresholdSets.set(sid, threshTypes);
    }

    if (resourceSets.size === 0) continue;

    const allTypes = counter(
      [...resourceSets.values()].flatMap((s) => [...s])
    );
    const allThresh = counter(
      [...thresholdSets.values()].flatMap((s) => [...s])
    );
    const threshold = Math.max(1, Math.floor(groupServers.length * COMMON_THRESHOLD_PCT));
    const commonTypes = new Set(
      [...allTypes].filter(([, c]) => c >= threshold).map(([t]) => t)
    );
    const commonThresholds = new Set(
      [...allThresh].filter(([, c]) => c >= threshold).map(([t]) => t)
    );

    for (const s of groupServers) {
      const sid = String(s?.id ?? '');
      const sname = rowName(s, sid);
      const myRes = resourceSets.get(sid) ?? new Set();
      const myThresh = thresholdSets.get(sid) ?? new Set();
      const missingRes = setDiff(commonTypes, myRes);
      const missingThresh = setDiff(commonThresholds, myThresh);
      for (const mr of missingRes) {
        findings.push({
          server: sname,
          missing: mr,
          type: 'Resource',
          recommendation: `Add '${mr}' monitoring to match peers in the same template group.`
        });
      }
      for (const mt of missingThresh) {
        if (missingRes.has(mt)) continue;
        findings.push({
          server: sname,
          missing: `${mt} (threshold)`,
          type: 'Threshold',
          recommendation: `Configure thresholds for '${mt}' to match peers.`
        });
      }
    }
  }

  findings.sort((a, b) => a.server < b.server ? -1 : a.server > b.server ? 1 : 0);
  return findings.slice(0, MISSING_FINDING_LIMIT);
}

/**
 * Resources collected without thresholds = collecting metrics with no
 * alerting value. Limit to top-20 worst-offender servers, then per-row cap.
 */
function findValuelessMetrics(inventory) {
  const servers = Array.isArray(inventory.servers) ? inventory.servers : [];
  const serverMap = new Map();
  for (const s of servers) {
    serverMap.set(String(s?.id ?? ''), rowName(s, ''));
  }
  const serverResources = inventory.server_resources ?? {};
  const serverResourceDetails = inventory.server_resource_details ?? {};

  const findings = [];
  for (const [sid, resources] of Object.entries(serverResources)) {
    if (!Array.isArray(resources)) continue;
    const sname = serverMap.get(sid) || sid;
    for (const r of resources) {
      const rid = String(r?.id ?? '');
      const typeName = resourceTypeName(r);
      const detail = serverResourceDetails[sid]?.[rid] ?? {};
      const thresholds = Array.isArray(detail.agent_resource_threshold)
        ? detail.agent_resource_threshold : [];
      if (thresholds.length === 0) {
        findings.push({
          server: sname,
          metric: typeName || `Resource #${rid}`,
          recommendation: 'No thresholds configured. Remove to improve performance or add thresholds for value.'
        });
      }
    }
  }

  // Cap to the 20 servers with the most valueless metrics.
  const perServer = counter(findings, (f) => f.server);
  const topServers = new Set(
    [...perServer.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, VALUELESS_TOP_SERVERS)
      .map(([s]) => s)
  );
  const filtered = findings.filter((f) => topServers.has(f.server));
  filtered.sort((a, b) => {
    if (a.server !== b.server) return a.server < b.server ? -1 : 1;
    return a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0;
  });
  return filtered.slice(0, VALUELESS_FINDING_LIMIT);
}

function resourceTypeName(r) {
  const rt = r?.agent_resource_type;
  if (rt && typeof rt === 'object') return String(rt.name ?? '');
  if (rt != null) return String(rt);
  return '';
}

function setDiff(a, b) {
  const out = new Set();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}
