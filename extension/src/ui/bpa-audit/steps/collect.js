// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Best-Practice Assessment - Step 2 (Collect) - FMN-133.
//
// Drives the long-running assessment through bpa:run-audit. The handler
// emits 'bpa:progress' events that we wire through to:
//   - an elapsed-time clock that ticks every second
//   - a per-endpoint progress counter
//   - a "currently fetching" sticky line that names the active endpoint
//   - a scrollable history of completed endpoints with their row counts
//
// Cancel sends 'bpa:abort'.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { reportBreadcrumbs } from './start.js';

const TOOL_NAME = 'Best-Practice Assessment';

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

  // Counters row: elapsed time + endpoints assessed + API requests
  const elapsedEl  = h('span', { class: 'counter-num', 'data-test': 'elapsed-counter' }, '0:00');
  const endpointsEl = h('span', { class: 'counter-num', 'data-test': 'endpoints-counter' }, '0');
  const requestEl   = h('span', { class: 'counter-num', 'data-test': 'request-counter' }, '0');
  body.appendChild(h('div', {
    style: 'display:flex;gap:2rem;flex-wrap:wrap;align-items:baseline;font-size:1.05rem;margin-bottom:0.4rem;'
  },
    h('div', {}, h('span', { style: 'font-weight:600;' }, 'Elapsed: '), elapsedEl),
    h('div', {}, h('span', { style: 'font-weight:600;' }, 'Endpoints assessed: '), endpointsEl),
    h('div', {}, h('span', { style: 'font-weight:600;' }, 'API requests: '), requestEl)
  ));

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
  const cancelBtn = h('button', { class: 'btn btn-secondary' }, 'Cancel');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, stateLabel),
    h('div', { class: 'right' }, cancelBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  // ----- runtime state ------------------------------------------------------
  let requests = 0;
  let endpointsDone = 0;
  let cancelled = false;
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
    if (event !== 'bpa:progress' || !payload) return;
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
    try { await call('bpa:abort', {}); } catch { /* run promise will reject */ }
  });

  // Watchdog: if analyze:done has fired but the run-audit response hasn't
  // come back within this window, surface a stalled-state warning instead
  // of an indefinite spinner. (FMN-133 first-tenant QA hit a stall caused
  // by a sendMessage transport issue; the result is now staged in
  // chrome.storage.session, but if anything else stalls we want a visible
  // affordance rather than a forever-running spinner.)
  let stallTimer = null;
  const STALL_TIMEOUT_MS = 8000;
  const innerUnsub = events.on((event, payload) => {
    if (event === 'bpa:progress' && payload?.phase === 'analyze:done') {
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

  (async () => {
    try {
      const handle = await call('bpa:run-audit', {
        deep: Boolean(store.deep),
        maxServers: store.maxServers ?? 0
      });
      // The run handler stages the multi-megabyte result in chrome.storage.session
      // and returns a small handle. Pull the full payload back via a separate
      // call so this one's response stays small.
      const result = await call('bpa:get-run-result', { runKey: handle?.runKey });
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
    unsubscribe();
    innerUnsub();
    clearTimeout(stallTimer);
    clearInterval(elapsedTimer);
  };
}
