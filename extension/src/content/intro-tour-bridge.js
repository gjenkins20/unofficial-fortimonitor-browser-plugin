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

  // INTRO_TOUR_STEPS: a 7-step walk-through of FortiMonitor's left
  // sidebar plus floating welcome / handoff / wrap-up steps. Every
  // anchored step targets a `li.pa-side-nav__top-level-item` in the
  // FortiMonitor sidebar, looked up by text content via
  // `anchorByText` and resolved to a data-attribute selector at start
  // time (see resolveSidebarAnchors below). Steps with `anchor: 'body'`
  // render as floating cards centered on the viewport - the renderer
  // already supports this via the floating fallback.
  //
  // The text-based lookup keeps the tour resilient to FortiMonitor
  // reshuffling sidebar order: as long as the entry labels stay the
  // same, the anchor finds it.
  const INTRO_TOUR_STEPS = [
    {
      id: 'welcome',
      anchor: 'body',
      anchor_fallback: 'body',
      caption_html: [
        '<p><strong>Welcome to FortiMonitor.</strong> This short walk-through ',
        'covers the main areas of the console you will use day-to-day, ',
        'followed by a quick 3-question check.</p>',
        '<p>Click <strong>Next</strong> to begin.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'auto'
    },
    {
      id: 'nav-dashboards',
      anchorByText: 'Dashboards',
      anchor_fallback: 'body',
      caption_html: [
        '<p><strong>Dashboards</strong> is your at-a-glance overview. ',
        'Operators build cards here for the servers, alerts, and metrics ',
        'they monitor most often. It is typically where you start your day.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'right'
    },
    {
      id: 'nav-monitoring',
      anchorByText: 'Monitoring',
      anchor_fallback: 'body',
      caption_html: [
        '<p><strong>Monitoring</strong> expands to your Instances list, ',
        'OnSight appliances, public probes, and the attributes and tags ',
        'used to classify devices. This is where you drill into a specific ',
        'instance and see its live metrics, configured thresholds, and ',
        'recent alerts.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'right'
    },
    {
      id: 'nav-incidents',
      anchorByText: 'Incidents',
      anchor_fallback: 'body',
      caption_html: [
        '<p><strong>Incidents</strong> is your live operations queue - ',
        'currently-open alerts grouped by severity. The number badge on ',
        'the entry counts currently-active items. Resolved alerts move to ',
        'the historical timeline elsewhere.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'right'
    },
    {
      id: 'nav-reporting',
      anchorByText: 'Reporting',
      anchor_fallback: 'body',
      caption_html: [
        '<p><strong>Reporting</strong> hosts canned reports (uptime, SLA, ',
        'audits), on-demand exports, and your tenant&apos;s activity history. ',
        'The Unofficial FortiMonitor Toolkit adds extra cards here when ',
        'you enable them in its Settings.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'right'
    },
    {
      id: 'toolkit-handoff',
      anchor: 'body',
      anchor_fallback: 'body',
      caption_html: [
        '<p>This walk-through was launched by the <strong>Unofficial ',
        'FortiMonitor Toolkit</strong> - a Chrome extension that adds bulk ',
        'operations, snapshots, and additional reports on top of stock ',
        'FortiMonitor.</p>',
        '<p>Open its icon in your Chrome toolbar (top-right of the browser ',
        'window) any time to see the full tool catalog.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'auto'
    },
    {
      id: 'wrap-up',
      anchor: 'body',
      anchor_fallback: 'body',
      caption_html: [
        '<p>That is the orientation. Click <strong>Next</strong> for a quick ',
        'three-question check to lock in what you just covered.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'auto'
    }
  ];

  // Resolve `anchorByText` steps against the live FortiMonitor sidebar.
  // The CSS step.anchor field is overwritten with a stable data-attribute
  // selector pointing at the matched <li>. Steps whose text doesn't
  // resolve fall through to their anchor_fallback (typically 'body' for
  // a floating card). The data attribute is unique per step id so the
  // engine's MutationObserver-based anchor wait finds the right node
  // even if FortiMonitor re-renders the sidebar.
  function resolveSidebarAnchors(steps) {
    const items = document.querySelectorAll('li.pa-side-nav__top-level-item');
    return steps.map((step) => {
      if (!step.anchorByText) return step;
      const needle = String(step.anchorByText).toLowerCase();
      for (const item of items) {
        const text = (item.textContent || '').trim().toLowerCase();
        if (text.includes(needle)) {
          const attr = `fmn-tour-anchor-${step.id}`;
          item.setAttribute('data-fmn-tour-anchor', attr);
          return { ...step, anchor: `[data-fmn-tour-anchor="${attr}"]` };
        }
      }
      // Text not found - fall through to anchor_fallback (floating).
      return { ...step, anchor: step.anchor_fallback || 'body' };
    });
  }

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
    // Resolve sidebar anchors against the live DOM right before runTour.
    // Doing this at start time (rather than at module load) gives the
    // FortiMonitor Vue sidebar a chance to finish hydrating; the
    // engine's MutationObserver still handles the case where the anchor
    // arrives after start.
    const resolvedSteps = resolveSidebarAnchors(INTRO_TOUR_STEPS);
    activeTour = new mod.IntroTour(resolvedSteps, {
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
