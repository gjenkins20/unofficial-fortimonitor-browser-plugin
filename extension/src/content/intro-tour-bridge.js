// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-167: content-script bridge for the intro tour. Wires the engine
// to the FortiMonitor page: reads the per-tool visibility flag, listens
// for the runtime "start" message, mounts the scoped stylesheet, and
// drives the engine over INTRO_TOUR_STEPS.
//
// This file is loaded by augment.js (registered as an augmentation
// alongside the other content-script features). It is intentionally
// self-contained so future tour tickets (FMN-168 OnSight) can register
// alongside without touching this module's internals.
//
// Activation contract:
//   1. The flag fm:introTourEnabled must be true (default false).
//   2. A runtime message { type: 'fm:intro-tour:start' } arrives - sent
//      by the popup tile (future FMN-167b) or any extension context.
//
// To exercise the stub before FMN-167b ships the popup tile, the
// operator can:
//   chrome.storage.local.set({ 'fm:introTourEnabled': true })
//   chrome.runtime.sendMessage({ type: 'fm:intro-tour:start' })
// from the popup's DevTools console; the message broadcasts to all
// FortiMonitor tabs.

(() => {
  const FLAG_KEY = 'fm:introTourEnabled';
  const START_MESSAGE_TYPE = 'fm:intro-tour:start';
  const STYLE_LINK_ID = 'fmn-intro-tour-styles';
  const STYLE_HREF = chrome.runtime.getURL('src/ui/intro-tour/styles.css');
  const ENGINE_MODULE_URL = chrome.runtime.getURL('src/ui/intro-tour/tour-engine.js');

  // INTRO_TOUR_STEPS: FMN-167 ships exactly one step (Dashboards).
  // FMN-167a (full content authoring) replaces this list with the
  // operator-authored captioned script.
  //
  // Anchor: the FortiMonitor left-sidebar carries an unordered list of
  // top-level entries. `li.pa-side-nav__top-level-item` is the most
  // stable selector across tenants (seen in augment.js as well). For
  // the Dashboards entry specifically, we filter via :has(...) when
  // available, falling back to the first top-level item otherwise -
  // the fallback is acceptable for a one-step POC; the captioned-script
  // ticket validates each anchor against a live tenant.
  const INTRO_TOUR_STEPS = [
    {
      id: 'dashboards-welcome',
      anchor: 'li.pa-side-nav__top-level-item',
      anchor_fallback: 'body',
      caption_html: [
        '<p><strong>Welcome to FortiMonitor.</strong> This short walkthrough ',
        'will introduce you to the main areas of the FortiMonitor console.</p>',
        '<p>The highlighted entry on the left is the start of the sidebar ',
        'navigation. Click <strong>Next</strong> when you are ready.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'right'
    }
  ];

  // Idempotent state: only one tour instance at a time.
  let activeTour = null;
  let enginePromise = null;
  let quizPromise = null;
  let activeQuiz = null;

  /**
   * Read the fm:introTourEnabled flag. Storage errors fail closed so a
   * blip never accidentally launches the tour.
   */
  async function isEnabled() {
    try {
      const data = await chrome.storage.local.get(FLAG_KEY);
      return Boolean(data?.[FLAG_KEY]);
    } catch {
      return false;
    }
  }

  /**
   * Append the scoped stylesheet to <head> if it isn't already there.
   * Idempotent - the id check prevents duplicate <link> tags on tab
   * navigations that re-run augment.js.
   */
  function ensureStyles() {
    if (document.getElementById(STYLE_LINK_ID)) return;
    const link = document.createElement('link');
    link.id = STYLE_LINK_ID;
    link.rel = 'stylesheet';
    link.href = STYLE_HREF;
    document.head.appendChild(link);
  }

  /**
   * Lazy-load the engine module the first time a start message arrives.
   * Cached on enginePromise so repeated starts don't re-import.
   */
  function loadEngine() {
    if (!enginePromise) enginePromise = import(ENGINE_MODULE_URL);
    return enginePromise;
  }

  // FMN-167: quiz renderer + state factory live in a separate module
  // so the engine itself stays narrow (the tour is just steps; the quiz
  // is a sibling experience the bridge orchestrates on tour completion).
  const QUIZ_RENDERER_URL = chrome.runtime.getURL('src/ui/intro-tour/quiz-renderer.js');
  const QUIZ_MODULE_URL = chrome.runtime.getURL('src/ui/intro-tour/quiz.js');

  function loadQuizModules() {
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
      const { renderer, quiz } = await loadQuizModules();
      activeQuiz = renderer.renderQuiz({
        doc: document,
        state: quiz.createQuizState(),
        onFinish: () => { activeQuiz = null; }
      });
    } catch (err) {
      console.error('[FMN intro-tour] quiz failed to mount', err);
    }
  }

  async function startTour() {
    if (!(await isEnabled())) return;
    if (activeTour && activeTour.isActive) return;
    if (activeQuiz) { activeQuiz.dispose(); activeQuiz = null; }
    ensureStyles();
    const mod = await loadEngine();
    activeTour = new mod.IntroTour(INTRO_TOUR_STEPS, {
      tour_id: 'intro-fortimonitor',
      doc: document,
      storage: chrome.storage.session,
      storageKey: 'fm:intro-tour:state',
      onComplete: () => {
        activeTour = null;
        // FMN-167: post-tour quiz to solidify the material. Mounts as
        // a sibling overlay using the same scoped stylesheet; the
        // engine has already torn down its own overlay before this
        // callback fires.
        startQuiz();
      },
      onDismiss: () => { activeTour = null; }
    });
    await activeTour.start();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== START_MESSAGE_TYPE) return;
    // Swallow errors locally - we don't want a bridge failure on one
    // tab to fail the runtime message dispatch on the others.
    startTour().catch((err) => console.error('[FMN intro-tour]', err));
  });

  // Expose a tiny diagnostic hook so the operator can verify the bridge
  // is alive without sending a message (helpful during the operator-QA
  // step in this ticket's report).
  // eslint-disable-next-line no-undef
  if (typeof window !== 'undefined') {
    window.__fmnIntroTour = {
      isReady: true,
      startNow: () => startTour(),
      stepsCount: INTRO_TOUR_STEPS.length
    };
  }
})();
