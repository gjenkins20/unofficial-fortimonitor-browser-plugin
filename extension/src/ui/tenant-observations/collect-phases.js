// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Tenant Observations - Collect-step phase model (FMN-257).
//
// Pure, DOM-free helpers that back the Collect step's PERSISTENT phase
// stepper. The stepper lists the full expected run sequence up front
// (pending), then advances each phase through active -> done as the run
// reports progress, instead of flashing ephemeral phase labels in random
// places (FMN-256 live-QA feedback).
//
// Two inputs feed the stepper:
//   1. the broadcast 'observations:progress' events (fast but fragile in
//      MV3 - a backgrounded SW may drop them), and
//   2. the 'observations:get-run-status' poll record, which now carries
//      the latest phase id so the indicator reflects reality even when
//      broadcast events don't arrive.
//
// Kept framework-free and importable in Node so phase derivation is unit
// testable without a browser.

import {
  needsDeepDive,
  needsFrontendUsers,
  needsFrontendTemplates
} from '../../lib/observations-section-deps.js';

// Stepper phase ids, in run order. These are the phases the run actually
// signals distinctly via progress events / poll status. The collect phase
// covers top-level lists, outage trending, and group/template detail (the
// fetcher emits per-endpoint events for all of those without a distinct
// phase boundary); its sub-detail line names whichever endpoint is in
// flight.
export const PHASE_COLLECT = 'collect';
export const PHASE_DEEP = 'deep';
export const PHASE_FRONTEND_USERS = 'frontend-users';
export const PHASE_FRONTEND_TEMPLATES = 'frontend-templates';
export const PHASE_ANALYZE = 'analyze';

// Per-phase visible states.
export const STATE_PENDING = 'pending';
export const STATE_ACTIVE = 'active';
export const STATE_DONE = 'done';
export const STATE_ERROR = 'error';

const PHASE_LABELS = Object.freeze({
  [PHASE_COLLECT]: 'Top-level lists, trending, group and template detail',
  [PHASE_DEEP]: 'Deep dive per server',
  [PHASE_FRONTEND_USERS]: 'FortiMonitor UI: user activity',
  [PHASE_FRONTEND_TEMPLATES]: 'FortiMonitor UI: template configs',
  [PHASE_ANALYZE]: 'Analyze'
});

export function phaseLabel(id) {
  return PHASE_LABELS[id] ?? id;
}

/**
 * Compute the ordered list of phases for a run, given the deep flag and the
 * selected sections. Mirrors the gating predicates the SW uses to decide
 * which crawl/frontend blocks actually run, so the stepper never shows a
 * phase that won't fire (and never hides one that will).
 *
 * The collect and analyze phases always run. Deep dive, user-activity, and
 * template-config phases are conditional.
 *
 * @param {object} opts
 * @param {boolean} [opts.deep]
 * @param {string[]} [opts.sections]  the ["all"] or analyzer-scoped subset
 * @returns {{ id: string, label: string }[]}
 */
export function derivePhases({ deep = false, sections } = {}) {
  const phases = [{ id: PHASE_COLLECT, label: phaseLabel(PHASE_COLLECT) }];

  if (needsDeepDive(sections, { deep })) {
    phases.push({ id: PHASE_DEEP, label: phaseLabel(PHASE_DEEP) });
  }
  // The frontend walks only run when the operator opted into the data
  // (includeFrontend is always true from the wizard) AND the section that
  // consumes the data is selected. The SW gates both walks the same way;
  // mirror it here so the stepper matches the run.
  if (needsFrontendUsers(sections)) {
    phases.push({ id: PHASE_FRONTEND_USERS, label: phaseLabel(PHASE_FRONTEND_USERS) });
  }
  if (needsFrontendTemplates(sections)) {
    phases.push({ id: PHASE_FRONTEND_TEMPLATES, label: phaseLabel(PHASE_FRONTEND_TEMPLATES) });
  }
  phases.push({ id: PHASE_ANALYZE, label: phaseLabel(PHASE_ANALYZE) });
  return phases;
}

/**
 * Map a broadcast 'observations:progress' event (or the phase id carried on
 * the poll status record) to the stepper phase id it belongs to. Returns
 * null for events that don't advance the stepper (per-endpoint detail
 * events are handled separately for the active phase's sub-detail line).
 *
 * @param {string} progressPhase  the event's `phase` field (e.g. 'collect:start')
 * @param {object} [event]        the full event, used to disambiguate
 *                                'collect:event' deep-server vs endpoint events
 * @returns {string|null}
 */
export function progressPhaseToStepperPhase(progressPhase, event = null) {
  switch (progressPhase) {
    case 'collect:start':
      return PHASE_COLLECT;
    case 'collect:event':
      // A deep-server tick belongs to the deep phase; everything else
      // (endpoint-start/done/error, collect-done) is the collect phase.
      return event?.type === 'deep-server' ? PHASE_DEEP : PHASE_COLLECT;
    case 'frontend:start':
    case 'frontend:event':
    case 'frontend:done':
    case 'frontend:error':
      return PHASE_FRONTEND_USERS;
    case 'frontend-templates:start':
    case 'frontend-templates:done':
    case 'frontend-templates:error':
      return PHASE_FRONTEND_TEMPLATES;
    case 'analyze:start':
    case 'analyze:done':
      return PHASE_ANALYZE;
    default:
      return null;
  }
}

/**
 * Derive each phase's visible state given the ordered phase list and the
 * "current" phase id (the latest phase the run has entered). Every phase
 * BEFORE the current one is done; the current one is active; every phase
 * after is pending. This is the persistent-progression model: a phase never
 * jumps backwards, and earlier phases stay marked done.
 *
 * Terminal handling:
 *   - terminal === 'done'      -> every phase done
 *   - terminal === 'error'     -> the current phase is error, earlier done,
 *                                 later pending
 *   - terminal === 'cancelled' -> current phase pending again (work stopped);
 *                                 earlier phases stay done
 *   - terminal === 'lost'      -> same as error on the current phase
 *
 * @param {object} opts
 * @param {{id:string}[]} opts.phases
 * @param {string|null} [opts.currentPhaseId]
 * @param {string|null} [opts.terminal]  'done' | 'error' | 'cancelled' | 'lost' | null
 * @returns {Record<string, string>}  phase id -> state
 */
export function derivePhaseStates({ phases, currentPhaseId = null, terminal = null } = {}) {
  const list = Array.isArray(phases) ? phases : [];
  const states = {};

  if (terminal === 'done') {
    for (const p of list) states[p.id] = STATE_DONE;
    return states;
  }

  const currentIdx = list.findIndex((p) => p.id === currentPhaseId);

  for (let i = 0; i < list.length; i += 1) {
    const id = list[i].id;
    if (currentIdx === -1) {
      // No phase entered yet: all pending. (An error/lost before any phase
      // marks the first phase as error so the failure is visible.)
      states[id] = (terminal === 'error' || terminal === 'lost') && i === 0
        ? STATE_ERROR
        : STATE_PENDING;
      continue;
    }
    if (i < currentIdx) {
      states[id] = STATE_DONE;
    } else if (i === currentIdx) {
      if (terminal === 'error' || terminal === 'lost') states[id] = STATE_ERROR;
      else if (terminal === 'cancelled') states[id] = STATE_PENDING;
      else states[id] = STATE_ACTIVE;
    } else {
      states[id] = STATE_PENDING;
    }
  }
  return states;
}

/**
 * Advance a "current phase id" monotonically. The stepper must never jump
 * backwards (e.g. a late-arriving collect endpoint event after the run has
 * moved into the frontend phase must not reset the indicator). Returns
 * `next` only if it is at or after `prev` in the phase order; otherwise
 * keeps `prev`.
 *
 * @param {{id:string}[]} phases
 * @param {string|null} prev
 * @param {string|null} next
 * @returns {string|null}
 */
export function advancePhase(phases, prev, next) {
  if (!next) return prev;
  const list = Array.isArray(phases) ? phases : [];
  const prevIdx = list.findIndex((p) => p.id === prev);
  const nextIdx = list.findIndex((p) => p.id === next);
  if (nextIdx === -1) return prev;            // not a tracked phase
  if (prevIdx === -1) return next;            // nothing tracked yet
  return nextIdx >= prevIdx ? next : prev;    // monotonic
}
