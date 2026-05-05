// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// BPA section -> data dependency map (FMN-149).
//
// Single source of truth for "which inventory keys does each analyzer
// section actually read?" Drives the selective fetcher (skip endpoints no
// requested section consumes), the frontend-fetcher gating (User Activity
// vs Templates), the analyzer dispatch (only run requested analyzers),
// and the viewer's tab-filter on the review step.
//
// Per planning doc docs/planning/bpa-per-section-delivery.md §2.

import { isAllSelection, sanitize as sanitizeSections } from '../ui/bpa-audit/section-selection.js';

// Map from the wizard's analyzer-scoped section ids to the analyzer
// result keys on `analysis`. The viewer tabs are richer than the
// analyzers - one analyzer ("incidents") feeds two tabs (incident-summary
// + incidents). The pill row collapses those into a single "Incidents"
// pill, so the section -> analyzer mapping is one-to-one.
export const SECTION_ANALYZER_KEY = Object.freeze({
  'incidents': 'incidents',
  'user-activity': 'users',
  'instance-analysis': 'instances',
  'template-recommendations': 'templates',
  'monitoring-policy': 'monitoring_policy'
});

// Inventory keys touched by each analyzer-scoped section. Values listed
// here are the keys the BpaFetcher's top-level list pass populates; the
// trending-block, group-detail, template-detail, and deep-dive blocks
// have their own gating predicates below because their behavior is more
// nuanced than "fetch this list".
const SECTION_TOP_LEVEL_KEYS = Object.freeze({
  'incidents': ['outages'],
  'user-activity': ['users'],
  'instance-analysis': ['servers', 'agent_resource_types'],
  'template-recommendations': ['server_templates'],
  'monitoring-policy': ['servers', 'server_groups', 'server_templates']
});

// Cross-cutting tabs touch every fetcher domain (see planning doc §1).
// When a full report is requested ("all"), every key is fair game.
function selectionIncludes(sections, id) {
  return Array.isArray(sections) && sections.includes(id);
}

/**
 * Return the set of top-level inventory keys that the BpaFetcher must
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
  const all = new Set(Object.values(SECTION_ANALYZER_KEY));
  if (isAllSelection(sel)) return all;
  const out = new Set();
  for (const s of sel) {
    const k = SECTION_ANALYZER_KEY[s];
    if (k) out.add(k);
  }
  return out;
}
