// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-167: tests for the comprehension quiz state machine + scoring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTRO_TOUR_QUIZ,
  createQuizState,
  answerCurrent,
  scoreQuiz,
} from '../src/ui/intro-tour/quiz.js';

test('INTRO_TOUR_QUIZ: exactly 3 questions, each with 3 options, exactly one correct', () => {
  assert.equal(INTRO_TOUR_QUIZ.length, 3);
  for (const q of INTRO_TOUR_QUIZ) {
    assert.equal(typeof q.id, 'string');
    assert.equal(typeof q.prompt, 'string');
    assert.equal(q.options.length, 3);
    const correct = q.options.filter((o) => o.correct === true);
    assert.equal(correct.length, 1, `${q.id} must have exactly one correct option`);
    assert.equal(typeof q.explanation, 'string');
  }
});

test('createQuizState: produces a fresh state at index 0, not finished, all answers null', () => {
  const s = createQuizState();
  assert.equal(s.currentIndex, 0);
  assert.equal(s.finished, false);
  assert.equal(s.answers.length, 3);
  assert.deepEqual(s.answers, [null, null, null]);
});

test('answerCurrent: records correctness and advances to the next question', () => {
  let s = createQuizState();
  const firstQ = s.questions[0];
  const correctOpt = firstQ.options.find((o) => o.correct).id;
  s = answerCurrent(s, correctOpt);
  assert.equal(s.currentIndex, 1);
  assert.equal(s.finished, false);
  assert.equal(s.answers[0].correct, true);
  assert.equal(s.answers[0].questionId, firstQ.id);
});

test('answerCurrent: incorrect answers are recorded with correct:false', () => {
  let s = createQuizState();
  const firstQ = s.questions[0];
  const wrongOpt = firstQ.options.find((o) => !o.correct).id;
  s = answerCurrent(s, wrongOpt);
  assert.equal(s.answers[0].correct, false);
  assert.equal(s.answers[0].optionId, wrongOpt);
});

test('answerCurrent: unknown option id is rejected, state unchanged', () => {
  let s = createQuizState();
  const next = answerCurrent(s, 'not-a-real-option');
  assert.deepEqual(next, s);
});

test('answerCurrent: last answer flips finished -> true and stops advancing', () => {
  let s = createQuizState();
  for (let i = 0; i < 3; i++) {
    const opt = s.questions[s.currentIndex].options[0].id;
    s = answerCurrent(s, opt);
  }
  assert.equal(s.finished, true);
  assert.equal(s.currentIndex, 2); // stays on the last question after finishing
  assert.equal(s.answers.filter((a) => a != null).length, 3);
});

test('answerCurrent: further calls after finished are a no-op', () => {
  let s = createQuizState();
  for (let i = 0; i < 3; i++) {
    s = answerCurrent(s, s.questions[s.currentIndex].options[0].id);
  }
  const beforeNoop = s;
  const after = answerCurrent(s, 'a');
  assert.equal(after, beforeNoop);
});

test('scoreQuiz: all correct -> right=3, percent=100', () => {
  let s = createQuizState();
  for (const q of s.questions) {
    s = answerCurrent(s, q.options.find((o) => o.correct).id);
  }
  const score = scoreQuiz(s);
  assert.deepEqual(score, { right: 3, total: 3, percent: 100 });
});

test('scoreQuiz: all wrong -> right=0, percent=0', () => {
  let s = createQuizState();
  for (const q of s.questions) {
    s = answerCurrent(s, q.options.find((o) => !o.correct).id);
  }
  const score = scoreQuiz(s);
  assert.deepEqual(score, { right: 0, total: 3, percent: 0 });
});

test('scoreQuiz: mixed -> percent rounded', () => {
  let s = createQuizState();
  // Get q0 right, q1 wrong, q2 right.
  s = answerCurrent(s, s.questions[0].options.find((o) => o.correct).id);
  s = answerCurrent(s, s.questions[1].options.find((o) => !o.correct).id);
  s = answerCurrent(s, s.questions[2].options.find((o) => o.correct).id);
  const score = scoreQuiz(s);
  assert.equal(score.right, 2);
  assert.equal(score.total, 3);
  assert.equal(score.percent, 67);
});
