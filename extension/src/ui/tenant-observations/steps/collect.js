// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Tenant Observations - Step 2 (Collect) - FMN-133, reworked FMN-257.
//
// Drives the long-running assessment through observations:run-audit (which
// is DETACHED in the SW since FMN-256 - the page polls
// observations:get-run-status for terminal state and reads the staged
// result blob straight out of chrome.storage.local).
//
// FMN-257: the step renders a PERSISTENT phase stepper instead of flashing
// phase labels in random places. The full expected sequence (derived from
// deep mode + selected sections) is shown up front as pending; each phase
// advances pending -> active -> done (or error) as the run reports
// progress. Two inputs drive it:
//   1. broadcast 'observations:progress' events (fast, but MV3 may drop
//      them for a backgrounded SW), and
//   2. the poll record, which now carries the latest phase id so the
//      stepper stays truthful even when broadcast events don't arrive.
// The active phase nests its per-endpoint detail under its own label - no
// floating "now fetching" line.
//
// Cancel sends 'observations:abort'.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { reportBreadcrumbs } from './start.js';
import {
  derivePhases,
  derivePhaseStates,
  progressPhaseToStepperPhase,
  advancePhase,
  PHASE_COLLECT,
  PHASE_DEEP,
  PHASE_FRONTEND_USERS,
  PHASE_FRONTEND_TEMPLATES,
  PHASE_ANALYZE,
  STATE_ACTIVE,
  STATE_DONE,
  STATE_ERROR
} from '../collect-phases.js';

const TOOL_NAME = 'Tenant Observations';

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function render({ container, store, navigate, events }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Assessing…', { toolName: TOOL_NAME, runningDot: true }));

  frame.appendChild(h('div', { class: 'step-header' },
    reportBreadcrumbs('collect'),
    h('h2', {}, 'Assessing FortiMonitor v2 API endpoints'),
    h('p', { class: 'muted' },
      'Typical runtime: 30 seconds (no deep dive) to 10+ minutes (deep dive on a ',
      'tenant with hundreds of servers). Cancel any time; a partial inventory is ',
      'discarded.'
    )
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // Run-level error banner (hidden until a whole-run failure / lost worker).
  const runErrorBanner = h('div', { class: 'phase-run-error', hidden: true });
  body.appendChild(runErrorBanner);

  // ----- phase stepper ------------------------------------------------------
  // Derive the full expected sequence up front from the run's deep flag +
  // section selection so the operator sees where they are before anything
  // moves. derivePhases mirrors the SW's own gating predicates, so the
  // stepper never shows a phase that won't run.
  const phases = derivePhases({ deep: Boolean(store.deep), sections: store.sections });
  const stepperEl = h('ul', { class: 'phase-stepper', 'data-test': 'phase-stepper' });
  body.appendChild(stepperEl);

  // Per-phase DOM handles so we can flip state classes and update the
  // detail / summary lines without re-rendering the list (re-rendering
  // would lose the spinner animation frame and flicker).
  const phaseEls = new Map();   // id -> { li, marker, name, detail, summary }
  phases.forEach((p, idx) => {
    const marker = h('span', { class: 'phase-marker' }, String(idx + 1));
    const detail = h('div', { class: 'phase-detail', hidden: true });
    const summary = h('div', { class: 'phase-summary', hidden: true });
    const name = h('div', { class: 'phase-name' }, p.label);
    const li = h('li', {
      class: 'phase-step pending',
      'data-phase': p.id,
      'data-test': `phase-${p.id}`
    }, marker, h('div', { class: 'phase-body' }, name, detail, summary));
    stepperEl.appendChild(li);
    phaseEls.set(p.id, { li, marker, name, detail, summary });
  });

  // Aggregate fetch-error list (per-endpoint / per-user errors that don't
  // abort the run). Distinct from the run-level banner above.
  const errorList = h('ul', { class: 'error-list phase-error-list', hidden: true });
  body.appendChild(errorList);

  // ----- action bar ---------------------------------------------------------
  const elapsedEl  = h('span', { 'data-test': 'elapsed-counter' }, '0:00');
  const endpointsEl = h('span', { 'data-test': 'endpoints-counter' }, '0');
  const requestEl   = h('span', { 'data-test': 'request-counter' }, '0');
  const stateLabel = h('span', { class: 'execute-state muted', 'data-test': 'state-label' }, 'Starting…');
  const countersLine = h('span', {},
    elapsedEl, ' elapsed · ',
    endpointsEl, ' endpoints · ',
    requestEl, ' requests'
  );
  const leftStack = h('div', {
    style: 'display:flex;flex-direction:column;align-items:flex-start;gap:2px;'
  }, stateLabel, countersLine);
  const cancelBtn = h('button', { class: 'btn btn-secondary' }, 'Cancel');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, leftStack),
    h('div', { class: 'right' }, cancelBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  // ----- runtime state ------------------------------------------------------
  let requests = 0;
  let endpointsDone = 0;
  let cancelled = false;
  let disposed = false;            // set on unmount; stops the FMN-256 poll loop
  let currentPhaseId = null;       // latest stepper phase entered (monotonic)
  const startTime = Date.now();
  const elapsedTimer = setInterval(() => {
    if (cancelled) return;
    elapsedEl.textContent = formatElapsed(Date.now() - startTime);
  }, 1000);

  function setState(label, cls) {
    stateLabel.textContent = label;
    stateLabel.className = cls ? `execute-state ${cls}` : 'execute-state';
  }

  function appendError(msg) {
    errorList.hidden = false;
    errorList.appendChild(h('li', {}, msg));
  }

  // Set a phase's visible state. `detailText`/`summaryText` are optional;
  // active phases show detail, done phases show summary, others hide both.
  function setPhaseState(id, state) {
    const refs = phaseEls.get(id);
    if (!refs) return;
    refs.li.className = `phase-step ${state}`;
    const num = phases.findIndex((p) => p.id === id) + 1;
    if (state === STATE_DONE) {
      refs.marker.textContent = '✓';
    } else if (state === STATE_ERROR) {
      refs.marker.textContent = '✗';
    } else if (state === STATE_ACTIVE) {
      // Spinner element (CSS-animated). Replace the numeral.
      refs.marker.textContent = '';
      if (!refs.marker.querySelector('.phase-spinner')) {
        refs.marker.appendChild(h('span', { class: 'phase-spinner' }));
      }
    } else {
      refs.marker.textContent = String(num);
    }
    // Visibility: detail belongs to the active/error phase; summary to done.
    refs.detail.hidden = !(state === STATE_ACTIVE || state === STATE_ERROR);
    refs.summary.hidden = state !== STATE_DONE;
  }

  function setPhaseDetail(id, text, { error = false } = {}) {
    const refs = phaseEls.get(id);
    if (!refs) return;
    refs.detail.hidden = false;
    refs.detail.className = error ? 'phase-detail error' : 'phase-detail';
    refs.detail.textContent = text;
  }

  function setPhaseSummary(id, text) {
    const refs = phaseEls.get(id);
    if (!refs) return;
    refs.summary.hidden = false;
    refs.summary.textContent = text;
  }

  // Apply the full pending/active/done layout for a given current phase.
  // Earlier phases become done; the current is active; later stay pending.
  // Preserves any summary text already written on now-done phases.
  function applyPhaseLayout(nextPhaseId, { terminal = null } = {}) {
    const states = derivePhaseStates({ phases, currentPhaseId: nextPhaseId, terminal });
    for (const p of phases) setPhaseState(p.id, states[p.id]);
  }

  // Advance to a phase if it's at/after the current one (monotonic), then
  // relayout. Returns the (possibly unchanged) current phase id.
  function enterPhase(nextPhaseId) {
    const advanced = advancePhase(phases, currentPhaseId, nextPhaseId);
    if (advanced !== currentPhaseId) {
      currentPhaseId = advanced;
      applyPhaseLayout(currentPhaseId);
    } else if (currentPhaseId === null && advanced === null) {
      // nothing entered yet
    }
    return currentPhaseId;
  }

  // Seed: nothing active until the first event/poll moves us. Show the
  // collect phase's detail placeholder so the active row reads sensibly the
  // instant the run starts.
  applyPhaseLayout(null);

  // ----- progress event wiring ----------------------------------------------
  const unsubscribe = events.on((event, payload) => {
    if (event !== 'observations:progress' || !payload) return;

    // Advance the stepper to whatever phase this event belongs to.
    const phaseForEvent = progressPhaseToStepperPhase(payload.phase, payload);
    if (phaseForEvent) enterPhase(phaseForEvent);

    switch (payload.phase) {
      case 'collect:start':
        if (currentPhaseId === PHASE_COLLECT) {
          setPhaseDetail(PHASE_COLLECT, 'Awaiting first request…');
        }
        break;
      case 'collect:event': {
        const inner = payload;
        switch (inner.type) {
          case 'endpoint-start':
            requests += 1;
            requestEl.textContent = String(requests);
            if (currentPhaseId === PHASE_COLLECT) {
              setPhaseDetail(PHASE_COLLECT, `→ ${inner.name}`);
            }
            break;
          case 'endpoint-done':
            endpointsDone += 1;
            endpointsEl.textContent = String(endpointsDone);
            setPhaseSummary(PHASE_COLLECT, `${endpointsDone} endpoints assessed`);
            break;
          case 'endpoint-error':
            endpointsDone += 1;
            endpointsEl.textContent = String(endpointsDone);
            setPhaseSummary(PHASE_COLLECT, `${endpointsDone} endpoints assessed`);
            appendError(`${inner.name}: ${inner.error ?? 'unknown error'}`);
            break;
          case 'deep-server':
            // The deep-server tick already advanced us into PHASE_DEEP above.
            setPhaseDetail(PHASE_DEEP, `server ${inner.index} of ${inner.total}`);
            setPhaseSummary(PHASE_DEEP, `${inner.index} of ${inner.total} servers`);
            break;
          case 'collect-done':
            // Collect crawl finished; if no deep phase, the next event moves
            // us forward. Lock in the final endpoint count summary.
            setPhaseSummary(PHASE_COLLECT, `${endpointsDone} endpoints assessed`);
            break;
          default:
            break;
        }
        break;
      }
      case 'frontend:start':
        setPhaseDetail(PHASE_FRONTEND_USERS, `0 of ${payload.total ?? '?'} users`);
        break;
      case 'frontend:event': {
        const inner = payload;
        // The SW threads BOTH the per-user and per-template walks through
        // the 'frontend:event' phase; the inner.type disambiguates which
        // walk (and therefore which stepper phase) a tick belongs to.
        if (inner.type === 'frontend-user-start') {
          requests += 1;
          requestEl.textContent = String(requests);
          setPhaseDetail(PHASE_FRONTEND_USERS, `user ${inner.index} of ${inner.total}`);
        } else if (inner.type === 'frontend-user-error') {
          appendError(`UI fetch user ${inner.id ?? '?'}: ${inner.error ?? 'unknown error'}`);
        } else if (inner.type === 'frontend-template-start') {
          // Template ticks advance us into the template-config phase even
          // though they share the frontend:event phase key.
          enterPhase(PHASE_FRONTEND_TEMPLATES);
          requests += 1;
          requestEl.textContent = String(requests);
          setPhaseDetail(PHASE_FRONTEND_TEMPLATES, `template ${inner.index} of ${inner.total}`);
        } else if (inner.type === 'frontend-template-error') {
          appendError(`UI fetch template ${inner.id ?? '?'}: ${inner.error ?? 'unknown error'}`);
        }
        break;
      }
      case 'frontend:done':
        setPhaseSummary(PHASE_FRONTEND_USERS, 'users complete');
        break;
      case 'frontend:error':
        setPhaseDetail(PHASE_FRONTEND_USERS, payload.error ?? 'fetch failed', { error: true });
        appendError(`UI fetch: ${payload.error ?? 'unknown error'}`);
        break;
      case 'frontend-templates:start':
        setPhaseDetail(PHASE_FRONTEND_TEMPLATES, `0 of ${payload.total ?? '?'} templates`);
        break;
      case 'frontend-templates:done':
        setPhaseSummary(PHASE_FRONTEND_TEMPLATES, 'templates complete');
        break;
      case 'frontend-templates:error':
        setPhaseDetail(PHASE_FRONTEND_TEMPLATES, payload.error ?? 'fetch failed', { error: true });
        appendError(`UI fetch templates: ${payload.error ?? 'unknown error'}`);
        break;
      case 'analyze:start':
        setPhaseDetail(PHASE_ANALYZE, 'Running analyzers…');
        setState('Running analyzers…', 'muted');
        break;
      case 'analyze:done':
        setPhaseSummary(PHASE_ANALYZE, 'complete');
        break;
      default:
        break;
    }
  });

  cancelBtn.addEventListener('click', async () => {
    if (cancelled) return;
    cancelled = true;
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelling…';
    setState('Cancelling…', 'muted');
    try { await call('observations:abort', {}); } catch { /* run promise will reject */ }
  });

  // Watchdog: if analyze:done has fired but the run hasn't reached a
  // terminal state within this window, surface a stalled-state warning
  // instead of an indefinite spinner (FMN-133).
  let stallTimer = null;
  const STALL_TIMEOUT_MS = 8000;
  const innerUnsub = events.on((event, payload) => {
    if (event === 'observations:progress' && payload?.phase === 'analyze:done') {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (cancelled) return;
        if (!stateLabel.dataset.resolved) {
          setState('Stalled returning result; service worker may have stopped.', 'error');
          showRunError('Stalled returning result; the service worker may have stopped.');
          applyPhaseLayout(currentPhaseId, { terminal: STATE_ERROR });
          cancelBtn.textContent = 'Back to start';
          cancelBtn.disabled = false;
          cancelBtn.classList.remove('btn-secondary');
          cancelBtn.classList.add('btn-primary');
          cancelBtn.onclick = () => navigate('/start');
        }
      }, STALL_TIMEOUT_MS);
    }
  });

  function showRunError(msg) {
    runErrorBanner.hidden = false;
    runErrorBanner.textContent = msg;
  }

  function markResolved() {
    stateLabel.dataset.resolved = '1';
    clearTimeout(stallTimer);
    innerUnsub();
  }

  // ----- detached-run poll loop (FMN-256) -----------------------------------
  // Poll the detached run's status until terminal. The status record now
  // carries the latest stepper phase (FMN-257), so when broadcast progress
  // events are dropped (MV3 backgrounds the SW), the poll still advances the
  // stepper. Resolves on 'done'; throws on error / cancelled / lost / none.
  const POLL_INTERVAL_MS = 1500;
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async function pollUntilTerminal() {
    for (;;) {
      if (disposed) {
        const e = new Error('disposed'); e.name = 'AbortError'; throw e;
      }
      const s = await call('observations:get-run-status', {});
      const status = s?.status;
      // Poll-driven stepper advance: if the record carries a phase we
      // haven't reached via broadcast events, catch up. Never moves
      // backwards (advancePhase is monotonic).
      if (s?.phase) enterPhase(s.phase);
      if (status === 'done') return;
      if (status === 'cancelled') {
        const e = new Error('tenant observations cancelled');
        e.name = 'AbortError';
        throw e;
      }
      if (status === 'error') {
        throw new Error(s.error || 'Tenant observations run failed');
      }
      if (status === 'lost') {
        throw new Error('The background worker stopped before the run finished. Reload the extension and run again.');
      }
      if (status === 'none') {
        throw new Error('Run state was lost before completion. Reload the extension and run again.');
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  const DEFAULT_RESULT_KEY = 'observations.lastResult';
  const DEFAULT_RUN_KEY = 'observations.lastRun';
  async function readStagedResult(resultKey) {
    const key = resultKey || DEFAULT_RESULT_KEY;
    const local = (typeof chrome !== 'undefined') ? chrome.storage?.local : null;
    if (local?.get) {
      const stored = await local.get(key);
      const result = stored?.[key];
      if (!result) {
        throw new Error('Run finished but its result was not found in storage. Reload the extension and run again.');
      }
      if (local.remove) { try { await local.remove([key, DEFAULT_RUN_KEY]); } catch { /* best-effort */ } }
      return result;
    }
    return call('observations:get-run-result', {});
  }

  (async () => {
    try {
      const handle = await call('observations:run-audit', {
        deep: Boolean(store.deep),
        maxServers: store.maxServers ?? 0,
        // FMN-135 follow-up: always-on; the operator is logged into
        // FortiMonitor when running the wizard.
        includeFrontend: true,
        sections: Array.isArray(store.sections) && store.sections.length > 0
          ? store.sections
          : ['all']
      });

      await pollUntilTerminal();

      const result = await readStagedResult(handle?.resultKey);
      markResolved();
      store.runResult = result;
      // Mark every phase done.
      applyPhaseLayout(currentPhaseId, { terminal: STATE_DONE });
      setState(`Done in ${formatElapsed(Date.now() - startTime)}.`, '');
      setTimeout(() => navigate('/analyze'), 250);
    } catch (err) {
      markResolved();
      const isAbort = err?.name === 'AbortError' || /cancelled/i.test(err?.message ?? '');
      if (isAbort || cancelled) {
        store.runCancelled = true;
        setState('Cancelled.', 'muted');
        // Cancelled: the in-flight phase reverts to pending (work stopped),
        // earlier phases stay done.
        applyPhaseLayout(currentPhaseId, { terminal: 'cancelled' });
      } else {
        store.runError = err?.message ?? String(err);
        setState(`Error: ${store.runError}`, 'error');
        showRunError(store.runError);
        // Mark the phase we were in as errored; earlier phases stay done.
        applyPhaseLayout(currentPhaseId, { terminal: STATE_ERROR });
      }
      cancelBtn.textContent = 'Back to start';
      cancelBtn.disabled = false;
      cancelBtn.classList.remove('btn-secondary');
      cancelBtn.classList.add('btn-primary');
      cancelBtn.onclick = () => navigate('/start');
    }
  })();

  return () => {
    disposed = true;
    unsubscribe();
    innerUnsub();
    clearTimeout(stallTimer);
    clearInterval(elapsedTimer);
  };
}
