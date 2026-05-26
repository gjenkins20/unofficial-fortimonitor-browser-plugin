// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Tenant Observations - Step 2 (Collect) - FMN-133.
//
// Drives the long-running assessment through observations:run-audit. The handler
// emits 'observations:progress' events that we wire through to:
//   - an elapsed-time clock that ticks every second
//   - a per-endpoint progress counter
//   - a "currently fetching" sticky line that names the active endpoint
//   - a scrollable history of completed endpoints with their row counts
//
// Cancel sends 'observations:abort'.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { reportBreadcrumbs } from './start.js';

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

  // Counters live in the action bar's .left column (see actionBar below)
  // so they inherit its 12px / muted styling. Bold prominent counters
  // ride too high in the visual hierarchy for what is essentially run
  // metadata (FMN-133 QA, 2026-05-01).
  const elapsedEl  = h('span', { 'data-test': 'elapsed-counter' }, '0:00');
  const endpointsEl = h('span', { 'data-test': 'endpoints-counter' }, '0');
  const requestEl   = h('span', { 'data-test': 'request-counter' }, '0');

  const phaseLabel = h('div', {
    'data-test': 'phase-label',
    style: 'margin-top:0.3rem;font-size:0.95rem;font-weight:500;'
  }, 'Starting…');
  body.appendChild(phaseLabel);

  // Sticky "currently fetching" line that names the active endpoint -
  // visible signal that the run hasn't stalled.
  const nowFetching = h('div', {
    'data-test': 'now-fetching',
    style: 'margin-top:0.3rem;font-family:monospace;font-size:0.85rem;color:#1f4e79;background:#f0f4fb;padding:0.3rem 0.6rem;border-radius:4px;border-left:3px solid #1f4e79;'
  }, 'Awaiting first request…');
  body.appendChild(nowFetching);

  const endpointList = h('ul', {
    'data-test': 'endpoint-list',
    style: 'margin-top:0.6rem;font-family:monospace;font-size:0.85rem;max-height:14rem;overflow:auto;border:1px solid #ddd;padding:0.4rem 0.7rem;border-radius:4px;background:#fafafa;'
  });
  body.appendChild(endpointList);

  const errorList = h('ul', { class: 'error-list', style: 'margin-top:0.6rem;font-size:0.85rem;color:#b04;' });
  body.appendChild(errorList);

  const stateLabel = h('span', { class: 'execute-state muted' }, 'Starting…');
  const countersLine = h('span', {},
    elapsedEl, ' elapsed · ',
    endpointsEl, ' endpoints · ',
    requestEl, ' requests'
  );
  // Stack stateLabel + counters vertically inside the action bar's .left
  // column so they share its 12px muted styling (FMN-133 QA feedback).
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
  let disposed = false;   // set on unmount; stops the FMN-256 poll loop
  const endpointItems = new Map();              // name -> <li>
  const startTime = Date.now();
  const elapsedTimer = setInterval(() => {
    if (cancelled) return;
    elapsedEl.textContent = formatElapsed(Date.now() - startTime);
  }, 1000);

  function appendError(msg) { errorList.appendChild(h('li', {}, msg)); }

  function endpointItem(name) {
    let li = endpointItems.get(name);
    if (!li) {
      li = h('li', { 'data-endpoint': name }, `${name}: queued`);
      endpointList.appendChild(li);
      endpointItems.set(name, li);
    }
    return li;
  }

  const unsubscribe = events.on((event, payload) => {
    if (event !== 'observations:progress' || !payload) return;
    switch (payload.phase) {
      case 'collect:start':
        phaseLabel.textContent = payload.deep
          ? 'Phase 1: top-level lists (deep dive enabled)'
          : 'Phase 1: top-level lists';
        break;
      case 'collect:event': {
        const inner = payload;
        switch (inner.type) {
          case 'endpoint-start':
            endpointItem(inner.name).textContent = `${inner.name}: fetching…`;
            nowFetching.textContent = `→ ${inner.name}`;
            requests += 1;
            requestEl.textContent = String(requests);
            break;
          case 'endpoint-done':
            endpointItem(inner.name).textContent = `${inner.name}: ${inner.count ?? 0}`;
            endpointsDone += 1;
            endpointsEl.textContent = String(endpointsDone);
            break;
          case 'endpoint-error':
            endpointItem(inner.name).textContent = `${inner.name}: error`;
            endpointsDone += 1;
            endpointsEl.textContent = String(endpointsDone);
            appendError(`${inner.name}: ${inner.error ?? 'unknown error'}`);
            break;
          case 'deep-server':
            phaseLabel.textContent = `Phase 2: per-server deep dive (${inner.index} of ${inner.total})`;
            nowFetching.textContent = `→ server ${inner.index} of ${inner.total}`;
            break;
          case 'collect-done':
            phaseLabel.textContent = `Inventory complete in ${formatElapsed(Date.now() - startTime)} (${inner.requests ?? requests} requests).`;
            nowFetching.textContent = '✓ all endpoints assessed';
            break;
          default:
            break;
        }
        break;
      }
      case 'frontend:start':
        phaseLabel.textContent = `Phase 3: FortiMonitor UI data (${payload.total ?? '?'} user pages)`;
        nowFetching.textContent = '→ FortiMonitor UI: starting';
        break;
      case 'frontend:event': {
        const inner = payload;
        if (inner.type === 'frontend-user-start') {
          nowFetching.textContent = `→ FortiMonitor UI: user ${inner.index} of ${inner.total}`;
          requests += 1;
          requestEl.textContent = String(requests);
        } else if (inner.type === 'frontend-user-error') {
          appendError(`UI fetch user ${inner.id ?? '?'}: ${inner.error ?? 'unknown error'}`);
        } else if (inner.type === 'frontend-template-start') {
          nowFetching.textContent = `→ FortiMonitor UI: template ${inner.index} of ${inner.total}`;
          requests += 1;
          requestEl.textContent = String(requests);
        } else if (inner.type === 'frontend-template-error') {
          appendError(`UI fetch template ${inner.id ?? '?'}: ${inner.error ?? 'unknown error'}`);
        }
        break;
      }
      case 'frontend:done':
        nowFetching.textContent = '✓ FortiMonitor UI users complete';
        break;
      case 'frontend:error':
        nowFetching.textContent = '✗ FortiMonitor UI users fetch failed';
        appendError(`UI fetch: ${payload.error ?? 'unknown error'}`);
        break;
      case 'frontend-templates:start':
        phaseLabel.textContent = `Phase 4: FortiMonitor UI template configs (${payload.total ?? '?'} templates)`;
        nowFetching.textContent = '→ FortiMonitor UI: starting template configs';
        break;
      case 'frontend-templates:done':
        nowFetching.textContent = '✓ FortiMonitor UI template configs complete';
        break;
      case 'frontend-templates:error':
        nowFetching.textContent = '✗ FortiMonitor UI template configs fetch failed';
        appendError(`UI fetch templates: ${payload.error ?? 'unknown error'}`);
        break;
      case 'analyze:start':
        phaseLabel.textContent = 'Running analyzers…';
        nowFetching.textContent = '→ analyzers';
        stateLabel.textContent = 'Running analyzers…';
        break;
      case 'analyze:done':
        phaseLabel.textContent = 'Analysis complete.';
        nowFetching.textContent = '✓ analysis complete';
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
    stateLabel.textContent = 'Cancelling…';
    try { await call('observations:abort', {}); } catch { /* run promise will reject */ }
  });

  // Watchdog: if analyze:done has fired but the run hasn't reached a
  // terminal state within this window, surface a stalled-state warning
  // instead of an indefinite spinner. (FMN-133 first-tenant QA hit a stall
  // caused by a sendMessage transport issue; the result is now staged in
  // chrome.storage.local and read directly, but if anything else stalls we
  // want a visible affordance rather than a forever-running spinner.)
  let stallTimer = null;
  const STALL_TIMEOUT_MS = 8000;
  const innerUnsub = events.on((event, payload) => {
    if (event === 'observations:progress' && payload?.phase === 'analyze:done') {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (cancelled) return;
        // Only surface if the call is still pending (no resolution).
        if (!stateLabel.dataset.resolved) {
          stateLabel.textContent = 'Stalled returning result; service worker may have stopped.';
          stateLabel.className = 'execute-state error';
          cancelBtn.textContent = 'Back to start';
          cancelBtn.disabled = false;
          cancelBtn.classList.remove('btn-secondary');
          cancelBtn.classList.add('btn-primary');
          cancelBtn.onclick = () => navigate('/start');
        }
      }, STALL_TIMEOUT_MS);
    }
  });

  function markResolved() {
    stateLabel.dataset.resolved = '1';
    clearTimeout(stallTimer);
    innerUnsub();
  }

  // FMN-256: poll the detached run's status until it reaches a terminal
  // state. Resolves on 'done'; throws on 'error' / 'cancelled' / 'lost' /
  // 'none' so the existing catch renders the right UI. Polling also keeps
  // the service worker warm, but the SW-side keep-alive is the real guard
  // for when this tab is backgrounded and its timers are throttled.
  const POLL_INTERVAL_MS = 1500;
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async function pollUntilTerminal() {
    for (;;) {
      if (disposed) {
        const e = new Error('disposed'); e.name = 'AbortError'; throw e;
      }
      const s = await call('observations:get-run-status', {});
      const status = s?.status;
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

  // FMN-256: read the staged result blob straight out of chrome.storage.local
  // and clear both staging keys. No sendMessage round-trip for the
  // multi-MB payload. Falls back to the SW accessor only if chrome.storage
  // is somehow unavailable (it isn't, on an extension page).
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
    // Fallback: ask the service worker (returns the payload over the
    // channel). Only reached if chrome.storage.local is unavailable.
    return call('observations:get-run-result', {});
  }

  (async () => {
    try {
      // FMN-256: the run is DETACHED in the service worker now. run-audit
      // returns immediately with a small handle; we poll get-run-status
      // for terminal state rather than holding one sendMessage channel
      // open for the whole (multi-minute) crawl - the long-held channel is
      // what MV3 killed the worker under, producing "the message channel
      // closed before a response was received". Progress events above
      // still drive the live UI; this loop just watches for the end.
      const handle = await call('observations:run-audit', {
        deep: Boolean(store.deep),
        maxServers: store.maxServers ?? 0,
        // FMN-135 follow-up: always-on - the Tenant Observations' user-activity value
        // depends on this data and the operator is by definition logged
        // into FortiMonitor when running the wizard.
        includeFrontend: true,
        // FMN-146: section selection from the Configure step. Default
        // ["all"] preserves today's full-report behavior; non-all values
        // are captured by the SW but ignored for routing in this ticket
        // (FMN-149 is the umbrella that wires the scoping logic).
        sections: Array.isArray(store.sections) && store.sections.length > 0
          ? store.sections
          : ['all']
      });

      await pollUntilTerminal();

      // The run handler staged the multi-megabyte result in
      // chrome.storage.local (under handle.resultKey). Read it DIRECTLY
      // from storage rather than over sendMessage - the payload is too
      // large to ship reliably across the message channel ([[mv3_sendmessage_multimb_stall]]),
      // and this is an extension page with first-class chrome.storage access.
      const result = await readStagedResult(handle?.resultKey);
      markResolved();
      store.runResult = result;
      stateLabel.textContent = `Done in ${formatElapsed(Date.now() - startTime)}.`;
      stateLabel.className = 'execute-state';
      setTimeout(() => navigate('/analyze'), 250);
    } catch (err) {
      markResolved();
      const isAbort = err?.name === 'AbortError' || /cancelled/i.test(err?.message ?? '');
      if (isAbort || cancelled) {
        store.runCancelled = true;
        stateLabel.textContent = 'Cancelled.';
        stateLabel.className = 'execute-state muted';
        cancelBtn.textContent = 'Back to start';
        cancelBtn.disabled = false;
        cancelBtn.classList.remove('btn-secondary');
        cancelBtn.classList.add('btn-primary');
        cancelBtn.onclick = () => navigate('/start');
      } else {
        store.runError = err?.message ?? String(err);
        stateLabel.textContent = `Error: ${store.runError}`;
        stateLabel.className = 'execute-state error';
        cancelBtn.textContent = 'Back to start';
        cancelBtn.disabled = false;
        cancelBtn.classList.remove('btn-secondary');
        cancelBtn.classList.add('btn-primary');
        cancelBtn.onclick = () => navigate('/start');
      }
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
