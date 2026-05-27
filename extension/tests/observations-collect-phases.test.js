import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePhases,
  derivePhaseStates,
  progressPhaseToStepperPhase,
  advancePhase,
  phaseLabel,
  PHASE_COLLECT,
  PHASE_DEEP,
  PHASE_FRONTEND_USERS,
  PHASE_FRONTEND_TEMPLATES,
  PHASE_ANALYZE,
  STATE_PENDING,
  STATE_ACTIVE,
  STATE_DONE,
  STATE_ERROR
} from '../src/ui/tenant-observations/collect-phases.js';

const ids = (phases) => phases.map((p) => p.id);

// ---- derivePhases ----------------------------------------------------------

test('derivePhases: full report (["all"]) deep on => every phase', () => {
  const phases = derivePhases({ deep: true, sections: ['all'] });
  assert.deepEqual(ids(phases), [
    PHASE_COLLECT,
    PHASE_DEEP,
    PHASE_FRONTEND_USERS,
    PHASE_FRONTEND_TEMPLATES,
    PHASE_ANALYZE
  ]);
});

test('derivePhases: full report deep OFF => no deep-dive phase', () => {
  const phases = derivePhases({ deep: false, sections: ['all'] });
  assert.deepEqual(ids(phases), [
    PHASE_COLLECT,
    PHASE_FRONTEND_USERS,
    PHASE_FRONTEND_TEMPLATES,
    PHASE_ANALYZE
  ]);
});

test('derivePhases: undefined sections defaults to full report behavior', () => {
  const phases = derivePhases({ deep: false });
  assert.deepEqual(ids(phases), [
    PHASE_COLLECT,
    PHASE_FRONTEND_USERS,
    PHASE_FRONTEND_TEMPLATES,
    PHASE_ANALYZE
  ]);
});

test('derivePhases: Incidents-only => collect + analyze (no frontend, no deep)', () => {
  const phases = derivePhases({ deep: true, sections: ['incidents'] });
  // Deep dive is tied to instance-analysis, not incidents - so even with
  // deep:true an incidents-only run skips it (mirrors needsDeepDive).
  assert.deepEqual(ids(phases), [PHASE_COLLECT, PHASE_ANALYZE]);
});

test('derivePhases: instance-analysis selected => deep phase included regardless of deep flag', () => {
  const phases = derivePhases({ deep: false, sections: ['instance-analysis'] });
  assert.ok(ids(phases).includes(PHASE_DEEP));
  assert.deepEqual(ids(phases), [PHASE_COLLECT, PHASE_DEEP, PHASE_ANALYZE]);
});

test('derivePhases: user-activity only => collect + frontend-users + analyze', () => {
  const phases = derivePhases({ deep: false, sections: ['user-activity'] });
  assert.deepEqual(ids(phases), [PHASE_COLLECT, PHASE_FRONTEND_USERS, PHASE_ANALYZE]);
});

test('derivePhases: template-recommendations only => collect + frontend-templates + analyze', () => {
  const phases = derivePhases({ deep: false, sections: ['template-recommendations'] });
  assert.deepEqual(ids(phases), [PHASE_COLLECT, PHASE_FRONTEND_TEMPLATES, PHASE_ANALYZE]);
});

test('derivePhases: always starts with collect and ends with analyze', () => {
  for (const sel of [['all'], ['incidents'], ['user-activity'], ['monitoring-policy']]) {
    const phases = derivePhases({ deep: false, sections: sel });
    assert.equal(phases[0].id, PHASE_COLLECT, `first for ${sel}`);
    assert.equal(phases[phases.length - 1].id, PHASE_ANALYZE, `last for ${sel}`);
  }
});

test('phaseLabel returns a human label for each known phase, falls back to id', () => {
  assert.equal(typeof phaseLabel(PHASE_COLLECT), 'string');
  assert.notEqual(phaseLabel(PHASE_DEEP), PHASE_DEEP);
  assert.equal(phaseLabel('made-up-phase'), 'made-up-phase');
});

// ---- progressPhaseToStepperPhase -------------------------------------------

test('progressPhaseToStepperPhase: maps collect events to collect phase', () => {
  assert.equal(progressPhaseToStepperPhase('collect:start'), PHASE_COLLECT);
  assert.equal(progressPhaseToStepperPhase('collect:event', { type: 'endpoint-start' }), PHASE_COLLECT);
  assert.equal(progressPhaseToStepperPhase('collect:event', { type: 'endpoint-done' }), PHASE_COLLECT);
  assert.equal(progressPhaseToStepperPhase('collect:event', { type: 'collect-done' }), PHASE_COLLECT);
});

test('progressPhaseToStepperPhase: deep-server tick maps to deep phase', () => {
  assert.equal(progressPhaseToStepperPhase('collect:event', { type: 'deep-server' }), PHASE_DEEP);
});

test('progressPhaseToStepperPhase: frontend user/template/analyze mappings', () => {
  assert.equal(progressPhaseToStepperPhase('frontend:start'), PHASE_FRONTEND_USERS);
  assert.equal(progressPhaseToStepperPhase('frontend:event', { type: 'frontend-user-start' }), PHASE_FRONTEND_USERS);
  assert.equal(progressPhaseToStepperPhase('frontend:done'), PHASE_FRONTEND_USERS);
  assert.equal(progressPhaseToStepperPhase('frontend-templates:start'), PHASE_FRONTEND_TEMPLATES);
  assert.equal(progressPhaseToStepperPhase('frontend-templates:done'), PHASE_FRONTEND_TEMPLATES);
  assert.equal(progressPhaseToStepperPhase('analyze:start'), PHASE_ANALYZE);
  assert.equal(progressPhaseToStepperPhase('analyze:done'), PHASE_ANALYZE);
});

test('progressPhaseToStepperPhase: unknown phase => null', () => {
  assert.equal(progressPhaseToStepperPhase('whatever'), null);
  assert.equal(progressPhaseToStepperPhase(undefined), null);
});

// ---- derivePhaseStates -----------------------------------------------------

const fullPhases = derivePhases({ deep: true, sections: ['all'] });

test('derivePhaseStates: nothing entered => all pending', () => {
  const states = derivePhaseStates({ phases: fullPhases, currentPhaseId: null });
  for (const p of fullPhases) assert.equal(states[p.id], STATE_PENDING);
});

test('derivePhaseStates: active in the middle => earlier done, later pending', () => {
  const states = derivePhaseStates({ phases: fullPhases, currentPhaseId: PHASE_FRONTEND_USERS });
  assert.equal(states[PHASE_COLLECT], STATE_DONE);
  assert.equal(states[PHASE_DEEP], STATE_DONE);
  assert.equal(states[PHASE_FRONTEND_USERS], STATE_ACTIVE);
  assert.equal(states[PHASE_FRONTEND_TEMPLATES], STATE_PENDING);
  assert.equal(states[PHASE_ANALYZE], STATE_PENDING);
});

test('derivePhaseStates: terminal done => every phase done regardless of current', () => {
  const states = derivePhaseStates({ phases: fullPhases, currentPhaseId: PHASE_COLLECT, terminal: 'done' });
  for (const p of fullPhases) assert.equal(states[p.id], STATE_DONE);
});

test('derivePhaseStates: terminal error => current is error, earlier done, later pending', () => {
  const states = derivePhaseStates({ phases: fullPhases, currentPhaseId: PHASE_DEEP, terminal: 'error' });
  assert.equal(states[PHASE_COLLECT], STATE_DONE);
  assert.equal(states[PHASE_DEEP], STATE_ERROR);
  assert.equal(states[PHASE_FRONTEND_USERS], STATE_PENDING);
});

test('derivePhaseStates: terminal lost behaves like error on the current phase', () => {
  const states = derivePhaseStates({ phases: fullPhases, currentPhaseId: PHASE_DEEP, terminal: 'lost' });
  assert.equal(states[PHASE_DEEP], STATE_ERROR);
});

test('derivePhaseStates: terminal cancelled => current back to pending, earlier stay done', () => {
  const states = derivePhaseStates({ phases: fullPhases, currentPhaseId: PHASE_DEEP, terminal: 'cancelled' });
  assert.equal(states[PHASE_COLLECT], STATE_DONE);
  assert.equal(states[PHASE_DEEP], STATE_PENDING);
  assert.equal(states[PHASE_FRONTEND_USERS], STATE_PENDING);
});

test('derivePhaseStates: error before any phase entered marks first phase error', () => {
  const states = derivePhaseStates({ phases: fullPhases, currentPhaseId: null, terminal: 'error' });
  assert.equal(states[PHASE_COLLECT], STATE_ERROR);
  assert.equal(states[PHASE_DEEP], STATE_PENDING);
});

// ---- advancePhase (monotonic) ----------------------------------------------

test('advancePhase: first entry from null sets the phase', () => {
  assert.equal(advancePhase(fullPhases, null, PHASE_COLLECT), PHASE_COLLECT);
});

test('advancePhase: forward move accepted', () => {
  assert.equal(advancePhase(fullPhases, PHASE_COLLECT, PHASE_DEEP), PHASE_DEEP);
});

test('advancePhase: backward move rejected (stays put)', () => {
  // A late collect endpoint event after we entered the frontend phase must
  // not reset the stepper.
  assert.equal(advancePhase(fullPhases, PHASE_FRONTEND_USERS, PHASE_COLLECT), PHASE_FRONTEND_USERS);
});

test('advancePhase: same phase is a no-op', () => {
  assert.equal(advancePhase(fullPhases, PHASE_DEEP, PHASE_DEEP), PHASE_DEEP);
});

test('advancePhase: null/unknown next keeps prev', () => {
  assert.equal(advancePhase(fullPhases, PHASE_DEEP, null), PHASE_DEEP);
  assert.equal(advancePhase(fullPhases, PHASE_DEEP, 'not-a-phase'), PHASE_DEEP);
});

test('advancePhase: deep skipped (non-deep run) - frontend after collect is forward', () => {
  // In a non-deep full run there is no deep phase; a frontend:start after
  // collect must advance, not reject.
  const nonDeep = derivePhases({ deep: false, sections: ['all'] });
  assert.equal(advancePhase(nonDeep, PHASE_COLLECT, PHASE_FRONTEND_USERS), PHASE_FRONTEND_USERS);
});
