// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-169: source-of-truth registry for the per-feature info bubbles.
//
// Each entry describes one toolkit feature that gets a hover bubble.
// Adding a future feature = appending an entry here (and dropping a
// planning doc at docs/planning/<feature-id>.md so the Learn more link
// is not a 404). The bubble component reads this registry; augment.js
// and popup.js subscribe by surface (content vs popup) and attach hover
// handlers to matching anchors.
//
// Field contract:
//   featureId         - stable identifier; also the dismissal key.
//                       Lowercase + kebab-case. NEVER reused or renamed
//                       after ship; renaming resurrects already-dismissed
//                       bubbles on every operator's machine.
//   surface           - 'content' (FortiMonitor page via augment.js) or
//                       'popup' (extension popup / settings).
//   anchorSelector    - CSS selector under the surface's root that the
//                       bubble attaches to. Match-many is fine; the
//                       component dedupes per element.
//   anchorMode        - 'self'  : bubble lives on the matched element itself.
//                       'icon'  : a small "i in a circle" anchor is
//                                 inserted as a sibling/child of the
//                                 matched element (caller-defined
//                                 placement via mountTarget).
//   mountTarget       - 'before' | 'after' | 'append' | 'prepend'.
//                       Where to drop the inserted icon when anchorMode
//                       is 'icon'. Default 'append'.
//   title             - bold header line in the bubble (~30 chars).
//   body              - one-paragraph plain-English description (~300
//                       chars max per ticket). No HTML; the renderer
//                       textContent-assigns this.
//   learnMoreUrl      - link emitted as "Learn more →" inside the
//                       bubble. Points to docs/planning/<id>.md by
//                       operator decision (FMN-169 spec). Open in new
//                       tab. Resolve relative to the repo's GitHub raw
//                       URL so a click from the extension popup or a
//                       FortiMonitor page lands somewhere readable.
//
// Per memory no_em_dashes.md: no U+2014 anywhere in body strings.

// Stable repo-root base for Learn more links. Lives on github.com so the
// destination is human-readable Markdown rather than the raw text file.
// docs/planning/<feature-id>.md is created as a stub for every entry
// here so day-one clicks never 404.
const LEARN_MORE_BASE = 'https://github.com/gjenkins20/unofficial-fortimonitor-browser-plugin/blob/main/docs/planning/';

/**
 * @typedef {Object} InfoBubbleEntry
 * @property {string} featureId
 * @property {'content'|'popup'} surface
 * @property {string} anchorSelector
 * @property {'self'|'icon'} anchorMode
 * @property {'before'|'after'|'append'|'prepend'} [mountTarget]
 * @property {string} title
 * @property {string} body
 * @property {string} learnMoreUrl
 */

/** @type {InfoBubbleEntry[]} */
export const INFO_BUBBLE_REGISTRY = [
  // FMN-152: omni-search bar that replaces FortiMonitor's "Search
  // Instances". Anchor on the FM TK chip inside the omni-search
  // container; the chip is always present when the feature is on.
  {
    featureId: 'omni-search',
    surface: 'content',
    anchorSelector: '#fmn-omni-search-container .fmn-omni-chip',
    anchorMode: 'icon',
    mountTarget: 'after',
    title: 'FM TK Search',
    body: 'Searches every server field at once: name, FQDN, IP addresses, description, tags, attributes (Operating System, Model, custom), device type, agent version, server group, and applied template. Replaces FortiMonitor\'s narrow Search Instances input.',
    learnMoreUrl: LEARN_MORE_BASE + 'omni-search.md',
  },

  // FMN-160: search-by-ID is part of the omni-search omnibox - typing
  // a bare numeric or `s-<id>` token matches the server id directly.
  // Anchor lives inside the omni-search dropdown context so it surfaces
  // alongside the regular search bubble.
  {
    featureId: 'search-by-id',
    surface: 'content',
    anchorSelector: '#fmn-omni-search-container .fmn-omni-id-hint',
    anchorMode: 'self',
    title: 'Search by Server ID',
    body: 'Paste a numeric server id (e.g. 42024060) or the s-<id> token from FortiMonitor URLs into the search box to jump straight to that instance. No need to remember the name.',
    learnMoreUrl: LEARN_MORE_BASE + 'search-by-id.md',
  },

  // FMN-153: IP Address + DNS Name sub-columns on /report/ListServers.
  // Anchor on either sub-header so hovering the column gives context.
  // The classifier walks pageData.instance.fqdns[] and types entries
  // locally; FortiMonitor's ipTypes hint is unreliable.
  {
    featureId: 'ip-dns-columns',
    surface: 'content',
    anchorSelector: 'th.fmn-instance-merged [data-fmn-col="ip"], th.fmn-instance-merged [data-fmn-col="dns"]',
    anchorMode: 'self',
    title: 'IP / DNS Columns',
    body: 'Adds IP Address and DNS Name sub-columns to the Instances list. Values come from each server\'s primary fqdn(s); names like server.example.com and bare hostnames are classified locally rather than trusting FortiMonitor\'s ipTypes hint.',
    learnMoreUrl: LEARN_MORE_BASE + 'ip-dns-columns.md',
  },

  // FMN-71/151: native FortiMonitor column reorder/hide via the FM TK
  // Columns button on /report/ListServers. The button is the natural
  // anchor (always present when the feature is on).
  {
    featureId: 'native-column-reorder',
    surface: 'content',
    anchorSelector: '#fmn-columns-button',
    anchorMode: 'icon',
    mountTarget: 'after',
    title: 'Columns Menu',
    body: 'Reorders and hides FortiMonitor\'s native columns (Parent Group, Alert Timeline, Tags, Agent Version, Device Heartbeat) without losing pagination or sort. Drag sub-headers directly or use the popover.',
    learnMoreUrl: LEARN_MORE_BASE + 'native-column-reorder.md',
  },

  // FMN-154: Snapshot & Diff card on /report/ListReports. The FMN-86
  // attribution ribbon on the card is pointer-events:none (so it
  // cannot catch hover events). Anchor on the card's <h3> title
  // instead and insert an icon there - the title is always in the
  // viewport when the ribbon is, and is a natural place for an
  // info icon.
  {
    featureId: 'snapshot-diff-card',
    surface: 'content',
    anchorSelector: '[data-fmn-entry="fmn-snapshot-diff-card"] h3',
    anchorMode: 'icon',
    mountTarget: 'append',
    title: 'Snapshot & Diff',
    body: 'Takes a point-in-time snapshot of your deployment (servers, users, templates, server groups) and compares any two snapshots to show what changed. Snapshots live only on this Chrome profile; nothing is uploaded.',
    learnMoreUrl: LEARN_MORE_BASE + 'snapshot-diff-card.md',
  },

  // FMN-157: update-available banner in the popup. Anchored on the
  // banner itself; an icon anchor would crowd the two action buttons.
  {
    featureId: 'update-banner',
    surface: 'popup',
    anchorSelector: '#update-banner .update-banner-body',
    anchorMode: 'icon',
    mountTarget: 'append',
    title: 'Update Notifications',
    body: 'Checks the GitHub repo at most once an hour for a newer manifest version. The banner instructs you to run git pull in your cloned repo and reload the extension; nothing is auto-updated. Toggle off in Settings.',
    learnMoreUrl: LEARN_MORE_BASE + 'update-banner.md',
  },

  // FMN-155: Bulk Action Composer tile in the popup. Operator opts in
  // via Settings; the tile carries a Beta badge. Anchor on the tile's
  // .tool-name (rather than the whole <button>) so the inserted icon
  // sits inline next to the Beta badge instead of fighting the flex
  // layout of the parent card.
  {
    featureId: 'bulk-composer',
    surface: 'popup',
    anchorSelector: '.tool-card[data-tool="bulk-composer"] .tool-name',
    anchorMode: 'icon',
    mountTarget: 'append',
    title: 'Bulk Action Composer',
    body: 'Pick a subset of instances, choose an action (Add Tag, Remove Tag, Apply Template), preview a per-row prev vs. next table, and commit with bounded concurrency. Re-uses the FM TK Search corpus for fast subset selection.',
    learnMoreUrl: LEARN_MORE_BASE + 'bulk-composer.md',
  },

  // FMN-156: Noise sections inside the Tenant Observations' Incident Summary tab.
  // The Tenant Observations viewer is an extension-served page distinct from the
  // popup. The popup surface category is correct for "extension UI
  // outside the FortiMonitor page" but the Tenant Observations viewer (viewer.js)
  // needs its own mountInfoBubbles() call to wire bubbles into the
  // tab content. The selector below targets the Noise Summary
  // section heading by adjacent-table pattern (works without
  // tightening section markup). Registered now so a one-line call
  // in viewer.js can light it up; rendering today only mounts on
  // the popup, so this entry is dormant until that wiring lands.
  {
    featureId: 'noise-analysis',
    surface: 'popup',
    anchorSelector: '.review-section h3.fmn-noise-summary, .review-section h3:has(+ table.review-table)',
    anchorMode: 'icon',
    mountTarget: 'after',
    title: 'Noise Analysis',
    body: 'Ranks the noisiest instances and metric/outage descriptions across your incident history (30-day window) and emits per-row recommendations. Helps you find the alerting rules that need tuning before they swamp the next shift.',
    learnMoreUrl: LEARN_MORE_BASE + 'noise-analysis.md',
  },
];

/**
 * Look up a registry entry by featureId. Returns undefined when the id
 * is unknown. Used by the bubble component on per-feature dismissal
 * (to confirm the click handler has a real entry to act on) and by
 * tests.
 *
 * @param {string} featureId
 * @returns {InfoBubbleEntry | undefined}
 */
export function getInfoBubbleEntry(featureId) {
  if (typeof featureId !== 'string' || !featureId) return undefined;
  return INFO_BUBBLE_REGISTRY.find((e) => e.featureId === featureId);
}

/**
 * Return the entries for a given surface. Used by the mount helpers in
 * augment.js (content) and popup.js (popup) so each surface only
 * iterates its own anchors. Returns a fresh array on each call; safe
 * for callers to filter / map further.
 *
 * @param {'content'|'popup'} surface
 * @returns {InfoBubbleEntry[]}
 */
export function getInfoBubblesForSurface(surface) {
  if (surface !== 'content' && surface !== 'popup') return [];
  return INFO_BUBBLE_REGISTRY.filter((e) => e.surface === surface);
}

/**
 * List every featureId in the registry. Used by tests and by future
 * "reset dismissals" affordances that need to enumerate the universe.
 *
 * @returns {string[]}
 */
export function listInfoBubbleFeatureIds() {
  return INFO_BUBBLE_REGISTRY.map((e) => e.featureId);
}
