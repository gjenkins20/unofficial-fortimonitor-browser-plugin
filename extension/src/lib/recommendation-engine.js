// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-195: Stock Fabric Templates recommendation engine.
//
// Pure logic; no Chrome / fetch / DOM dependencies. Testable in Node.
//
// Given a profile (from buildFabricProfile), the tenant's existing
// templates, FortiMonitor's stock templates, and FortiMonitor's live
// `nounOptions` vocabulary (from /monitoring_policy/get_page_data per
// FMN-194), emits a list of recommendations. The toolkit hard-codes NO
// device-family or model knowledge; matching is heuristic over the live
// inputs.
//
// Per recommendation:
//   - template: the best matching existing or stock template (chosen by
//     name regex, preferring model-specific over family-specific, and
//     existing over stock).
//   - policy_proposal: a Monitoring Policy clause that captures the
//     profile's Make + Model on the FortiMonitor side. Built from the
//     `nounOptions` vocabulary so the toolkit doesn't have to guess at
//     FortiMonitor's predicate textkey conventions.
//
// Sub #3 (FMN-196) is the consumer; it fetches the live inputs and feeds
// them in.

import { parseProfileKey } from './fabric-profile.js';

/**
 * @typedef {Object} TemplateRef
 * @property {number} id
 * @property {string} name
 * @property {string} [server_group_name]   Used to distinguish stock ("Default Monitoring Templates") from customer templates.
 *
 * @typedef {Object} NounOptionsDeviceType
 * @property {string} label
 * @property {string} value
 *
 * @typedef {Object} NounOptionsAttributeOption
 * @property {string} label
 * @property {string} value     Encoded as `"attribute,<textkey>"`.
 *
 * @typedef {Object} NounOptionsAttributeGroup
 * @property {string} label
 * @property {NounOptionsAttributeOption[]} options
 *
 * @typedef {Object} NounOptionsLive
 * @property {NounOptionsDeviceType[]} [device_types]
 * @property {NounOptionsAttributeGroup[]} [attribute_types]
 *
 * @typedef {Object} PolicyClause
 * @property {string} datatype
 * @property {string} match_type
 * @property {string | null} match_key
 * @property {string} match_value
 *
 * @typedef {Object} PolicyProposal
 * @property {string} name
 * @property {PolicyClause[]} clauses
 * @property {string[]} warnings
 *
 * @typedef {Object} ChosenTemplate
 * @property {number} id
 * @property {string} name
 * @property {'existing-model-specific'|'existing-family'|'stock-model-specific'|'stock-family'} source
 *
 * @typedef {Object} Recommendation
 * @property {string} profile_key
 * @property {string} make
 * @property {string} model
 * @property {string} connection_type
 * @property {number[]} applies_to_server_ids
 * @property {string[]} os_versions
 * @property {ChosenTemplate | null} chosen_template
 * @property {PolicyProposal} policy_proposal
 * @property {'matched' | 'no-template-found'} status
 *
 * @typedef {Object} EngineOutput
 * @property {Recommendation[]} recommendations
 */

const STOCK_GROUP_NAME = 'Default Monitoring Templates';

/**
 * Run the recommendation engine.
 *
 * @param {{ profiles: Map<string, any> }} profile
 * @param {Object} inputs
 * @param {TemplateRef[]} [inputs.existingTemplates]   All templates in the tenant. Stock ones (server_group_name === STOCK_GROUP_NAME) are partitioned out automatically.
 * @param {TemplateRef[]} [inputs.stockTemplates]      Optional explicit stock list (overrides the auto-partition).
 * @param {NounOptionsLive} [inputs.nounOptions]       Live vocabulary from /monitoring_policy/get_page_data.
 * @returns {EngineOutput}
 */
export function buildRecommendations(profile, inputs = {}) {
  const recommendations = [];
  if (!profile || !(profile.profiles instanceof Map)) {
    return { recommendations };
  }

  const { existing, stock } = partitionTemplates(inputs.existingTemplates, inputs.stockTemplates);
  const nounOptions = inputs.nounOptions ?? {};

  for (const [, p] of profile.profiles) {
    const chosen = findBestTemplate(p, existing, stock);
    const policy_proposal = buildPolicyProposal(p, nounOptions);
    recommendations.push({
      profile_key: p.key,
      make: p.make,
      model: p.model,
      connection_type: p.connection_type,
      applies_to_server_ids: [...p.server_ids],
      os_versions: [...p.os_versions],
      chosen_template: chosen,
      policy_proposal,
      status: chosen ? 'matched' : 'no-template-found'
    });
  }

  return { recommendations };
}

// ---------- template matching ----------

/**
 * Split a single templates list into existing vs stock by group name.
 * If caller passes explicit `stockTemplates`, that takes precedence.
 */
function partitionTemplates(allTemplates, explicitStock) {
  const all = Array.isArray(allTemplates) ? allTemplates : [];
  if (Array.isArray(explicitStock)) {
    const stockIds = new Set(explicitStock.map((t) => t.id));
    return {
      existing: all.filter((t) => !stockIds.has(t.id)),
      stock: explicitStock
    };
  }
  const existing = [];
  const stock = [];
  for (const t of all) {
    if (t && t.server_group_name === STOCK_GROUP_NAME) stock.push(t);
    else existing.push(t);
  }
  return { existing, stock };
}

/**
 * Find the best template for a profile. Priority:
 *   1. existing tenant template whose name contains the model SKU
 *   2. existing tenant template whose name contains the family/make
 *   3. stock template whose name contains the model SKU
 *   4. stock template whose name contains the family/make
 *   5. nothing
 */
function findBestTemplate(p, existing, stock) {
  return (
    firstMatch(existing, (t) => nameContains(t.name, p.model), 'existing-model-specific') ||
    firstMatch(existing, (t) => nameContains(t.name, p.make), 'existing-family') ||
    firstMatch(stock, (t) => nameContains(t.name, p.model), 'stock-model-specific') ||
    firstMatch(stock, (t) => nameContains(t.name, p.make), 'stock-family') ||
    null
  );
}

function firstMatch(list, predicate, source) {
  for (const t of list) {
    if (!t || typeof t.name !== 'string') continue;
    if (predicate(t)) return { id: t.id, name: t.name, source };
  }
  return null;
}

function nameContains(haystack, needle) {
  if (typeof haystack !== 'string' || typeof needle !== 'string' || needle === '') return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// ---------- policy proposal ----------

/**
 * Build a Monitoring Policy proposal for a profile using the live
 * nounOptions vocabulary. Strategy:
 *
 *   Family clause: look for a device_types option whose label or value
 *     references the make. If found, emit a `device_type` clause.
 *     (Captured FMN-194: FortiGate appears here as
 *      "[sub_type]fortinet.fortigate"; other Forti* families may not.)
 *
 *   Model clause: look in attribute_types for a group whose label matches
 *     the make. Inside, prefer a textkey ending in ".model" (covers
 *     fortigate.model, fortiswitch.model, etc.). Emit an `attribute`
 *     clause pinning that textkey to the profile's model value.
 *
 *   If neither is found, the engine still emits a proposal with whatever
 *   clauses it could build; `warnings[]` lists the missing pieces so the
 *   Configure step (sub #3) can surface them.
 */
function buildPolicyProposal(p, nounOptions) {
  const clauses = [];
  const warnings = [];

  const familyClause = pickFamilyClause(p.make, nounOptions);
  if (familyClause) clauses.push(familyClause);
  else warnings.push(`No device_types vocabulary entry for "${p.make}"; family clause omitted.`);

  const modelClause = pickModelClause(p.make, p.model, nounOptions);
  if (modelClause) clauses.push(modelClause);
  else warnings.push(`No attribute_types vocabulary for "${p.make}" model textkey; model clause omitted.`);

  return {
    name: `Apply Stock ${p.make} template`,
    clauses,
    warnings
  };
}

function pickFamilyClause(make, nounOptions) {
  // FMN-228 QA finding (2026-05-21):
  //   * device_type clauses in FortiMonitor's UI expose only match_type
  //     'pick_multiple' ("Is") and '!pick_multiple' ("Is Not"). pick_one
  //     renders blank in the operator dropdown.
  //   * pick_multiple match_value is a JSON ARRAY of option values, not
  //     a string. Sending a string leaves the value-slot empty in the
  //     rendered UI. Confirmed by capturing the editRuleset POST after
  //     an operator-built save:
  //       "match_value": ["[sub_type]fortinet.fortigate"]
  const list = Array.isArray(nounOptions?.device_types) ? nounOptions.device_types : [];
  const lower = make.toLowerCase();
  for (const opt of list) {
    if (!opt || typeof opt.label !== 'string') continue;
    if (opt.label.toLowerCase() === lower || opt.label.toLowerCase().includes(lower)) {
      return {
        datatype: 'device_type',
        match_type: 'pick_multiple',
        match_key: null,
        match_value: [opt.value]
      };
    }
  }
  return null;
}

function pickModelClause(make, model, nounOptions, sampleAttrs = {}) {
  // FMN-228 QA finding (2026-05-21): the attribute clause's
  // match_value must equal the live attribute value on the device
  // (e.g. fortigate.model="FGVMA6"), NOT the model field from
  // fabricSystemData (model_number like "VM64-AWS" - a different
  // namespace). When sampleAttrs[textkey] is missing, the clause is
  // omitted; the rule still matches by device_type alone. `model`
  // stays in the signature for backward-compat with callers that
  // haven't yet wired the sample-attr fetch.
  void model;
  const groups = Array.isArray(nounOptions?.attribute_types) ? nounOptions.attribute_types : [];
  const lowerMake = make.toLowerCase();
  let group = groups.find((g) => g && typeof g.label === 'string' && g.label.toLowerCase() === lowerMake);
  if (!group) {
    group = groups.find((g) => g && typeof g.label === 'string' && g.label.toLowerCase().includes(lowerMake));
  }
  if (!group || !Array.isArray(group.options)) return null;

  for (const opt of group.options) {
    if (!opt || typeof opt.value !== 'string') continue;
    const textkey = stripAttributeValuePrefix(opt.value);
    if (textkey.endsWith('.model')) {
      const liveValue = sampleAttrs[textkey];
      if (liveValue === undefined || liveValue === null || String(liveValue).trim() === '') {
        return null;
      }
      return {
        datatype: 'attribute',
        match_type: 'pick_one',
        match_key: textkey,
        match_value: String(liveValue)
      };
    }
  }
  return null;
}

function stripAttributeValuePrefix(value) {
  // nounOptions.attribute_types option values come encoded as
  // "attribute,<textkey>". The textkey is the bare key the policy clause
  // needs in match_key.
  if (typeof value !== 'string') return '';
  const i = value.indexOf(',');
  return i < 0 ? value : value.slice(i + 1);
}

// Re-export for callers that only import recommendation-engine.js
export { parseProfileKey };
