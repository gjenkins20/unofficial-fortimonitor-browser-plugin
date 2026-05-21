// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-167: tour-step schema. Pure data; no DOM, no chrome.* references.
// The schema is the contract between content authors and the engine.
// See docs/planning/intro-tour-plan.md section 2 for field reference.

// FMN-229: 'all-checked' joined the advance modes for checklist steps.
// A checklist step's Next button enables only when every item in
// step.checklist is checked.
export const ADVANCE_MODES = Object.freeze(['click', 'auto', 'next-button', 'all-checked']);
export const PLACEMENTS = Object.freeze(['top', 'right', 'bottom', 'left', 'auto']);

// FMN-229: step_type discriminates between DOM-anchored spotlight
// steps ('anchor', the FMN-167 default and the only type before this
// extension) and off-FortiMonitor checklist steps ('checklist', the
// FMN-168 OnSight deployment use case). The default stays 'anchor' so
// every existing intro-tour step validates and renders without changes.
export const STEP_TYPES = Object.freeze(['anchor', 'checklist']);

export const STEP_DEFAULTS = Object.freeze({
  step_type: 'anchor',
  anchor_fallback: 'body',
  when: Object.freeze({ always: true }),
  advance: 'next-button',
  auto_ms: 3500,
  placement: 'auto',
  anchor_timeout_ms: 5000,
  on_enter: null,
  on_exit: null,
  audio_url: null,
  caption_markdown: null,
  checklist: Object.freeze([])
});

/**
 * Validate a step input. Returns `{ ok: true, step }` on success
 * (with defaults filled in via normalizeStep) or `{ ok: false, errors }`
 * on failure. errors is a string[] enumerating every problem so authors
 * can fix them in one pass.
 *
 * Validation rules:
 *   - id: required non-empty string, lowercase-kebab-case recommended
 *     (warned, not rejected).
 *   - anchor: required non-empty string. Engine treats it as a CSS
 *     selector; we do not parse it here (Selector grammar is huge and
 *     a bad selector is observable at mount time anyway).
 *   - caption_html OR caption_markdown: at least one required. If both
 *     are present, caption_html wins (no error - useful for authoring).
 *   - advance: required, must be in ADVANCE_MODES.
 *   - when: optional; if present, must be a plain object with at most
 *     one of { always, path_includes, path_regex }.
 *   - placement: optional; if present, must be in PLACEMENTS.
 *   - auto_ms: optional; if present, must be a positive finite number.
 */
export function validateStep(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['step must be a plain object'] };
  }
  // FMN-229: resolve step_type up front. Anything missing/unknown is
  // an error so authors who typo'd 'checklist' as 'cheecklist' get
  // a clear signal rather than silent fallback to 'anchor'.
  const stepType = input.step_type === undefined || input.step_type === null
    ? 'anchor'
    : String(input.step_type);
  if (!STEP_TYPES.includes(stepType)) {
    errors.push(`step_type must be one of: ${STEP_TYPES.join(', ')}`);
  }
  if (typeof input.id !== 'string' || input.id.trim() === '') {
    errors.push('id is required and must be a non-empty string');
  }
  // FMN-229: anchor required only for step_type='anchor'. Checklist
  // steps render as a centered card without a DOM target.
  if (stepType === 'anchor') {
    if (typeof input.anchor !== 'string' || input.anchor.trim() === '') {
      errors.push('anchor is required and must be a non-empty string (CSS selector)');
    }
  }
  // FMN-229: checklist[] required (>= 1 entry) when step_type='checklist'.
  // Each entry must carry id + label.
  if (stepType === 'checklist') {
    if (!Array.isArray(input.checklist) || input.checklist.length === 0) {
      errors.push('checklist (>= 1 entry) is required when step_type is "checklist"');
    } else {
      const seen = new Set();
      input.checklist.forEach((item, i) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(`checklist[${i}] must be a plain object`);
          return;
        }
        if (typeof item.id !== 'string' || item.id.trim() === '') {
          errors.push(`checklist[${i}].id is required and must be a non-empty string`);
        } else if (seen.has(item.id)) {
          errors.push(`checklist[${i}].id "${item.id}" duplicates an earlier entry`);
        } else {
          seen.add(item.id);
        }
        if (typeof item.label !== 'string' || item.label.trim() === '') {
          errors.push(`checklist[${i}].label is required and must be a non-empty string`);
        }
      });
    }
    if (input.advance !== undefined && input.advance !== null && input.advance !== 'all-checked' && input.advance !== 'next-button') {
      errors.push("checklist steps support advance: 'all-checked' (default) or 'next-button'");
    }
  }
  const hasHtml = typeof input.caption_html === 'string' && input.caption_html.trim() !== '';
  const hasMd = typeof input.caption_markdown === 'string' && input.caption_markdown.trim() !== '';
  if (!hasHtml && !hasMd) {
    errors.push('caption_html or caption_markdown is required');
  }
  // advance: for anchor steps, defaults to 'next-button' if missing.
  // For checklist steps, defaults to 'all-checked' if missing.
  const effectiveAdvance = input.advance === undefined || input.advance === null
    ? (stepType === 'checklist' ? 'all-checked' : 'next-button')
    : input.advance;
  if (!ADVANCE_MODES.includes(effectiveAdvance)) {
    errors.push(`advance must be one of: ${ADVANCE_MODES.join(', ')}`);
  }
  if (input.when !== undefined && input.when !== null) {
    if (typeof input.when !== 'object' || Array.isArray(input.when)) {
      errors.push('when must be a plain object');
    } else {
      const keys = Object.keys(input.when).filter((k) => input.when[k] !== undefined && input.when[k] !== null);
      const allowed = ['always', 'path_includes', 'path_regex'];
      const unknown = keys.filter((k) => !allowed.includes(k));
      if (unknown.length > 0) {
        errors.push(`when has unknown keys: ${unknown.join(', ')}`);
      }
      if (keys.length > 1) {
        errors.push(`when must have at most one of: ${allowed.join(', ')}`);
      }
    }
  }
  if (input.placement !== undefined && input.placement !== null && !PLACEMENTS.includes(input.placement)) {
    errors.push(`placement must be one of: ${PLACEMENTS.join(', ')}`);
  }
  if (input.auto_ms !== undefined && input.auto_ms !== null) {
    if (typeof input.auto_ms !== 'number' || !Number.isFinite(input.auto_ms) || input.auto_ms <= 0) {
      errors.push('auto_ms must be a positive finite number');
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, step: normalizeStep(input) };
}

/**
 * Apply defaults to a step input. Does NOT validate; caller should run
 * validateStep first if input isn't trusted. Returns a frozen object so
 * downstream code can't mutate the canonical form.
 */
export function normalizeStep(input) {
  const stepType = STEP_TYPES.includes(input.step_type) ? input.step_type : STEP_DEFAULTS.step_type;
  // FMN-229: checklist steps don't carry an anchor selector; record a
  // sentinel that the renderer can branch on. anchor_fallback stays
  // for parity but is unused on the checklist path.
  const anchor = stepType === 'checklist'
    ? null
    : String(input.anchor ?? '').trim();
  // Default advance differs by step_type: 'all-checked' for checklist,
  // 'next-button' for anchor (matches the existing FMN-167 default).
  const defaultAdvance = stepType === 'checklist' ? 'all-checked' : STEP_DEFAULTS.advance;
  const advance = ADVANCE_MODES.includes(input.advance) ? input.advance : defaultAdvance;
  // Normalize checklist entries; freeze each so downstream callers
  // can't mutate the canonical form.
  const checklist = stepType === 'checklist' && Array.isArray(input.checklist)
    ? Object.freeze(input.checklist.map((item) => Object.freeze({
        id: String(item.id).trim(),
        label: String(item.label).trim(),
        help: typeof item.help === 'string' && item.help.trim() ? item.help.trim() : null
      })))
    : STEP_DEFAULTS.checklist;
  const out = {
    id: String(input.id).trim(),
    step_type: stepType,
    anchor,
    anchor_fallback: typeof input.anchor_fallback === 'string' && input.anchor_fallback.trim()
      ? input.anchor_fallback.trim() : STEP_DEFAULTS.anchor_fallback,
    caption_html: typeof input.caption_html === 'string' ? input.caption_html : null,
    caption_markdown: typeof input.caption_markdown === 'string' ? input.caption_markdown : null,
    when: normalizeWhen(input.when),
    advance,
    auto_ms: typeof input.auto_ms === 'number' && Number.isFinite(input.auto_ms) && input.auto_ms > 0
      ? input.auto_ms : STEP_DEFAULTS.auto_ms,
    placement: PLACEMENTS.includes(input.placement) ? input.placement : STEP_DEFAULTS.placement,
    anchor_timeout_ms: typeof input.anchor_timeout_ms === 'number' && input.anchor_timeout_ms > 0
      ? input.anchor_timeout_ms : STEP_DEFAULTS.anchor_timeout_ms,
    on_enter: typeof input.on_enter === 'string' && input.on_enter.trim() ? input.on_enter.trim() : null,
    on_exit: typeof input.on_exit === 'string' && input.on_exit.trim() ? input.on_exit.trim() : null,
    audio_url: typeof input.audio_url === 'string' && input.audio_url.trim() ? input.audio_url.trim() : null,
    checklist
  };
  return Object.freeze(out);
}

function normalizeWhen(when) {
  if (!when || typeof when !== 'object') return Object.freeze({ always: true });
  if (when.path_regex !== undefined && when.path_regex !== null) {
    return Object.freeze({ path_regex: String(when.path_regex) });
  }
  if (when.path_includes !== undefined && when.path_includes !== null) {
    return Object.freeze({ path_includes: String(when.path_includes) });
  }
  return Object.freeze({ always: true });
}

/**
 * Test whether a step's `when` predicate matches a given pathname.
 * Pure function over (step, pathname) - used by both the engine
 * (deciding which step to render after a route change) and tests.
 */
export function stepMatchesPath(step, pathname) {
  const when = step.when || STEP_DEFAULTS.when;
  if (when.always) return true;
  if (typeof when.path_includes === 'string') {
    return typeof pathname === 'string' && pathname.includes(when.path_includes);
  }
  if (typeof when.path_regex === 'string') {
    try {
      const re = new RegExp(when.path_regex);
      return re.test(String(pathname || ''));
    } catch {
      return false;
    }
  }
  return true;
}
