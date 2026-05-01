// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// TemplateAnalyzer port (FMN-132). Source: fortimonitor_audit.py / class TemplateAnalyzer.

import { counter } from './_helpers.js';

const PATTERN_TOP_LIMIT = 20;
const PATTERN_MIN_OCCURRENCES = 3;
const CLEANUP_RATIO = 0.5;             // >=50% of metrics unchanged
const OVERLAP_RATIO = 0.6;             // Jaccard >=60% flags as overlapping

/**
 * @typedef {Object} TemplateResult
 * @property {boolean} available
 * @property {string} [note]
 * @property {Object[]} [default_only_templates]
 * @property {Object[]} [manual_threshold_candidates]
 * @property {Object[]} [cleanup_candidates]
 * @property {Object[]} [overlapping_templates]
 */

export function analyzeTemplates(inventory = {}) {
  const td = inventory.server_template_details;
  if (!td || typeof td !== 'object' || Object.keys(td).length === 0) {
    return { available: false, note: 'No template details available.' };
  }
  return {
    available: true,
    default_only_templates:      findDefaultOnlyTemplates(td),
    manual_threshold_candidates: findManualThresholdPatterns(inventory),
    cleanup_candidates:          findCleanupCandidates(td),
    overlapping_templates:       findOverlapping(td)
  };
}

/**
 * Templates that include metrics but have no custom thresholds set on
 * any of them.
 */
function findDefaultOnlyTemplates(templateDetails) {
  const results = [];
  for (const [tid, detail] of Object.entries(templateDetails)) {
    const name = detail?.name || `Template #${tid}`;
    const artList = Array.isArray(detail?.agent_resource_type) ? detail.agent_resource_type : [];
    const nsList = Array.isArray(detail?.network_service) ? detail.network_service : [];

    let hasCustomization = false;
    for (const art of artList) {
      const thresholds = Array.isArray(art?.agent_resource_threshold) ? art.agent_resource_threshold : [];
      if (thresholds.length > 0) { hasCustomization = true; break; }
    }
    if (!hasCustomization && (artList.length > 0 || nsList.length > 0)) {
      results.push({
        template: name,
        id: tid,
        resource_count: artList.length,
        network_service_count: nsList.length,
        recommendation: 'Template has metrics but no custom thresholds. Add thresholds to provide alerting value.'
      });
    }
  }
  return results;
}

/**
 * Across all servers' resource details, count threshold patterns
 * (resource_type, warning, critical). Patterns that recur on >=3 servers
 * are candidates for promotion to a template.
 */
function findManualThresholdPatterns(inventory) {
  const srd = inventory.server_resource_details;
  if (!srd || typeof srd !== 'object' || Object.keys(srd).length === 0) return [];

  const servers = Array.isArray(inventory.servers) ? inventory.servers : [];
  const serverMap = new Map();
  for (const s of servers) {
    serverMap.set(String(s?.id ?? ''), s?.name ?? '');
  }

  // key: "type|warn|crit" -> { count, servers: Set<string> }
  const patterns = new Map();
  for (const [sid, resources] of Object.entries(srd)) {
    if (!resources || typeof resources !== 'object') continue;
    const sname = serverMap.get(sid) || sid;
    for (const detail of Object.values(resources)) {
      const rt = detail?.agent_resource_type;
      const typeName = rt && typeof rt === 'object' ? String(rt.name ?? '') : String(rt ?? '');
      const thresholds = Array.isArray(detail?.agent_resource_threshold) ? detail.agent_resource_threshold : [];
      for (const thresh of thresholds) {
        const warn = thresh?.warning ?? thresh?.warning_threshold;
        const crit = thresh?.critical ?? thresh?.critical_threshold;
        const key = `${typeName}|${warn}|${crit}`;
        let entry = patterns.get(key);
        if (!entry) {
          entry = { type: typeName, warn, crit, count: 0, servers: [] };
          patterns.set(key, entry);
        }
        entry.count += 1;
        if (!entry.servers.includes(sname)) entry.servers.push(sname);
      }
    }
  }

  const sorted = [...patterns.values()].sort((a, b) => b.count - a.count).slice(0, PATTERN_TOP_LIMIT);
  const results = [];
  for (const p of sorted) {
    if (p.count < PATTERN_MIN_OCCURRENCES) continue;
    results.push({
      metric_type: p.type,
      warning_threshold: p.warn,
      critical_threshold: p.crit,
      server_count: p.count,
      example_servers: p.servers.slice(0, 5).join(', '),
      recommendation: `Create a template with ${p.type} thresholds (warn=${p.warn}, crit=${p.crit}) - used on ${p.count} servers.`
    });
  }
  return results;
}

function findCleanupCandidates(templateDetails) {
  const results = [];
  for (const [tid, detail] of Object.entries(templateDetails)) {
    const name = detail?.name || `Template #${tid}`;
    const artList = Array.isArray(detail?.agent_resource_type) ? detail.agent_resource_type : [];
    if (artList.length === 0) continue;
    const unchanged = [];
    for (const art of artList) {
      const artName = art?.name || 'Unknown';
      const thresholds = Array.isArray(art?.agent_resource_threshold) ? art.agent_resource_threshold : [];
      if (thresholds.length === 0) unchanged.push(artName);
    }
    if (unchanged.length > 0 && unchanged.length >= artList.length * CLEANUP_RATIO) {
      results.push({
        template: name,
        id: tid,
        unchanged_metrics: unchanged.length,
        total_metrics: artList.length,
        examples: unchanged.slice(0, 5).join(', '),
        recommendation: 'Remove unchanged default metrics to speed up template application and avoid unintended changes.'
      });
    }
  }
  return results;
}

function findOverlapping(templateDetails) {
  /** @type {Map<string, Set<string>>} tid -> metric name set */
  const templateMetrics = new Map();
  /** @type {Map<string, string>} */
  const templateNames = new Map();

  for (const [tid, detail] of Object.entries(templateDetails)) {
    const name = detail?.name || `Template #${tid}`;
    templateNames.set(tid, name);
    const artList = Array.isArray(detail?.agent_resource_type) ? detail.agent_resource_type : [];
    const metrics = new Set();
    for (const art of artList) {
      const artName = art?.name;
      if (artName) metrics.add(artName);
    }
    templateMetrics.set(tid, metrics);
  }

  const results = [];
  const tids = [...templateMetrics.keys()];
  for (let i = 0; i < tids.length; i++) {
    for (let j = i + 1; j < tids.length; j++) {
      const t1 = tids[i], t2 = tids[j];
      const m1 = templateMetrics.get(t1) ?? new Set();
      const m2 = templateMetrics.get(t2) ?? new Set();
      if (m1.size === 0 || m2.size === 0) continue;
      const overlap = intersectSize(m1, m2);
      const union = m1.size + m2.size - overlap;
      if (union > 0 && overlap / union >= OVERLAP_RATIO) {
        results.push({
          template_1: templateNames.get(t1),
          template_2: templateNames.get(t2),
          overlap_pct: `${Math.round((overlap / union) * 100)}%`,
          shared_metrics: overlap,
          recommendation: `Consider merging - ${overlap}/${union} metrics overlap.`
        });
      }
    }
  }
  return results;
}

function intersectSize(a, b) {
  let n = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) n++;
  return n;
}
