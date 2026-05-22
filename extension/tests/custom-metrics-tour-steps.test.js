import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_METRICS_TOUR_STEPS,
  CUSTOM_METRICS_QUIZ,
  CUSTOM_METRICS_TOUR_CONSTANTS,
} from '../src/ui/training-modules/custom-metrics/steps.js';
import { validateStep } from '../src/ui/intro-tour/step-schema.js';

// =====================================================================
// FMN-244: Custom Metrics training module content shape
// =====================================================================

// Steps carrying anchorByText / anchorBySelector hints get their `anchor`
// field populated by the bridge's resolver at runtime (against the live
// DOM). In tests we don't have a DOM, so simulate the resolver's
// fallback path: an unresolved hint becomes `anchor: anchor_fallback`.
// Steps that already carry `anchor` pass through untouched.
function resolveForValidation(step) {
  if (step.anchor) return step;
  if (step.anchorByText || step.anchorBySelector || step.anchorByAriaLabel) {
    return { ...step, anchor: step.anchor_fallback || 'body' };
  }
  return step;
}

test('every step validates against the FMN-167 tour-step schema (after anchor resolution)', () => {
  for (const raw of CUSTOM_METRICS_TOUR_STEPS) {
    const step = resolveForValidation(raw);
    const r = validateStep(step);
    assert.ok(r.ok, `step ${step.id} failed validation: ${r.ok ? '' : r.errors?.join('; ')}`);
  }
});

test('step ids are unique within the module', () => {
  const ids = CUSTOM_METRICS_TOUR_STEPS.map((s) => s.id);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size, `duplicate step id detected: ${ids.join(', ')}`);
});

test('every step has caption_html (we author rich HTML, not markdown)', () => {
  for (const step of CUSTOM_METRICS_TOUR_STEPS) {
    assert.ok(
      typeof step.caption_html === 'string' && step.caption_html.trim().length > 0,
      `step ${step.id} missing caption_html`
    );
  }
});

test('module covers the key concepts (id-based smoke test)', () => {
  const ids = new Set(CUSTOM_METRICS_TOUR_STEPS.map((s) => s.id));
  for (const required of [
    'welcome',
    'what-is-a-custom-metric',
    'when-to-use',
    'where-to-find-it',
    'authoring-dialog',
    'frequency-and-thresholds',
    'custom-metrics-into-incidents',
    'wrap-up'
  ]) {
    assert.ok(ids.has(required), `missing required step "${required}"`);
  }
});

// FMN-245: the module must point operators at the reproducible example docs.
// A prior rewrite (FMN-244 live-capture) dropped the callout and orphaned the
// docs; this guards the pairing mechanically so it fails here, not in review.
test('FMN-245: a step points operators at the example docs (docs/training/custom-metrics)', () => {
  const linking = CUSTOM_METRICS_TOUR_STEPS.filter(
    (s) => typeof s.caption_html === 'string' && s.caption_html.includes('docs/training/custom-metrics')
  );
  assert.ok(
    linking.length >= 1,
    'no step references docs/training/custom-metrics/ - the FMN-245 example pairing was dropped'
  );
});

test('first step is welcome, last step is wrap-up', () => {
  assert.equal(CUSTOM_METRICS_TOUR_STEPS[0].id, 'welcome');
  assert.equal(CUSTOM_METRICS_TOUR_STEPS[CUSTOM_METRICS_TOUR_STEPS.length - 1].id, 'wrap-up');
});

test('quiz has at least 3 questions with at least one correct option each', () => {
  assert.ok(CUSTOM_METRICS_QUIZ.length >= 3, `quiz has only ${CUSTOM_METRICS_QUIZ.length} questions`);
  for (const q of CUSTOM_METRICS_QUIZ) {
    assert.ok(typeof q.id === 'string' && q.id.length > 0, `quiz entry missing id`);
    assert.ok(typeof q.prompt === 'string' && q.prompt.length > 0, `quiz "${q.id}" missing prompt`);
    assert.ok(Array.isArray(q.options) && q.options.length >= 2, `quiz "${q.id}" needs >= 2 options`);
    const correct = q.options.filter((o) => o.correct === true);
    assert.equal(correct.length, 1, `quiz "${q.id}" must have exactly one correct option`);
  }
});

test('quiz question ids are unique', () => {
  const ids = CUSTOM_METRICS_QUIZ.map((q) => q.id);
  assert.equal(ids.length, new Set(ids).size, `duplicate quiz id: ${ids.join(', ')}`);
});

test('quiz works with the FMN-167 createQuizState factory', async () => {
  const quizMod = await import('../src/ui/intro-tour/quiz.js');
  const state = quizMod.createQuizState(CUSTOM_METRICS_QUIZ);
  assert.equal(state.questions.length, CUSTOM_METRICS_QUIZ.length);
  assert.equal(state.currentIndex, 0);
  assert.equal(state.finished, false);
});

test('constants carry the right tour-id, flag-key, and message type', () => {
  assert.equal(CUSTOM_METRICS_TOUR_CONSTANTS.TOUR_ID, 'custom-metrics-fortimonitor');
  assert.equal(CUSTOM_METRICS_TOUR_CONSTANTS.FLAG_KEY, 'fm:customMetricsTourEnabled');
  assert.equal(CUSTOM_METRICS_TOUR_CONSTANTS.START_MESSAGE_TYPE, 'fm:custom-metrics-tour:start');
});

test('caption_html does not contain em-dashes (memory: no_em_dashes)', () => {
  for (const step of CUSTOM_METRICS_TOUR_STEPS) {
    assert.ok(!step.caption_html.includes('—'), `step ${step.id} contains an em-dash`);
  }
  for (const q of CUSTOM_METRICS_QUIZ) {
    assert.ok(!q.prompt.includes('—'), `quiz "${q.id}" prompt contains an em-dash`);
    for (const o of q.options) {
      assert.ok(!o.label.includes('—'), `quiz "${q.id}" option "${o.id}" contains an em-dash`);
    }
  }
});

// FMN-244 QA (memory: no-bare-breach-in-user-copy). "breach" alone reads as a
// security incident; it must always sit in the same caption/prompt as the word
// "threshold". This guards the rule mechanically so it fails here, not in live QA.
test('user-facing copy never uses bare "breach" (must co-occur with "threshold")', () => {
  const check = (text, where) => {
    if (/breach/i.test(text)) {
      assert.ok(/threshold/i.test(text), `${where} uses "breach" without "threshold" in the same string`);
    }
  };
  for (const step of CUSTOM_METRICS_TOUR_STEPS) check(step.caption_html, `step ${step.id}`);
  for (const q of CUSTOM_METRICS_QUIZ) {
    check(q.prompt, `quiz "${q.id}" prompt`);
    for (const o of q.options) check(o.label, `quiz "${q.id}" option "${o.id}"`);
  }
});
