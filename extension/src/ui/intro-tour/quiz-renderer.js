// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-167: DOM renderer for the post-tour comprehension quiz. Pure DOM
// + chrome-API-free, mirroring the step-renderer pattern so the same
// module powers live use, the synthetic harness, and unit tests.
//
// Lifecycle: caller constructs an in-memory quiz state via quiz.js, then
// calls renderQuiz({ doc, state, onAnswer, onFinish }). Returns a handle
// with .dispose() and .update(newState) so the bridge can re-render
// after each answer.

import { answerCurrent, scoreQuiz } from './quiz.js';

export function renderQuiz({ doc, state, onAnswer, onFinish } = {}) {
  if (!doc) throw new Error('renderQuiz: doc is required');
  const host = doc.createElement('div');
  host.className = 'fmn-tour-overlay fmn-tour-quiz-overlay';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'false');
  host.setAttribute('aria-label', 'FortiMonitor tour quiz');

  const backdrop = doc.createElement('div');
  backdrop.className = 'fmn-tour-backdrop';
  host.appendChild(backdrop);

  const card = doc.createElement('div');
  card.className = 'fmn-tour-card fmn-tour-quiz-card';
  host.appendChild(card);

  doc.body.appendChild(host);

  let current = state;

  function paint() {
    card.innerHTML = '';
    if (current.finished) {
      paintResults(card, current, () => {
        dispose();
        onFinish?.(scoreQuiz(current));
      });
      return;
    }
    paintQuestion(card, current, (optionId) => {
      const lastAnswered = current.currentIndex;
      current = answerCurrent(current, optionId);
      onAnswer?.(lastAnswered, current.answers[lastAnswered]);
      // Brief delay so the operator sees the feedback before advancing.
      const win = doc.defaultView || globalThis;
      win.setTimeout(() => paint(), 900);
    });
  }

  function dispose() {
    if (host.parentNode) host.parentNode.removeChild(host);
  }

  paint();

  return {
    hostNode: host,
    cardNode: card,
    dispose,
    update(nextState) { current = nextState; paint(); },
  };
}

function paintQuestion(card, state, pickHandler) {
  const q = state.questions[state.currentIndex];
  const doc = card.ownerDocument;

  const header = doc.createElement('div');
  header.className = 'fmn-tour-quiz-header';
  header.textContent = `Quick check · Question ${state.currentIndex + 1} of ${state.questions.length}`;
  card.appendChild(header);

  const prompt = doc.createElement('h4');
  prompt.className = 'fmn-tour-quiz-prompt';
  prompt.textContent = q.prompt;
  card.appendChild(prompt);

  const options = doc.createElement('div');
  options.className = 'fmn-tour-quiz-options';
  card.appendChild(options);

  const buttons = [];
  for (const opt of q.options) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'fmn-tour-quiz-option';
    btn.textContent = opt.label;
    btn.setAttribute('data-fmn-quiz-option', opt.id);
    btn.addEventListener('click', () => {
      // Lock the row, mark right/wrong, expose the explanation, then
      // hand control back to the renderer so it advances after a beat.
      for (const b of buttons) b.disabled = true;
      btn.classList.add(opt.correct ? 'fmn-tour-quiz-option-correct' : 'fmn-tour-quiz-option-wrong');
      // Highlight the actually-correct option when the operator chose
      // wrong - the explanation panel below explains *why*, but seeing
      // the correct option highlighted alongside is the cleaner signal.
      if (!opt.correct) {
        const correctOpt = q.options.find((o) => o.correct);
        if (correctOpt) {
          const correctBtn = buttons.find((b) => b.getAttribute('data-fmn-quiz-option') === correctOpt.id);
          if (correctBtn) correctBtn.classList.add('fmn-tour-quiz-option-correct');
        }
      }
      const explain = doc.createElement('div');
      explain.className = 'fmn-tour-quiz-explanation';
      explain.textContent = q.explanation;
      card.appendChild(explain);
      pickHandler(opt.id);
    });
    options.appendChild(btn);
    buttons.push(btn);
  }
}

function paintResults(card, state, onDone) {
  const doc = card.ownerDocument;
  const score = scoreQuiz(state);

  const header = doc.createElement('div');
  header.className = 'fmn-tour-quiz-header';
  header.textContent = 'Quiz complete';
  card.appendChild(header);

  const summary = doc.createElement('h4');
  summary.className = 'fmn-tour-quiz-prompt';
  summary.textContent = `${score.right} of ${score.total} correct (${score.percent}%)`;
  card.appendChild(summary);

  const review = doc.createElement('ul');
  review.className = 'fmn-tour-quiz-review';
  for (let i = 0; i < state.answers.length; i++) {
    const a = state.answers[i];
    const q = state.questions[i];
    const li = doc.createElement('li');
    li.className = a?.correct ? 'review-correct' : 'review-wrong';
    const marker = doc.createElement('span');
    marker.className = 'review-marker';
    marker.textContent = a?.correct ? '✓' : '✗';
    const text = doc.createElement('span');
    text.className = 'review-text';
    text.textContent = q.prompt;
    li.appendChild(marker);
    li.appendChild(text);
    review.appendChild(li);
  }
  card.appendChild(review);

  const actions = doc.createElement('div');
  actions.className = 'fmn-tour-quiz-actions';
  const doneBtn = doc.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'fmn-tour-next';
  doneBtn.textContent = 'Done';
  doneBtn.setAttribute('data-fmn-quiz-done', '');
  doneBtn.addEventListener('click', () => onDone());
  actions.appendChild(doneBtn);
  card.appendChild(actions);
}
