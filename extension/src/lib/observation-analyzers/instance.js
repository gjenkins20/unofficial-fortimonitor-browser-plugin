// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// InstanceAnalyzer port (FMN-132). Source: fortimonitor_audit.py / class InstanceAnalyzer.
//
// Operates over deep-mode inventory (server_resources + server_resource_details).
// Without those keys, returns { available: false, note }.

import { counter, rowName, extractTrailingId } from './_helpers.js';

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
  // Build the agent_resource_type catalog map once for both finders so
  // the URL-form r.agent_resource_type resolves to a friendly label
  // (FMN-135 follow-up #3, 2026-05-02).
  const typeMap = buildAgentResourceTypeMap(inventory.agent_resource_types);
  return {
    available: true,
    missing_settings: findMissingSettings(inventory, typeMap),
    valueless_metrics: findValuelessMetrics(inventory, typeMap)
  };
}

// Marker for empty values in the Server ID / Server Name columns. Used
// per the 2026-05-02 operator request to surface the column meaning
// unambiguously rather than falling back to a numeric id under either.
const NA = 'n/a';

/**
 * Group servers by template URL. Within each group of >=2 servers, find
 * resource types that >=70% of peers have but this server is missing,
 * AND threshold sets that most peers have configured.
 */
function findMissingSettings(inventory, typeMap) {
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
        const typeName = resourceTypeName(r, typeMap);
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
      const sidLabel  = sid || NA;
      const snameLabel = rowName(s, '') || NA;
      const myRes = resourceSets.get(sid) ?? new Set();
      const myThresh = thresholdSets.get(sid) ?? new Set();
      const missingRes = setDiff(commonTypes, myRes);
      const missingThresh = setDiff(commonThresholds, myThresh);
      for (const mr of missingRes) {
        findings.push({
          server_id: sidLabel,
          server_name: snameLabel,
          missing: mr,
          type: 'Resource',
          observation: `'${mr}' is collected on at least 70% of peers in the same template group; this server does not collect it.`
        });
      }
      for (const mt of missingThresh) {
        if (missingRes.has(mt)) continue;
        findings.push({
          server_id: sidLabel,
          server_name: snameLabel,
          missing: `${mt} (threshold)`,
          type: 'Threshold',
          observation: `Peers in the same template group have thresholds set for '${mt}'; this server does not.`
        });
      }
    }
  }

  // Stable order: by server name (with id as the tiebreaker so 'n/a'
  // collisions still sort deterministically).
  findings.sort((a, b) => {
    if (a.server_name !== b.server_name) return a.server_name < b.server_name ? -1 : 1;
    return a.server_id < b.server_id ? -1 : a.server_id > b.server_id ? 1 : 0;
  });
  return findings.slice(0, MISSING_FINDING_LIMIT);
}

/**
 * Resources collected without thresholds = collecting metrics with no
 * alerting value. Limit to top-20 worst-offender servers, then per-row cap.
 *
 * On real tenants `r.agent_resource_type` is a URL string pointing to
 * /v2/agent_resource_type/{id}. We resolve that against the catalogue
 * fetched as inventory.agent_resource_types so the row shows
 * "Apache: Requests/sec (reqs/s)" rather than the raw API URL
 * (FMN-135 follow-up #3, 2026-05-02).
 */
function findValuelessMetrics(inventory, typeMap) {
  const servers = Array.isArray(inventory.servers) ? inventory.servers : [];
  const nameById = new Map();
  for (const s of servers) {
    nameById.set(String(s?.id ?? ''), rowName(s, ''));
  }
  const serverResources = inventory.server_resources ?? {};
  const serverResourceDetails = inventory.server_resource_details ?? {};

  const findings = [];
  for (const [sid, resources] of Object.entries(serverResources)) {
    if (!Array.isArray(resources)) continue;
    const sidLabel = sid || NA;
    const snameLabel = (nameById.get(sid) || '') || NA;
    for (const r of resources) {
      const rid = String(r?.id ?? '');
      const typeName = resourceTypeName(r, typeMap) || `Resource #${rid}`;
      const detail = serverResourceDetails[sid]?.[rid] ?? {};
      const thresholds = Array.isArray(detail.agent_resource_threshold)
        ? detail.agent_resource_threshold : [];
      if (thresholds.length === 0) {
        findings.push({
          server_id: sidLabel,
          server_name: snameLabel,
          metric: typeName,
          observation: `Metric collected on this server with no alerting threshold; produces no incidents.`
        });
      }
    }
  }

  // Cap to the 20 servers with the most valueless metrics, keyed on
  // server_id (the stable identifier - server_name can collide on 'n/a'
  // across distinct servers).
  const perServer = counter(findings, (f) => f.server_id);
  const topServers = new Set(
    [...perServer.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, VALUELESS_TOP_SERVERS)
      .map(([s]) => s)
  );
  const filtered = findings.filter((f) => topServers.has(f.server_id));
  filtered.sort((a, b) => {
    if (a.server_name !== b.server_name) return a.server_name < b.server_name ? -1 : 1;
    if (a.server_id   !== b.server_id)   return a.server_id   < b.server_id   ? -1 : 1;
    return a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0;
  });
  return filtered.slice(0, VALUELESS_FINDING_LIMIT);
}

/**
 * Build id -> {category, label, unit, platform} from the catalog.
 * Each entry's id comes from the trailing path segment of `url`.
 */
function buildAgentResourceTypeMap(types) {
  const map = new Map();
  if (!Array.isArray(types)) return map;
  for (const t of types) {
    const id = extractTrailingId(t?.url);
    if (!id) continue;
    map.set(id, {
      category: typeof t?.category === 'string' ? t.category : '',
      label:    typeof t?.label === 'string'    ? t.label    : '',
      unit:     typeof t?.unit === 'string'     ? t.unit     : '',
      platform: typeof t?.platform === 'string' ? t.platform : ''
    });
  }
  return map;
}

/**
 * Resolve a server resource's `agent_resource_type` to a human label.
 * Handles three shapes seen in the wild:
 *   - object with .name        -> use .name (legacy / synthetic fixtures)
 *   - object with .category/.label -> format as "Category: Label (unit)"
 *   - URL string               -> look up in typeMap and format
 * Returns '' when nothing usable is present.
 */
function resourceTypeName(r, typeMap) {
  const rt = r?.agent_resource_type;
  if (!rt) return '';
  if (typeof rt === 'object') {
    if (typeof rt.name === 'string' && rt.name) return rt.name;
    if (rt.category || rt.label) return formatTypeLabel(rt);
    return '';
  }
  if (typeof rt === 'string') {
    const id = extractTrailingId(rt);
    if (id && typeMap && typeMap.has(id)) {
      return formatTypeLabel(typeMap.get(id));
    }
    return '';
  }
  return '';
}

function formatTypeLabel({ category, label, unit }) {
  let head;
  if (category && label) head = `${category}: ${label}`;
  else if (label)        head = String(label);
  else if (category)     head = String(category);
  else                   head = '';
  if (unit) return `${head} (${unit})`.trim();
  return head;
}

function setDiff(a, b) {
  const out = new Set();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}
