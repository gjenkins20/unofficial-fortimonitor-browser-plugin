// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// BPA Audit - section-selection model (FMN-146).
//
// Pure helper that backs the Configure step's pill row. Kept DOM-free so
// it can be unit-tested without a browser.
//
// Selection invariants:
//   - The selection is always a non-empty array.
//   - It is either exactly ["all"] or a non-empty subset of ANALYZER_SECTION_IDS.
//   - Clicking [All] resets to ["all"], no matter what was selected before.
//   - Plain-clicking an analyzer pill replaces the selection with [that pill].
//   - Shift-clicking an analyzer pill toggles it into / out of the selection,
//     except that it is a no-op if it would empty the selection. Shift-click
//     while ["all"] is selected behaves like a plain click (single select).

export const ALL_SECTION_ID = 'all';

export const ANALYZER_SECTION_IDS = Object.freeze([
  'incidents',
  'user-activity',
  'instance-analysis',
  'template-recommendations',
  'monitoring-policy'
]);
// FMN-156: noise analysis was a separate section id pre-operator-QA; the
// rework folds the analyzer's output into the Incidents tab's sections,
// so the section list no longer carries 'noise-analysis'.

const ANALYZER_SET = new Set(ANALYZER_SECTION_IDS);

export const ALL_SELECTION = Object.freeze([ALL_SECTION_ID]);

export function defaultSelection() {
  return [ALL_SECTION_ID];
}

/**
 * Compute the next selection after a pill click.
 *
 * @param {string[]} current - the current selection
 * @param {string} clicked - the section id of the clicked pill
 * @param {{ shift?: boolean }} [opts] - shift-key state at click time
 * @returns {string[]} the new selection
 */
export function nextSectionsSelection(current, clicked, opts = {}) {
  const shift = Boolean(opts.shift);
  const sel = sanitize(current);

  if (clicked === ALL_SECTION_ID) {
    return [ALL_SECTION_ID];
  }
  if (!ANALYZER_SET.has(clicked)) {
    return sel;
  }

  const isAllSelected = sel.length === 1 && sel[0] === ALL_SECTION_ID;
  if (!shift || isAllSelected) {
    return [clicked];
  }

  const idx = sel.indexOf(clicked);
  if (idx === -1) {
    return [...sel, clicked];
  }
  if (sel.length === 1) {
    return sel;
  }
  return sel.filter((s) => s !== clicked);
}

/**
 * Coerce an unknown value to a valid selection. Used at the SW boundary
 * (validating payload.sections) and on store-rehydration paths.
 */
export function sanitize(input) {
  if (!Array.isArray(input) || input.length === 0) return [ALL_SECTION_ID];
  if (input.includes(ALL_SECTION_ID)) return [ALL_SECTION_ID];
  const filtered = [];
  const seen = new Set();
  for (const s of input) {
    if (typeof s !== 'string') continue;
    if (!ANALYZER_SET.has(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    filtered.push(s);
  }
  return filtered.length === 0 ? [ALL_SECTION_ID] : filtered;
}

export function isAllSelection(sel) {
  return Array.isArray(sel) && sel.length === 1 && sel[0] === ALL_SECTION_ID;
}
