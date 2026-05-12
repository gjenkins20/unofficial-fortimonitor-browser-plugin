// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-167: post-tour comprehension quiz. Three multiple-choice questions
// that solidify what the tour covered. Pure data + small state object;
// the DOM rendering lives in quiz-renderer.js.
//
// The questions intentionally test concepts that hold even when the
// tour content evolves (FMN-173): "what is FortiMonitor's job", "where
// does the toolkit live", "where do you find Incidents". They're not
// trivia about the captioned-script wording.

export const INTRO_TOUR_QUIZ = Object.freeze([
  {
    id: 'q-instances',
    prompt: 'What does FortiMonitor call the things it monitors (servers, fabric devices, OnSight appliances)?',
    options: [
      { id: 'a', label: 'Targets' },
      { id: 'b', label: 'Instances', correct: true },
      { id: 'c', label: 'Endpoints' },
    ],
    explanation: 'FortiMonitor uses "Instances" as the umbrella term for every monitored thing in your tenant. The Instances list at /report/ListServers is the main starting point for drill-in.',
  },
  {
    id: 'q-incidents',
    prompt: 'Where do you go to see the live queue of currently-open outages (not historical)?',
    options: [
      { id: 'a', label: 'Alert Timelines' },
      { id: 'b', label: 'Dashboards' },
      { id: 'c', label: 'Incidents', correct: true },
    ],
    explanation: 'Incidents filters Alert Timelines to currently-open outages - your live operations queue. Alert Timelines shows the full history including resolved alerts.',
  },
  {
    id: 'q-toolkit',
    prompt: 'How does this Unofficial FortiMonitor Toolkit extension add value on top of stock FortiMonitor?',
    options: [
      { id: 'a', label: 'It replaces FortiMonitor entirely.' },
      { id: 'b', label: 'It runs alongside FortiMonitor and adds bulk operations + reports that the native UI does not ship.', correct: true },
      { id: 'c', label: 'It is an official Fortinet product bundled with FortiMonitor.' },
    ],
    explanation: 'The toolkit is unofficial - it augments FortiMonitor by adding bulk port-scope changes, BPA audits, snapshots, omni-search, and other operations the native UI does not provide directly. It rides your existing FortiMonitor session.',
  },
]);

/**
 * Create a fresh quiz state object. The engine creates one per tour run
 * and threads it through the renderer.
 *
 * @param {ReadonlyArray<object>} [questions]
 */
export function createQuizState(questions = INTRO_TOUR_QUIZ) {
  return {
    questions,
    answers: new Array(questions.length).fill(null),
    currentIndex: 0,
    finished: false,
  };
}

/**
 * Pure helper: record an answer for the current question. Returns a new
 * state object (does not mutate). When the last answer lands, the state
 * transitions to finished.
 */
export function answerCurrent(state, optionId) {
  if (state.finished) return state;
  const q = state.questions[state.currentIndex];
  if (!q) return state;
  const chosen = q.options.find((o) => o.id === optionId);
  if (!chosen) return state;
  const isLast = state.currentIndex === state.questions.length - 1;
  const answers = state.answers.slice();
  answers[state.currentIndex] = {
    questionId: q.id,
    optionId,
    correct: Boolean(chosen.correct),
  };
  return {
    ...state,
    answers,
    currentIndex: isLast ? state.currentIndex : state.currentIndex + 1,
    finished: isLast,
  };
}

/**
 * Compute the final score from a finished quiz state. Returns { right,
 * total, percent } where percent is rounded to the nearest integer.
 */
export function scoreQuiz(state) {
  const total = state.questions.length;
  const right = state.answers.filter((a) => a && a.correct).length;
  const percent = total === 0 ? 0 : Math.round((right / total) * 100);
  return { right, total, percent };
}
