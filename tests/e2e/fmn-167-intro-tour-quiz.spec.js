// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-167: Playwright spec for the post-tour quiz overlay. Headless
// Chromium, no extension fixture. Renders the quiz against a synthetic
// page that imports the actual quiz + quiz-renderer modules via
// page.addScriptTag({ type: 'module' }), so we exercise production
// code, not a re-implementation.
//
// The popup tile -> SW fan-out -> content-script bridge -> tour ->
// quiz wire-up is covered by the popup + dispatch unit tests + the
// existing fmn-167-intro-tour.spec.js. This spec specifically pins
// the quiz card's user-visible behavior: question advance, right /
// wrong feedback, final score panel.

import { test as base, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUIZ_JS = path.resolve(__dirname, '../../extension/src/ui/intro-tour/quiz.js');
const QUIZ_RENDERER_JS = path.resolve(__dirname, '../../extension/src/ui/intro-tour/quiz-renderer.js');
const STYLES_CSS = path.resolve(__dirname, '../../extension/src/ui/intro-tour/styles.css');
const ROUTED_URL = 'https://harness.test/intro-tour-quiz/';

const test = base.extend({
  ctx: [async ({}, use) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await use(context);
    await context.close();
    await browser.close();
  }, { scope: 'worker' }],
});

function buildHarnessHtml() {
  const css = fs.readFileSync(STYLES_CSS, 'utf-8');
  const quizJs = fs.readFileSync(QUIZ_JS, 'utf-8');
  const quizRendererJs = fs.readFileSync(QUIZ_RENDERER_JS, 'utf-8');
  // Inline both modules into one classic <script>. The renderer imports
  // from quiz.js by name; we splice in the quiz exports as locals and
  // strip the import.
  const quizSource = quizJs.replace(/^export\s+(const|function|class)\s+/gm, '$1 ');
  const rendererSource = quizRendererJs
    .replace(/^import\s+\{[^}]+\}\s+from\s+['"]\.\/quiz\.js['"]\s*;\s*$/m, '')
    .replace(/^export\s+function\s+/gm, 'function ');
  return `<!doctype html>
<html><head>
<style>${css}</style>
</head><body>
<button id="mount">Mount quiz</button>
<script>
  ${quizSource}
  ${rendererSource}
  let lastScore = null;
  document.getElementById('mount').addEventListener('click', () => {
    const state = createQuizState();
    renderQuiz({
      doc: document,
      state,
      onFinish: (score) => { lastScore = score; window.__lastScore = score; },
    });
  });
  window.__getLastScore = () => lastScore;
</script>
</body></html>`;
}

async function gotoHarness(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.route(ROUTED_URL, async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: buildHarnessHtml() });
  });
  await page.goto(ROUTED_URL);
  await page.waitForSelector('#mount');
  return { page, errors };
}

async function pickOption(page, idx) {
  await page.locator('.fmn-tour-quiz-option').nth(idx).click();
}

async function correctOptionIndex(page) {
  // Read which option has data-fmn-quiz-option matching the question's
  // correct flag. The renderer marks the chosen option visually after
  // click; we can find "the correct one" without that by reading the
  // option ids from quiz module (3 options each, exactly one correct).
  return await page.evaluate(() => {
    const idx = window.__currentCorrectIndex;
    return idx ?? -1;
  });
}

test.describe('FMN-167 quiz renderer (headless)', () => {

  test('initial paint: Q1 with header, prompt, three options', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await page.click('#mount');
    await expect(page.locator('.fmn-tour-quiz-header')).toContainText('Question 1 of 3');
    await expect(page.locator('.fmn-tour-quiz-prompt')).toContainText('FortiMonitor');
    await expect(page.locator('.fmn-tour-quiz-option')).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  // Regression for the FMN-167 quiz-host CSS bug: combining the host
  // with .fmn-tour-overlay shrank it to 0x0 (that class sets width:0/
  // height:0 for the spotlight host) and the centered card landed at
  // viewport (0,0) - half off-screen left + above. This test asserts
  // the card actually sits inside the viewport, not at the origin.
  test('quiz card is centered inside the viewport (not flushed to 0,0)', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await page.click('#mount');
    const cardBox = await page.locator('.fmn-tour-quiz-card').boundingBox();
    const viewport = page.viewportSize();
    expect(cardBox).not.toBeNull();
    // Card must be fully inside the viewport on all sides.
    expect(cardBox.x).toBeGreaterThan(0);
    expect(cardBox.y).toBeGreaterThan(0);
    expect(cardBox.x + cardBox.width).toBeLessThan(viewport.width);
    expect(cardBox.y + cardBox.height).toBeLessThan(viewport.height);
    // Center of card should be near center of viewport.
    const cardCenterX = cardBox.x + cardBox.width / 2;
    const cardCenterY = cardBox.y + cardBox.height / 2;
    expect(Math.abs(cardCenterX - viewport.width / 2)).toBeLessThan(20);
    expect(Math.abs(cardCenterY - viewport.height / 2)).toBeLessThan(20);
    expect(errors).toEqual([]);
  });

  // Regression for the same bug at the host level: the overlay must
  // fill the viewport so the centered card has a real coordinate space.
  test('quiz overlay host fills the viewport', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await page.click('#mount');
    const hostBox = await page.locator('.fmn-tour-quiz-overlay').boundingBox();
    const viewport = page.viewportSize();
    expect(hostBox.width).toBeGreaterThanOrEqual(viewport.width - 1);
    expect(hostBox.height).toBeGreaterThanOrEqual(viewport.height - 1);
    expect(errors).toEqual([]);
  });

  test('correct answer: option marked correct, explanation appears, Next advances', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await page.click('#mount');
    // Question 1 correct answer is "Instances" (option index 1).
    await pickOption(page, 1);
    await expect(page.locator('.fmn-tour-quiz-option').nth(1)).toHaveClass(/fmn-tour-quiz-option-correct/);
    await expect(page.locator('.fmn-tour-quiz-explanation')).toBeVisible();
    // FMN-192/FMN-259: the quiz is manual-advance now (no auto-advance); the
    // operator clicks Next after reading the explanation.
    await page.locator('[data-fmn-quiz-next]').click();
    await expect(page.locator('.fmn-tour-quiz-header')).toContainText('Question 2 of 3');
    expect(errors).toEqual([]);
  });

  test('wrong answer: option marked wrong AND correct one is highlighted, explanation appears', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await page.click('#mount');
    // Pick option 0 ("Targets") which is wrong on Q1; correct is option 1.
    await pickOption(page, 0);
    await expect(page.locator('.fmn-tour-quiz-option').nth(0)).toHaveClass(/fmn-tour-quiz-option-wrong/);
    await expect(page.locator('.fmn-tour-quiz-option').nth(1)).toHaveClass(/fmn-tour-quiz-option-correct/);
    await expect(page.locator('.fmn-tour-quiz-explanation')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('end-to-end: answer all 3 correctly -> 3/3 results panel', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await page.click('#mount');
    // Correct indices: Q1=1 (Instances), Q2=2 (Incidents), Q3=1 (toolkit augments).
    // FMN-192/FMN-259: manual-advance - click Next between questions; the last
    // Next ("See results") surfaces the results panel.
    await pickOption(page, 1);
    await page.locator('[data-fmn-quiz-next]').click();
    await pickOption(page, 2);
    await page.locator('[data-fmn-quiz-next]').click();
    await pickOption(page, 1);
    await page.locator('[data-fmn-quiz-next]').click();
    await expect(page.locator('.fmn-tour-quiz-header')).toContainText('Quiz complete');
    await expect(page.locator('.fmn-tour-quiz-prompt')).toContainText('3 of 3 correct (100%)');
    await expect(page.locator('.fmn-tour-quiz-review li.review-correct')).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test('end-to-end: mixed answers -> partial-score results with right/wrong markers', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await page.click('#mount');
    await pickOption(page, 0); // wrong
    await page.locator('[data-fmn-quiz-next]').click();
    await pickOption(page, 2); // correct
    await page.locator('[data-fmn-quiz-next]').click();
    await pickOption(page, 0); // wrong
    await page.locator('[data-fmn-quiz-next]').click(); // "See results"
    await expect(page.locator('.fmn-tour-quiz-prompt')).toContainText('1 of 3 correct');
    await expect(page.locator('.fmn-tour-quiz-review li.review-wrong')).toHaveCount(2);
    await expect(page.locator('.fmn-tour-quiz-review li.review-correct')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('Done button disposes the quiz overlay and fires onFinish with the score', async ({ ctx }) => {
    const { page, errors } = await gotoHarness(ctx);
    await page.click('#mount');
    // Three correct picks, manual-advance via Next (FMN-192/FMN-259).
    await pickOption(page, 1);
    await page.locator('[data-fmn-quiz-next]').click();
    await pickOption(page, 2);
    await page.locator('[data-fmn-quiz-next]').click();
    await pickOption(page, 1);
    await page.locator('[data-fmn-quiz-next]').click(); // "See results"
    await page.locator('button[data-fmn-quiz-done]').click();
    await expect(page.locator('.fmn-tour-quiz-overlay')).toHaveCount(0);
    const score = await page.evaluate(() => window.__getLastScore());
    expect(score).toEqual({ right: 3, total: 3, percent: 100 });
    expect(errors).toEqual([]);
  });
});
