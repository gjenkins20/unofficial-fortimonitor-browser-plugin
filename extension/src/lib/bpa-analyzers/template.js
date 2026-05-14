// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// TemplateAnalyzer (FMN-132 + FMN-135 follow-up).
//
// Pre-FMN-135 the analyzer read template metrics out of
// `inventory.server_template_details` (populated by /v2/server_template/{id}).
// That endpoint returns metadata only (name, group, tags, applied_servers)
// - no agent_resource_type and no thresholds. As a result every analyzer
// path returned [] on real tenants and the operator saw four empty
// "No rows" sections (FMN-135 QA, 2026-05-01).
//
// Now we read from `inventory.template_monitoring_configs`, populated by
// BpaFrontendFetcher.collectTemplateConfigs() hitting
// /report/get_monitoring_config_data?server_id={template_id}. Each entry
// is { total_metrics, alerts_count, metric_names, metrics_without_alerts }.
//
// Default vs custom partitioning (FMN-135 follow-up #2, 2026-05-01):
// FortiMonitor ships stock templates inside a server group named exactly
// "Default Monitoring Templates" on every tenant. The operator wants
// these exempted from the default-only / cleanup / overlap analyses
// because they're stock and not subject to the same scrutiny - those
// findings target customer-built templates only. Stock templates still
// get listed in their own informational section that reports their
// metric / alert counts without prescriptive copy.
//
// findManualThresholdPatterns is unchanged - it still reads
// `inventory.server_resource_details` (deep mode only). That covers
// thresholds set on individual server instances, which is the lookup the
// operator confirmed is wanted as a deep-mode option.

import { extractTrailingId } from './_helpers.js';

const PATTERN_TOP_LIMIT = 20;
const PATTERN_MIN_OCCURRENCES = 3;
const CLEANUP_RATIO = 0.5;             // >=50% of metrics unalerted
const OVERLAP_RATIO = 0.6;             // Jaccard >=60% flags as overlapping

// FortiMonitor's stock templates ship in a server group with this exact
// name on every tenant. Match is case-insensitive but otherwise exact.
const DEFAULT_TEMPLATE_GROUP_NAME = 'default monitoring templates';

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
  const monitoringConfigs = inventory.template_monitoring_configs;
  const templates = Array.isArray(inventory.server_templates) ? inventory.server_templates : [];
  const groupDetails = inventory.server_group_details ?? {};

  const haveConfigs = monitoringConfigs
    && typeof monitoringConfigs === 'object'
    && Object.keys(monitoringConfigs).length > 0;

  if (!haveConfigs) {
    // No template monitoring config data fetched - the template-driven
    // analyses cannot run. The manual_threshold path still can if deep
    // mode populated server_resource_details.
    return {
      available: false,
      note: 'No template monitoring configs available. The frontend fetcher must be enabled to populate template metric data.',
      manual_threshold_candidates: findManualThresholdPatterns(inventory)
    };
  }

  const nameById = buildTemplateNameMap(templates);

  // Partition templates by membership in the "Default Monitoring
  // Templates" group. Custom templates feed the urgent-fix analyses;
  // default templates get their own informational section.
  const defaultTids = new Set();
  for (const t of templates) {
    if (isDefaultTemplate(t, groupDetails)) {
      const tid = (t?.id != null && t.id !== '') ? String(t.id) : extractTrailingId(t?.url);
      if (tid) defaultTids.add(tid);
    }
  }
  const customConfigs = {};
  for (const [tid, cfg] of Object.entries(monitoringConfigs)) {
    if (!defaultTids.has(tid)) customConfigs[tid] = cfg;
  }

  return {
    available: true,
    default_only_templates:      findDefaultOnlyTemplates(customConfigs, nameById),
    manual_threshold_candidates: findManualThresholdPatterns(inventory),
    cleanup_candidates:          findCleanupCandidates(customConfigs, nameById),
    overlapping_templates:       findOverlapping(customConfigs, nameById),
    default_templates:           buildDefaultTemplatesOverview(monitoringConfigs, nameById, defaultTids)
  };
}

/**
 * A template is "default" (FortiMonitor stock) when it belongs to a
 * server group named "Default Monitoring Templates" - the canonical
 * group name FortiMonitor seeds on every tenant. We look the group up
 * via inventory.server_group_details (already populated by BpaFetcher's
 * group-details pass).
 */
function isDefaultTemplate(template, groupDetails) {
  const groupUrl = template?.server_group;
  if (typeof groupUrl !== 'string' || !groupUrl) return false;
  const gid = extractTrailingId(groupUrl);
  if (!gid) return false;
  const detail = groupDetails?.[gid];
  if (!detail || typeof detail.name !== 'string') return false;
  return detail.name.trim().toLowerCase() === DEFAULT_TEMPLATE_GROUP_NAME;
}

/**
 * Inform-don't-scrutinize listing of FortiMonitor's stock default
 * templates. Surfaces which stock templates exist on the tenant and
 * how many of their metrics carry alerting thresholds.
 */
function buildDefaultTemplatesOverview(monitoringConfigs, nameById, defaultTids) {
  const results = [];
  for (const tid of defaultTids) {
    const cfg = monitoringConfigs[tid];
    if (!cfg) continue;
    const total = cfg.total_metrics ?? 0;
    const alerts = cfg.alerts_count ?? 0;
    let observation;
    if (total === 0) {
      observation = 'Stock template carries no metric definitions (metadata only).';
    } else if (alerts === 0) {
      observation = `Stock template carries ${total} metric definitions and no alerting thresholds.`;
    } else {
      observation = `${alerts} of ${total} metrics on this stock template carry thresholds.`;
    }
    results.push({
      template: nameById.get(tid) || `Template #${tid}`,
      id: tid,
      metric_count: total,
      alerts_count: alerts,
      observation
    });
  }
  // Stable order: name asc.
  results.sort((a, b) => String(a.template).localeCompare(String(b.template)));
  return results;
}

/**
 * Build a tid -> display name lookup from inventory.server_templates.
 * Templates carry their numeric id in the URL path; ids without an
 * entry in this map fall back to "Template #{tid}" downstream.
 */
function buildTemplateNameMap(templates) {
  const out = new Map();
  for (const t of templates) {
    const tid = (t?.id != null && t.id !== '') ? String(t.id) : extractTrailingId(t?.url);
    if (!tid) continue;
    if (typeof t?.name === 'string' && t.name) out.set(tid, t.name);
  }
  return out;
}

/**
 * Templates that include metrics but have zero alert thresholds set.
 * These are the canonical "default-only" candidates - the FortiMonitor
 * stock template ships with metric definitions but no alerting, so no
 * incidents will fire on a server until thresholds are added.
 */
function findDefaultOnlyTemplates(monitoringConfigs, nameById) {
  const results = [];
  for (const [tid, cfg] of Object.entries(monitoringConfigs)) {
    if (!cfg) continue;
    const total = cfg.total_metrics ?? 0;
    const alerts = cfg.alerts_count ?? 0;
    if (total > 0 && alerts === 0) {
      results.push({
        template: nameById.get(tid) || `Template #${tid}`,
        id: tid,
        resource_count: total,
        network_service_count: 0,
        observation: `Custom template carries ${total} metric definitions and no alerting thresholds.`
      });
    }
  }
  return results;
}

/**
 * Templates where a majority of metrics carry no alert threshold.
 * Caught templates have *some* configured alerts but most metrics still
 * lack them - usually a partially-customized stock template that the
 * operator started tuning and never finished.
 */
function findCleanupCandidates(monitoringConfigs, nameById) {
  const results = [];
  for (const [tid, cfg] of Object.entries(monitoringConfigs)) {
    if (!cfg) continue;
    const total = cfg.total_metrics ?? 0;
    const alerts = cfg.alerts_count ?? 0;
    if (total === 0 || alerts === 0) continue;                // not a "partial" - covered by default-only
    const unalerted = total - alerts;
    if (unalerted < total * CLEANUP_RATIO) continue;
    const examples = Array.isArray(cfg.metrics_without_alerts) ? cfg.metrics_without_alerts.slice(0, 5) : [];
    results.push({
      template: nameById.get(tid) || `Template #${tid}`,
      id: tid,
      unchanged_metrics: unalerted,
      total_metrics: total,
      examples: examples.join(', '),
      observation: `${unalerted} of ${total} metrics on this template have no alerting threshold.`
    });
  }
  return results;
}

/**
 * Templates whose metric-name sets overlap substantially. Jaccard
 * similarity on metric names; >=60% suggests the templates duplicate
 * coverage and could be consolidated.
 */
function findOverlapping(monitoringConfigs, nameById) {
  /** @type {Map<string, Set<string>>} tid -> metric name set */
  const templateMetrics = new Map();
  for (const [tid, cfg] of Object.entries(monitoringConfigs)) {
    if (!cfg) continue;
    const names = Array.isArray(cfg.metric_names) ? cfg.metric_names : [];
    if (names.length === 0) continue;
    templateMetrics.set(tid, new Set(names));
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
        // FMN-147: carry both template IDs so the viewer can show them
        // and link to the template-edit page on the resolved tenant.
        results.push({
          id_1: t1,
          id_2: t2,
          template_1: nameById.get(t1) || `Template #${t1}`,
          template_2: nameById.get(t2) || `Template #${t2}`,
          overlap_pct: `${Math.round((overlap / union) * 100)}%`,
          shared_metrics: overlap,
          observation: `${overlap} of ${union} metric names overlap between these two templates.`
        });
      }
    }
  }
  return results;
}

/**
 * Across all servers' resource details, count threshold patterns
 * (resource_type, warning, critical). Patterns that recur on >=3 servers
 * are candidates for promotion to a template.
 *
 * Reads inventory.server_resource_details which is only populated when
 * the BPA was run with deep mode on. Returns [] otherwise (the viewer
 * shows the "no patterns detected" empty-state).
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
      observation: `${p.count} servers share identical manual thresholds for ${p.type} (warn=${p.warn}, crit=${p.crit}).`
    });
  }
  return results;
}

function intersectSize(a, b) {
  let n = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) n++;
  return n;
}
