// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Observations section -> data dependency map (FMN-149).
//
// Single source of truth for "which inventory keys does each analyzer
// section actually read?" Drives the selective fetcher (skip endpoints no
// requested section consumes), the frontend-fetcher gating (User Activity
// vs Templates), the analyzer dispatch (only run requested analyzers),
// and the viewer's tab-filter on the review step.
//
// Per planning doc docs/planning/tenant-observations-per-section-delivery.md §2.

import { isAllSelection, sanitize as sanitizeSections } from '../ui/tenant-observations/section-selection.js';

// Map from the wizard's analyzer-scoped section ids to the analyzer
// result keys on `analysis`. The viewer tabs are richer than the
// analyzers - one analyzer ("incidents") feeds two tabs (incident-summary
// + incidents). The pill row collapses those into a single "Incidents"
// pill, so the section -> analyzer mapping is one-to-one.
//
// FMN-156: post-operator-QA, the noise analyzer's output is folded into
// the Incident Summary tab (operator QA flagged the standalone tab as
// duplicative). The noise analyzer therefore co-runs with the incidents
// analyzer - selecting Incidents pulls both result keys.
export const SECTION_ANALYZER_KEY = Object.freeze({
  'incidents': 'incidents',
  'user-activity': 'users',
  'instance-analysis': 'instances',
  'template-recommendations': 'templates',
  'monitoring-policy': 'monitoring_policy',
  'duplicate-instances': 'duplicates'
});

// Additional analyzer result keys a section pulls beyond its primary
// mapping above. Kept as a separate map so each entry's intent ("this
// analyzer is ancillary to that section") is explicit rather than
// hiding inside a one-to-many primary map.
const SECTION_ANCILLARY_ANALYZER_KEYS = Object.freeze({
  'incidents': ['noise']
});

// Inventory keys touched by each analyzer-scoped section. Values listed
// here are the keys the ObservationsFetcher's top-level list pass populates; the
// trending-block, group-detail, template-detail, and deep-dive blocks
// have their own gating predicates below because their behavior is more
// nuanced than "fetch this list".
const SECTION_TOP_LEVEL_KEYS = Object.freeze({
  // FMN-156: noise analyzer feeds off outages too (folded into Incident
  // Summary - see SECTION_ANCILLARY_ANALYZER_KEYS), so incidents already
  // covers the fetcher requirement for both.
  'incidents': ['outages'],
  'user-activity': ['users'],
  'instance-analysis': ['servers', 'agent_resource_types'],
  'template-recommendations': ['server_templates'],
  'monitoring-policy': ['servers', 'server_groups', 'server_templates'],
  // Duplicate detection reads only the shallow /v2/server list (name +
  // fqdn) - no deep dive, no frontend augmentation.
  // analyzeDuplicates resolves each instance's Monitoring Location from the
  // collector behind primary_monitoring_node - a cloud monitoring_node OR an
  // OnSight appliance. Both lists are required so the location resolves on the
  // report path; without them (scoped mode) every location renders blank
  // (FMN-274 fix).
  'duplicate-instances': ['servers', 'monitoring_nodes', 'onsights']
});

// Cross-cutting tabs touch every fetcher domain (see planning doc §1).
// When a full report is requested ("all"), every key is fair game.
function selectionIncludes(sections, id) {
  return Array.isArray(sections) && sections.includes(id);
}

/**
 * Return the set of top-level inventory keys that the ObservationsFetcher must
 * collect for the given selection. ["all"] returns null, signalling "no
 * filter, fetch the full set" (preserves today's behavior).
 *
 * @param {string[]} sections
 * @returns {Set<string> | null}  null when no filter applies
 */
export function topLevelKeysForSections(sections) {
  const sel = sanitizeSections(sections);
  if (isAllSelection(sel)) return null;
  const out = new Set();
  for (const s of sel) {
    const keys = SECTION_TOP_LEVEL_KEYS[s];
    if (!keys) continue;
    for (const k of keys) out.add(k);
  }
  return out;
}

/** Outage trending block (outages_recent + outage_stats_*d + outage_logs). */
export function needsOutageTrending(sections) {
  const sel = sanitizeSections(sections);
  if (isAllSelection(sel)) return true;
  return selectionIncludes(sel, 'incidents');
}

/** /server_group/{id} per group. Required by Templates + Monitoring Policy. */
export function needsGroupDetails(sections) {
  const sel = sanitizeSections(sections);
  if (isAllSelection(sel)) return true;
  return selectionIncludes(sel, 'template-recommendations')
    || selectionIncludes(sel, 'monitoring-policy');
}

/** /server_template/{id} per template. Required by Templates. */
export function needsTemplateDetails(sections) {
  const sel = sanitizeSections(sections);
  if (isAllSelection(sel)) return true;
  return selectionIncludes(sel, 'template-recommendations');
}

/**
 * Per-server deep dive (/server/{id}/agent_resource etc).
 *
 * In "all" mode we honor the operator's `deep` flag (today's behavior).
 * In single/multi-section mode the deep dive is implicitly tied to
 * Instance Analysis being in the selection - the deep-dive data feeds
 * only that section, so running deep without Instance Analysis selected
 * would be wasted work, and skipping deep when Instance Analysis IS
 * selected would render the section unavailable. Per planning doc §2.
 */
export function needsDeepDive(sections, { deep = false } = {}) {
  const sel = sanitizeSections(sections);
  if (isAllSelection(sel)) return Boolean(deep);
  return selectionIncludes(sel, 'instance-analysis');
}

/** Per-user get_edit_user_data walk. Required only by User Activity. */
export function needsFrontendUsers(sections) {
  const sel = sanitizeSections(sections);
  if (isAllSelection(sel)) return true;
  return selectionIncludes(sel, 'user-activity');
}

/** Per-template get_monitoring_config_data walk. Required only by Templates. */
export function needsFrontendTemplates(sections) {
  const sel = sanitizeSections(sections);
  if (isAllSelection(sel)) return true;
  return selectionIncludes(sel, 'template-recommendations');
}

/**
 * The set of analyzer result keys to populate in `analysis` for the
 * given selection. ["all"] returns the full set (today's behavior).
 *
 * @returns {Set<string>}
 */
export function analyzerKeysForSections(sections) {
  const sel = sanitizeSections(sections);
  // "all" pulls every primary key + every ancillary key.
  const allKeys = new Set(Object.values(SECTION_ANALYZER_KEY));
  for (const list of Object.values(SECTION_ANCILLARY_ANALYZER_KEYS)) {
    for (const k of list) allKeys.add(k);
  }
  if (isAllSelection(sel)) return allKeys;
  const out = new Set();
  for (const s of sel) {
    const primary = SECTION_ANALYZER_KEY[s];
    if (primary) out.add(primary);
    const ancillary = SECTION_ANCILLARY_ANALYZER_KEYS[s];
    if (Array.isArray(ancillary)) for (const k of ancillary) out.add(k);
  }
  return out;
}
