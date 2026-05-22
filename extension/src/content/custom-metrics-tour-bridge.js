// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-244: Content-script bridge for the Custom Metrics training tour.
//
// Sibling of intro-tour-bridge.js (FMN-167). Reuses the same engine,
// renderer, schema, and stylesheet from extension/src/ui/intro-tour/.
// The bridge here is intentionally narrow: read its own flag, listen
// for its own start message, mount the engine over its own steps, and
// hand off to the same quiz renderer.
//
// Activation contract:
//   1. Flag fm:customMetricsTourEnabled is true.
//   2. A runtime message { type: 'fm:custom-metrics-tour:start' } arrives.
//
// Anchor strategy: most steps in this tour use anchor:'body' (centered
// floating card) because the Custom Metric management UI selectors are
// not operator-confirmed yet. The one anchorByText step ("Monitoring")
// reuses the same sidebar-search resolver shape that intro-tour-bridge
// uses; the resolver is inlined here so this bridge does not depend on
// internal exports of intro-tour-bridge.js.

(() => {
  const FLAG_KEY = 'fm:customMetricsTourEnabled';
  const START_MESSAGE_TYPE = 'fm:custom-metrics-tour:start';
  const STYLE_LINK_ID = 'fmn-intro-tour-styles';
  const STYLE_HREF = chrome.runtime.getURL('src/ui/intro-tour/styles.css');
  const ENGINE_MODULE_URL = chrome.runtime.getURL('src/ui/intro-tour/tour-engine.js');
  const QUIZ_RENDERER_URL = chrome.runtime.getURL('src/ui/intro-tour/quiz-renderer.js');
  const QUIZ_MODULE_URL = chrome.runtime.getURL('src/ui/intro-tour/quiz.js');
  const STEPS_MODULE_URL = chrome.runtime.getURL('src/ui/training-modules/custom-metrics/steps.js');

  function sidebarRoot() {
    return document.querySelector('.pa-side-nav, nav.pa-side-nav, nav[role="navigation"]') || document.body;
  }

  function findByOwnText(root, needle) {
    const wanted = String(needle).trim().toLowerCase();
    const candidates = root.querySelectorAll('*');
    let best = null;
    let bestLen = Infinity;
    for (const el of candidates) {
      let own = '';
      for (const node of el.childNodes) {
        if (node.nodeType === 3) own += node.nodeValue;
      }
      const trimmed = own.trim().toLowerCase();
      if (!trimmed) continue;
      if (trimmed.includes(wanted) && trimmed.length < bestLen) {
        best = el;
        bestLen = trimmed.length;
      }
    }
    if (best) return best;
    bestLen = Infinity;
    for (const el of candidates) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t.includes(wanted) && t.length < bestLen) {
        best = el;
        bestLen = t.length;
      }
    }
    return best;
  }

  function resolveAnchors(steps) {
    const root = sidebarRoot();
    return steps.map((step) => {
      if (!step.anchorByText && !step.anchorBySelector) return step;
      const tag = `fmn-tour-anchor-custom-metrics-${step.id}`;
      let target = null;
      if (step.anchorBySelector) {
        try { target = document.querySelector(step.anchorBySelector); } catch { target = null; }
      } else if (step.anchorByText) {
        target = findByOwnText(root, step.anchorByText);
      }
      if (target) {
        target.setAttribute('data-fmn-tour-anchor', tag);
        return { ...step, anchor: `[data-fmn-tour-anchor="${tag}"]` };
      }
      return { ...step, anchor: step.anchor_fallback || 'body' };
    });
  }

  let activeTour = null;
  let enginePromise = null;
  let quizPromise = null;
  let stepsPromise = null;
  let activeQuiz = null;

  async function isEnabled() {
    try {
      const data = await chrome.storage.local.get(FLAG_KEY);
      return Boolean(data?.[FLAG_KEY]);
    } catch {
      return false;
    }
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_LINK_ID)) return;
    const link = document.createElement('link');
    link.id = STYLE_LINK_ID;
    link.rel = 'stylesheet';
    link.href = STYLE_HREF;
    document.head.appendChild(link);
  }

  function loadEngine() {
    if (!enginePromise) enginePromise = import(ENGINE_MODULE_URL);
    return enginePromise;
  }

  function loadSteps() {
    if (!stepsPromise) stepsPromise = import(STEPS_MODULE_URL);
    return stepsPromise;
  }

  function loadQuiz() {
    if (!quizPromise) {
      quizPromise = Promise.all([
        import(QUIZ_RENDERER_URL),
        import(QUIZ_MODULE_URL)
      ]).then(([renderer, quiz]) => ({ renderer, quiz }));
    }
    return quizPromise;
  }

  async function startQuiz() {
    try {
      const [{ renderer, quiz }, steps] = await Promise.all([loadQuiz(), loadSteps()]);
      activeQuiz = renderer.renderQuiz({
        doc: document,
        state: quiz.createQuizState(steps.CUSTOM_METRICS_QUIZ),
        onFinish: () => { activeQuiz = null; }
      });
    } catch (err) {
      console.error('[FMN custom-metrics tour] quiz failed to mount', err);
    }
  }

  async function startTour() {
    if (!(await isEnabled())) return;
    if (activeTour && activeTour.isActive) return;
    if (activeQuiz) { activeQuiz.dispose?.(); activeQuiz = null; }
    ensureStyles();
    const [engineMod, stepsMod] = await Promise.all([loadEngine(), loadSteps()]);
    const resolvedSteps = resolveAnchors(stepsMod.CUSTOM_METRICS_TOUR_STEPS);
    activeTour = new engineMod.IntroTour(resolvedSteps, {
      tour_id: stepsMod.CUSTOM_METRICS_TOUR_CONSTANTS.TOUR_ID,
      doc: document,
      storage: chrome.storage.session,
      storageKey: 'fm:custom-metrics-tour:state',
      onComplete: () => {
        activeTour = null;
        startQuiz();
      },
      onDismiss: () => { activeTour = null; }
    });
    await activeTour.start();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== START_MESSAGE_TYPE) return;
    void startTour();
  });
})();
