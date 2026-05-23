// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-167 / FMN-250: content-script bridge for the intro tour. Listens
// for the runtime "start" message, mounts the scoped stylesheet, and
// drives the engine over INTRO_TOUR_STEPS.
//
// This file is loaded by augment.js (registered as an augmentation
// alongside the other content-script features). It is intentionally
// self-contained so future tour tickets (FMN-168 OnSight) can register
// alongside without touching this module's internals.
//
// Activation contract (FMN-250):
//   A runtime message { type: 'fm:intro-tour:start' } from the popup's
//   Intro tile (inside the Training drill-in) drives the tour. The
//   per-module Settings flag was retired; the popup tile is always
//   available inside the drill-in, so no storage-side gate exists.

(() => {
  // FMN-250 retired the per-module Settings toggle for this tour; the
  // Intro tile lives unconditionally inside the popup's Training drill-
  // in. There is no longer a flag to gate startTour() on - any
  // fm:intro-tour:start message that reaches the bridge is honored.
  const START_MESSAGE_TYPE = 'fm:intro-tour:start';
  const STYLE_LINK_ID = 'fmn-intro-tour-styles';
  const STYLE_HREF = chrome.runtime.getURL('src/ui/intro-tour/styles.css');
  const ENGINE_MODULE_URL = chrome.runtime.getURL('src/ui/intro-tour/tour-engine.js');

  // INTRO_TOUR_STEPS: a 14-step walk-through covering the FortiMonitor
  // UI layout (sidebar, Header, Control Panel), every top-level sidebar
  // entry (Dashboards, Monitoring, Incidents, Maintenance, Reporting,
  // Teams & Activity), the +Add button and the sidebar collapse icon,
  // plus a toolkit handoff and a wrap-up before the quiz.
  //
  // Anchor types:
  //   - anchorBySelector: an explicit CSS selector resolved verbatim.
  //     Used for the sidebar container in the layout overview.
  //   - anchorByText: text match against any element under the sidebar.
  //     The resolver tags the first match with a data attribute.
  //   - anchorByAriaLabel: aria-label match for icon-only controls (the
  //     collapse icon doesn't carry visible text).
  //   - anchor: 'body' renders as a centered floating card via the
  //     renderer's existing floating fallback.
  //
  // Unresolved anchors fall back to step.anchor_fallback (default 'body'),
  // so a renamed entry degrades to a floating caption rather than
  // hanging the tour.
  const INTRO_TOUR_STEPS = [
    {
      id: 'welcome',
      anchor: 'body',
      anchor_fallback: 'body',
      caption_html: [
        '<p><strong>Welcome to FortiMonitor.</strong> This introduction ',
        'covers the layout of the console and every entry in the left-side ',
        'menu, followed by a quick 3-question check at the end.</p>',
        '<p>Click <strong>Next</strong> to begin.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'auto'
    },
    {
      id: 'layout-overview',
      anchorBySelector: '.pa-side-nav, nav.pa-side-nav, nav[role="navigation"]',
      anchor_fallback: 'body',
      caption_html: [
        '<p>The FortiMonitor UI has three regions. The <strong>left sidebar</strong> ',
        '(highlighted) is your primary navigation; each entry opens a ',
        'workspace. The <strong>Header</strong> runs across the top with ',
        'global search, your account menu, and tenant-level controls. The ',
        '<strong>Control Panel</strong> on the right is the workspace where ',
        'each page lives.</p>',
        '<p>The next two steps spotlight the Header and the Control Panel ',
        'before the sidebar walk-through.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'right'
    },
    {
      id: 'header',
      anchorBySelector: '.fn1-header',
      anchor_fallback: 'body',
      caption_html: [
        '<p>The <strong>Header</strong> sits across the very top of every ',
        'FortiMonitor page. It holds the global search ("Search all fields") ',
        'for finding instances, metrics, and reports by name; your account ',
        'menu (top right) for switching tenants, signing out, and reaching ',
        'documentation; and the notification bell. The Unofficial FortiMonitor ',
        'Toolkit also adds its own search chip ("FM TK") here when enabled.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'bottom'
    },
    {
      id: 'control-panel',
      anchorBySelector: 'div.pa-main',
      anchor_fallback: 'body',
      caption_html: [
        '<p>The <strong>Control Panel</strong> is the entire main workspace ',
        'to the right of the sidebar. It contains the page-header bar at the ',
        'top (which shows your current location and any page-level tabs or ',
        'actions) and the workspace itself for the page you are on (lists, ',
        'configuration forms, dashboards, etc.). Its contents change completely ',
        'as you navigate between sidebar entries.</p>'
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
      id: 'nav-maintenance',
      anchorByText: 'Maintenance',
      anchor_fallback: 'body',
      caption_html: [
        '<p><strong>Maintenance</strong> is where you schedule planned ',
        'downtime windows. While a window is active FortiMonitor suppresses ',
        'alerts for the affected instances, so a planned reboot or upgrade ',
        'does not page the on-call rotation.</p>'
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
        'The Unofficial FortiMonitor Toolkit adds extra report cards here ',
        'when you enable them in its Settings.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'right'
    },
    {
      id: 'nav-teams-activity',
      anchorByText: 'Teams & Activity',
      anchor_fallback: 'body',
      caption_html: [
        '<p><strong>Teams &amp; Activity</strong> is your user, role, and ',
        'integration management. Okta / SAML SSO, notification rules, ',
        'PagerDuty / Teams / Slack hooks, and shift schedules all live here. ',
        'New operator onboarding usually starts in this section.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'right'
    },
    {
      id: 'sidebar-add',
      anchorByText: 'Add',
      anchor_fallback: 'body',
      caption_html: [
        '<p>The <strong>+ Add</strong> button at the bottom of the sidebar is ',
        'the universal "add a new thing" entry point. It opens a picker for ',
        'new instances, dashboards, users, schedules, and other resources - ',
        'whatever the current tenant context supports.</p>'
      ].join(''),
      when: { always: true },
      advance: 'next-button',
      placement: 'right'
    },
    {
      id: 'sidebar-collapse',
      anchorBySelector: 'svg:has(use[*|href="#leftnav_collapse_24dp"])',
      anchor_fallback: 'body',
      caption_html: [
        '<p>The <strong>collapse</strong> icon at the bottom of the sidebar ',
        'shrinks the menu to a thin icon-only strip - useful on smaller ',
        'screens, or when you want maximum real estate for the main content ',
        'area. Click it again to expand back to the full labels.</p>'
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

  // Resolve the various anchor hint fields against the live DOM right
  // before runTour, rewriting step.anchor to a stable selector the
  // engine can use:
  //   - anchorBySelector: used verbatim (resolver verifies the selector
  //     resolves to something before rewriting).
  //   - anchorByText: searches the sidebar for any element whose own
  //     direct text (NOT its descendants') contains the needle. This
  //     biases the match toward leaf labels like the "Dashboards" entry
  //     rather than the entire <nav> container.
  //   - anchorByAriaLabel: searches the sidebar for an element whose
  //     aria-label contains the needle. Used for icon-only buttons that
  //     have no visible text (the sidebar collapse control).
  // Matched nodes are tagged with `data-fmn-tour-anchor="<step-id>"`
  // and step.anchor is rewritten to that attribute selector so the
  // engine's MutationObserver wait + the renderer's querySelector both
  // find the same node, even across re-renders.
  function sidebarRoot() {
    return document.querySelector('.pa-side-nav') ||
           document.querySelector('nav.pa-side-nav') ||
           document.querySelector('nav[role="navigation"]') ||
           document.body;
  }

  function findByOwnText(root, needle) {
    const wanted = String(needle).trim().toLowerCase();
    const candidates = root.querySelectorAll('*');
    let best = null;
    let bestLen = Infinity;
    for (const el of candidates) {
      // Collect direct text content (children's text omitted).
      let own = '';
      for (const node of el.childNodes) {
        if (node.nodeType === 3 /* TEXT_NODE */) own += node.nodeValue;
      }
      const trimmed = own.trim().toLowerCase();
      if (!trimmed) continue;
      if (trimmed.includes(wanted) && trimmed.length < bestLen) {
        best = el;
        bestLen = trimmed.length;
      }
    }
    if (best) return best;
    // Fallback: any element whose total textContent contains the
    // needle, biased toward small subtrees so we don't end up
    // anchoring the whole <nav>.
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

  function findByAriaLabel(root, needle) {
    const wanted = String(needle).trim().toLowerCase();
    const candidates = root.querySelectorAll('[aria-label]');
    for (const el of candidates) {
      const label = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      if (label.includes(wanted)) return el;
    }
    return null;
  }

  function resolveSidebarAnchors(steps) {
    const root = sidebarRoot();
    return steps.map((step) => {
      const tag = `fmn-tour-anchor-${step.id}`;
      let target = null;
      if (step.anchorBySelector) {
        try { target = document.querySelector(step.anchorBySelector); } catch { target = null; }
      } else if (step.anchorByText) {
        target = findByOwnText(root, step.anchorByText);
      } else if (step.anchorByAriaLabel) {
        target = findByAriaLabel(root, step.anchorByAriaLabel);
      } else {
        return step;
      }
      if (target) {
        target.setAttribute('data-fmn-tour-anchor', tag);
        return { ...step, anchor: `[data-fmn-tour-anchor="${tag}"]` };
      }
      // Unresolved hints fall back to floating.
      return { ...step, anchor: step.anchor_fallback || 'body' };
    });
  }

  // Idempotent state: only one tour instance at a time.
  let activeTour = null;
  let enginePromise = null;
  let quizPromise = null;
  let activeQuiz = null;

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
