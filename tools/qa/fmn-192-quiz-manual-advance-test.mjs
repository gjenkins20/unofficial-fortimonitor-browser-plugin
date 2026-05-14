#!/usr/bin/env node
// FMN-192: verify the quiz no longer auto-advances after answer selection.
// Operator must now click "Next" to move to the next question.
//
// Headless Playwright. Loads the renderer + quiz modules via blob URLs
// against an empty page, simulates one full quiz pass, asserts:
//   1. After clicking an answer, the question remains rendered (no auto-advance)
//   2. A button with data-fmn-quiz-next appears
//   3. Clicking that button advances to the next question
//   4. After the final question + Next, the results screen appears
//   5. Clicking Done fires onFinish

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const RENDERER_PATH = new URL('../../extension/src/ui/intro-tour/quiz-renderer.js', import.meta.url).pathname;
const QUIZ_PATH = new URL('../../extension/src/ui/intro-tour/quiz.js', import.meta.url).pathname;

const rendererSrc = readFileSync(RENDERER_PATH, 'utf8');
const quizSrc = readFileSync(QUIZ_PATH, 'utf8');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
await page.setContent('<!doctype html><html><body></body></html>');

const result = await page.evaluate(async ({ rendererSrc, quizSrc }) => {
  const quizBlob = new Blob([quizSrc], { type: 'text/javascript' });
  const quizUrl = URL.createObjectURL(quizBlob);
  const patchedRenderer = rendererSrc.replace(/from\s+['"]\.\/quiz\.js['"]/, `from '${quizUrl}'`);
  const rendererBlob = new Blob([patchedRenderer], { type: 'text/javascript' });
  const { renderQuiz } = await import(URL.createObjectURL(rendererBlob));
  const quizMod = await import(quizUrl);

  const events = [];
  let finishFired = null;
  const handle = renderQuiz({
    doc: document,
    state: quizMod.createQuizState(),
    onAnswer: (i, a) => events.push({ type: 'answer', index: i, correct: a.correct }),
    onFinish: (score) => { finishFired = score; events.push({ type: 'finish', score }); }
  });

  const total = quizMod.createQuizState().questions.length;
  const snapshots = [];

  for (let q = 0; q < total; q++) {
    // Click the first option (deterministic, may be wrong - we don't care).
    const firstOpt = document.querySelector('[data-fmn-quiz-option]');
    if (!firstOpt) return { error: `no option button on Q${q + 1}` };
    firstOpt.click();
    // Snapshot AFTER click: question prompt should still be there + Next button.
    const promptAfterClick = document.querySelector('.fmn-tour-quiz-prompt')?.textContent || null;
    const explanation = document.querySelector('.fmn-tour-quiz-explanation')?.textContent || null;
    const nextBtn = document.querySelector('[data-fmn-quiz-next]');
    const nextLabel = nextBtn?.textContent || null;
    snapshots.push({ q: q + 1, promptAfterClick, hasExplanation: !!explanation, hasNextBtn: !!nextBtn, nextLabel });
    // 50ms is more than enough — the OLD code's setTimeout was 900ms.
    await new Promise(r => setTimeout(r, 60));
    // Snapshot AGAIN: nothing should have changed if auto-advance is gone.
    const promptStill = document.querySelector('.fmn-tour-quiz-prompt')?.textContent || null;
    snapshots[snapshots.length - 1].promptStillSame = promptStill === promptAfterClick;
    // Click Next to advance.
    nextBtn?.click();
  }

  // After last Next: results screen.
  const headerAfter = document.querySelector('.fmn-tour-quiz-header')?.textContent || null;
  const doneBtn = document.querySelector('[data-fmn-quiz-done]');
  doneBtn?.click();

  return {
    snapshots,
    headerAfterAllQuestions: headerAfter,
    finishFired: !!finishFired,
    finishScore: finishFired,
    events
  };
}, { rendererSrc, quizSrc });

console.log(JSON.stringify(result, null, 2));

const ok =
  result.snapshots.length === 3 &&
  result.snapshots.every(s => s.hasNextBtn && s.hasExplanation && s.promptStillSame) &&
  result.snapshots[0].nextLabel === 'Next' &&
  result.snapshots[1].nextLabel === 'Next' &&
  result.snapshots[2].nextLabel === 'See results' &&
  result.headerAfterAllQuestions === 'Quiz complete' &&
  result.finishFired;

console.log(ok ? '\nPASS: quiz requires manual Next click per question; no auto-advance.' : '\nFAIL.');
await browser.close();
process.exit(ok ? 0 : 1);
