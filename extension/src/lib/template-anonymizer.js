// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-298: template anonymizer.
//
// Produces a client-de-identified copy of the template slice of an
// observations `inventory` - the three fields analyzeTemplates() reads:
//   { server_templates, server_group_details, template_monitoring_configs }
//
// Redaction is whitelist-by-construction AND token-by-construction: every
// output object is built fresh with ONLY the fields the analyzer consumes,
// and every free-text field is replaced with an opaque token. There is no
// surviving free-text channel, so the result is provably PII-free by shape
// (see assertAnonymizedInventory) rather than by best-effort scrubbing.
//
// Why tokens, not "scrub the addresses out of the text" (FMN-298 review):
// a metric's display `name` is NOT guaranteed to be a generic catalog
// string. For SNMP-monitored Fabric devices the metric `name` IS the
// customer-configured interface name (docs/api-discovery/multi-fabric-template.md
// line 80: `"eth0"`, `"wifi0"` -> on real tenants `"WAN-AcmeHQ"`, VDOM
// `"AcmeCorp-Prod"`, carrier `"Comcast-Primary"`, serials, site codes). A
// shape-blocklist (strip IP/host/email) cannot contain bare identifiers, so
// we don't try: metric names are replaced wholesale by tokens.
//
// Overlap is preserved EXACTLY. analyzeTemplates()'s overlap analysis is a
// Jaccard over metric-name Sets. We tokenize with a SINGLE GLOBAL map shared
// across every template, so a name common to two templates maps to the same
// token and a distinct name maps to a distinct token - a bijective
// relabelling, which leaves every set intersection/union (hence every
// Jaccard ratio) unchanged. This is why we do not need to touch the shared
// analyzer or the fetcher.
//
// Field treatment:
//   template name        -> "Template N"
//   group name           -> "Group N"   (except the stock group, preserved)
//   stock group name     -> "Default Monitoring Templates" verbatim (a
//                           FortiMonitor constant on every tenant, not a
//                           client identifier; analyzeTemplates keys its
//                           stock-template exemption off this exact string)
//   template + group ids -> synthetic numeric ids (referential integrity kept)
//   metric_names /
//   metrics_without_alerts -> opaque "m{n}" tokens (global bijective map)
//   total_metrics /
//   alerts_count         -> preserved verbatim (numeric, non-identifying)
//   tags, applied_servers,
//   url, template_type   -> DROPPED (never read by the analyzer)
//
// Determinism: templates are emitted in ascending real-id order and assigned
// synthetic ids 1..N; metric tokens are assigned in first-appearance order
// over that same deterministic scan. The same input always yields the same
// pack.
//
// Exactness caveat (FMN-298 review): "the anon audit == the raw audit" holds
// for WELL-FORMED input - string metric names and unique template ids, both
// guaranteed by the frontend fetcher (m.name is coerced to a string, empties
// excluded; FortiMonitor template ids are unique). A hand-built slice with a
// non-string metric name (dropped here, counted raw) or a duplicated template
// id could shift a count; neither is reachable from the live data flow.

import { extractTrailingId } from './observation-analyzers/_helpers.js';

// Must stay in lockstep with DEFAULT_TEMPLATE_GROUP_NAME in
// observation-analyzers/template.js - the analyzer's stock-template
// exemption compares the group name against this exact (lowercased) string.
const DEFAULT_TEMPLATE_GROUP_NAME = 'default monitoring templates';
const DEFAULT_TEMPLATE_GROUP_LABEL = 'Default Monitoring Templates';

// Token shapes the anonymized output must match. assertAnonymizedInventory
// enforces these; wrapTemplatePack refuses to export anything that doesn't.
const TEMPLATE_NAME_RE = /^Template \d+$/;
const GROUP_NAME_RE = /^Group \d+$/;
const METRIC_TOKEN_RE = /^m\d+$/;
const SYN_ID_RE = /^\d+$/;
const SYN_GROUP_URL_RE = /^\/server_group\/\d+$/;

const TEMPLATE_KEYS = ['id', 'name', 'server_group'];
const GROUP_KEYS = ['name'];
const CONFIG_KEYS = ['total_metrics', 'alerts_count', 'metric_names', 'metrics_without_alerts'];

/**
 * @typedef {Object} TemplateSlice
 * @property {Object[]} server_templates
 * @property {Object<string,Object>} server_group_details
 * @property {Object<string,Object>} template_monitoring_configs
 */

/**
 * @param {TemplateSlice} slice  the template slice of an observations inventory
 * @returns {{ inventory: TemplateSlice, tokenMap: { templates: Map<string,string>, groups: Map<string,string>, metrics: Map<string,string> } }}
 *   `inventory` is the anonymized, analyzer-ready slice. `tokenMap` maps
 *   real -> synthetic and is for tests / debugging ONLY - it is never
 *   written into an exported pack.
 */
export function anonymizeTemplateInventory(slice = {}) {
  const templatesIn = Array.isArray(slice.server_templates) ? slice.server_templates : [];
  const groupDetailsIn = isObject(slice.server_group_details) ? slice.server_group_details : {};
  const configsIn = isObject(slice.template_monitoring_configs) ? slice.template_monitoring_configs : {};

  // Resolve each template's real ids, then order deterministically.
  const entries = [];
  for (const t of templatesIn) {
    const realTid = (t?.id != null && t.id !== '') ? String(t.id) : extractTrailingId(t?.url);
    if (!realTid) continue;
    const realGid = extractTrailingId(t?.server_group);
    entries.push({ realTid, realGid, template: t });
  }
  entries.sort((a, b) => cmpNumericThenString(a.realTid, b.realTid));

  // Deterministic scan order over config tids: templated tids first (in
  // template order), then any orphan config tids (config with no template
  // row) in object order. Drives both the metric-token map and orphan emit.
  const configTidOrder = [];
  const seenCfgTid = new Set();
  for (const e of entries) {
    if (configsIn[e.realTid] && !seenCfgTid.has(e.realTid)) {
      configTidOrder.push(e.realTid);
      seenCfgTid.add(e.realTid);
    }
  }
  for (const tid of Object.keys(configsIn)) {
    if (!seenCfgTid.has(tid)) { configTidOrder.push(tid); seenCfgTid.add(tid); }
  }

  // Single GLOBAL metric-name -> token map (bijective; preserves Jaccard).
  const metricToken = new Map();
  const tokenFor = (name) => {
    let tok = metricToken.get(name);
    if (!tok) { tok = `m${metricToken.size + 1}`; metricToken.set(name, tok); }
    return tok;
  };
  for (const tid of configTidOrder) {
    const cfg = configsIn[tid];
    if (!isObject(cfg)) continue;
    for (const nm of asStringArray(cfg.metric_names)) tokenFor(nm);
    for (const nm of asStringArray(cfg.metrics_without_alerts)) tokenFor(nm);
  }

  const groupSyn = new Map();          // realGid -> synthetic gid (numeric string)
  const synGroupDetails = {};
  let gCounter = 0;
  const assignGroup = (realGid) => {
    if (realGid == null) return null;
    if (groupSyn.has(realGid)) return groupSyn.get(realGid);
    gCounter += 1;
    const syn = String(gCounter);
    groupSyn.set(realGid, syn);
    const realName = typeof groupDetailsIn[realGid]?.name === 'string' ? groupDetailsIn[realGid].name : '';
    const isStock = realName.trim().toLowerCase() === DEFAULT_TEMPLATE_GROUP_NAME;
    synGroupDetails[syn] = { name: isStock ? DEFAULT_TEMPLATE_GROUP_LABEL : `Group ${gCounter}` };
    return syn;
  };

  const templateSyn = new Map();       // realTid -> synthetic tid (numeric string)
  const synTemplates = [];
  const synConfigs = {};
  let tCounter = 0;

  const emitConfig = (synTid, cfg) => {
    synConfigs[synTid] = {
      total_metrics: numOr0(cfg.total_metrics),
      alerts_count: numOr0(cfg.alerts_count),
      metric_names: asStringArray(cfg.metric_names).map((n) => metricToken.get(n)),
      metrics_without_alerts: asStringArray(cfg.metrics_without_alerts).map((n) => metricToken.get(n))
    };
  };

  for (const e of entries) {
    tCounter += 1;
    const synTid = String(tCounter);
    templateSyn.set(e.realTid, synTid);
    const synGid = assignGroup(e.realGid);

    const tmpl = { id: synTid, name: `Template ${tCounter}` };
    if (synGid != null) tmpl.server_group = `/server_group/${synGid}`;
    synTemplates.push(tmpl);

    const cfg = configsIn[e.realTid];
    if (isObject(cfg)) emitConfig(synTid, cfg);
  }

  // Orphan configs: a config keyed by a tid with no template row. The
  // analyzer iterates monitoring configs directly (Template #id fallback
  // name), so we must emit them too or the anonymized audit would under-count
  // relative to the live one. They get fresh synthetic tids and no template
  // row (mirroring the "config without a template" shape).
  for (const tid of Object.keys(configsIn)) {
    if (templateSyn.has(tid)) continue;
    const cfg = configsIn[tid];
    if (!isObject(cfg)) continue;
    tCounter += 1;
    const synTid = String(tCounter);
    templateSyn.set(tid, synTid);
    emitConfig(synTid, cfg);
  }

  return {
    inventory: {
      server_templates: synTemplates,
      server_group_details: synGroupDetails,
      template_monitoring_configs: synConfigs
    },
    tokenMap: { templates: templateSyn, groups: groupSyn, metrics: metricToken }
  };
}

/**
 * Structural proof that an inventory is anonymized: every field is a known
 * token/count/stock-literal shape, so there is no free-text channel that
 * could carry a client identifier. Throws (does not return false) with a
 * message naming the first violation. wrapTemplatePack runs this before it
 * will stamp a pack `anonymized: true` - so a raw or mis-wired inventory
 * fails loudly at export rather than shipping a mislabeled leak.
 *
 * @returns {true}
 */
export function assertAnonymizedInventory(inv) {
  if (!isObject(inv)) throw anonError('anonymized inventory must be an object');

  for (const t of (Array.isArray(inv.server_templates) ? inv.server_templates : [])) {
    if (!isObject(t)) throw anonError('template entry must be an object');
    if (!TEMPLATE_NAME_RE.test(t.name)) throw anonError(`template name not tokenized: ${JSON.stringify(t.name)}`);
    if (!SYN_ID_RE.test(String(t.id))) throw anonError(`template id not synthetic: ${JSON.stringify(t.id)}`);
    if (t.server_group != null && !SYN_GROUP_URL_RE.test(t.server_group)) {
      throw anonError(`template server_group not synthetic: ${JSON.stringify(t.server_group)}`);
    }
    for (const k of Object.keys(t)) {
      if (!TEMPLATE_KEYS.includes(k)) throw anonError(`template carries unexpected field "${k}"`);
    }
  }

  const groups = isObject(inv.server_group_details) ? inv.server_group_details : {};
  for (const [gid, g] of Object.entries(groups)) {
    if (!SYN_ID_RE.test(gid)) throw anonError(`group id not synthetic: ${JSON.stringify(gid)}`);
    if (!isObject(g)) throw anonError('group entry must be an object');
    if (g.name !== DEFAULT_TEMPLATE_GROUP_LABEL && !GROUP_NAME_RE.test(g.name)) {
      throw anonError(`group name not tokenized: ${JSON.stringify(g.name)}`);
    }
    for (const k of Object.keys(g)) {
      if (!GROUP_KEYS.includes(k)) throw anonError(`group carries unexpected field "${k}"`);
    }
  }

  const cfgs = isObject(inv.template_monitoring_configs) ? inv.template_monitoring_configs : {};
  for (const [tid, c] of Object.entries(cfgs)) {
    if (!SYN_ID_RE.test(tid)) throw anonError(`config id not synthetic: ${JSON.stringify(tid)}`);
    if (!isObject(c)) throw anonError('config entry must be an object');
    if (!Number.isFinite(c.total_metrics) || !Number.isFinite(c.alerts_count)) {
      throw anonError('config counts must be finite numbers');
    }
    for (const arrKey of ['metric_names', 'metrics_without_alerts']) {
      const arr = c[arrKey];
      if (!Array.isArray(arr)) throw anonError(`config.${arrKey} must be an array`);
      for (const nm of arr) {
        if (!METRIC_TOKEN_RE.test(nm)) throw anonError(`metric name not tokenized in ${arrKey}: ${JSON.stringify(nm)}`);
      }
    }
    for (const k of Object.keys(c)) {
      if (!CONFIG_KEYS.includes(k)) throw anonError(`config carries unexpected field "${k}"`);
    }
  }
  return true;
}

export class TemplateAnonymizeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateAnonymizeError';
  }
}

function anonError(msg) {
  return new TemplateAnonymizeError(`Inventory is not anonymized: ${msg}`);
}

function asStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((v) => typeof v === 'string');
}

function numOr0(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Numeric-aware id comparison so "9" sorts before "10". Falls back to
// string compare when either side is non-numeric.
function cmpNumericThenString(a, b) {
  const aNum = /^\d+$/.test(a), bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}
