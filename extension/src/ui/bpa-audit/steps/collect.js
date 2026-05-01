// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// BPA Audit - Step 2 (Collect) - FMN-133.
//
// Drives the long-running crawl through bpa:run-audit. The handler emits
// 'bpa:progress' events that we wire through to a per-endpoint progress
// list + a running request count. Cancel sends 'bpa:abort'.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { reportBreadcrumbs } from './start.js';

const TOOL_NAME = 'BPA Audit';

export function render({ container, store, navigate, events }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Collecting…', { toolName: TOOL_NAME, runningDot: true }));

  frame.appendChild(h('div', { class: 'step-header' },
    reportBreadcrumbs('collect'),
    h('h2', {}, 'Walking the v2 API'),
    h('p', { class: 'muted' },
      'Typical runtime: 30 seconds (no deep dive) to 10+ minutes (deep dive on a ',
      'tenant with hundreds of servers). Cancel any time; a partial inventory is ',
      'discarded.'
    )
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const requestCounter = h('span', { class: 'counter-num', 'data-test': 'request-counter' }, '0');
  const phaseLabel = h('div', { class: 'muted', style: 'margin-top:0.5rem;font-size:0.9rem;', 'data-test': 'phase-label' }, 'Starting…');
  const errorList = h('ul', { class: 'error-list', style: 'margin-top:0.6rem;font-size:0.85rem;color:#b04;' });
  const endpointList = h('ul', {
    'data-test': 'endpoint-list',
    style: 'margin-top:0.8rem;font-family:monospace;font-size:0.85rem;max-height:14rem;overflow:auto;border:1px solid #ddd;padding:0.4rem 0.7rem;border-radius:4px;background:#fafafa;'
  });

  body.appendChild(h('div', { style: 'display:flex;gap:2rem;align-items:baseline;font-size:1.1rem;' },
    h('div', {},
      h('span', { style: 'font-weight:600;' }, 'API requests: '),
      requestCounter
    )
  ));
  body.appendChild(phaseLabel);
  body.appendChild(endpointList);
  body.appendChild(errorList);

  const stateLabel = h('span', { class: 'execute-state muted' }, 'Starting…');
  const cancelBtn = h('button', { class: 'btn btn-secondary' }, 'Cancel');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, stateLabel),
    h('div', { class: 'right' }, cancelBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  let requests = 0;
  let cancelled = false;
  const endpointItems = new Map();   // endpointName -> <li>

  function appendError(msg) {
    errorList.appendChild(h('li', {}, msg));
  }

  function endpointItem(name) {
    let li = endpointItems.get(name);
    if (!li) {
      li = h('li', { 'data-endpoint': name }, `${name}: …`);
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
          ? 'Walking top-level endpoints (deep dive enabled)…'
          : 'Walking top-level endpoints…';
        break;
      case 'collect:event': {
        // Inner BpaFetcher event. type is one of:
        //   collect-start | endpoint-start | endpoint-done | endpoint-error
        //   | deep-server | collect-done
        const inner = payload;
        switch (inner.type) {
          case 'endpoint-start':
            endpointItem(inner.name).textContent = `${inner.name}: fetching…`;
            requests += 1;
            requestCounter.textContent = String(requests);
            break;
          case 'endpoint-done':
            endpointItem(inner.name).textContent = `${inner.name}: ${inner.count ?? 0}`;
            break;
          case 'endpoint-error':
            endpointItem(inner.name).textContent = `${inner.name}: error`;
            appendError(`${inner.name}: ${inner.error ?? 'unknown error'}`);
            break;
          case 'deep-server':
            phaseLabel.textContent = `Deep dive: server ${inner.index} of ${inner.total}`;
            break;
          case 'collect-done':
            phaseLabel.textContent = `Inventory complete (${inner.requests ?? requests} requests).`;
            break;
          default:
            break;
        }
        break;
      }
      case 'analyze:start':
        phaseLabel.textContent = 'Running analyzers…';
        stateLabel.textContent = 'Running analyzers…';
        break;
      case 'analyze:done':
        phaseLabel.textContent = 'Analysis complete.';
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

  (async () => {
    try {
      const result = await call('bpa:run-audit', {
        deep: Boolean(store.deep),
        maxServers: store.maxServers ?? 0
      });
      store.runResult = result;
      stateLabel.textContent = 'Done.';
      stateLabel.className = 'execute-state';
      setTimeout(() => navigate('/analyze'), 250);
    } catch (err) {
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

  return () => unsubscribe();
}
