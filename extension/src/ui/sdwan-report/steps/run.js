// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SD-WAN Report - Step 2 (Run / Collect) - FMN-129.
//
// Drives the long-running crawl. The service worker emits 'sdwan:progress'
// events as it walks; we display two running counters (servers crawled
// of total, metrics matched) plus the current server name. Cancel sends
// 'sdwan:abort' which aborts the in-flight controller.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { reportBreadcrumbs } from './start.js';

const TOOL_NAME = 'SD-WAN Report';

export function render({ container, store, navigate, events }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Collecting…', { toolName: TOOL_NAME, runningDot: true }));

  frame.appendChild(h('div', { class: 'step-header' },
    reportBreadcrumbs('run'),
    h('h2', {}, 'Crawling SNMP / agent / network-service resources'),
    h('p', { class: 'muted' },
      'Typical runtime: 30 seconds to 5 minutes, depending on how many servers ',
      'your tenant has and the per-server resource counts. Cancel any time; ',
      'partial progress is discarded (the final JSON only ships when the run ',
      'completes).'
    )
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // Counters
  const serversCounter = h('span', { class: 'counter-num', 'data-test': 'servers-counter' }, '0');
  const totalCounter = h('span', { class: 'counter-total' }, '?');
  const matchedCounter = h('span', { class: 'counter-num', 'data-test': 'matched-counter' }, '0');
  const currentLabel = h('div', { class: 'muted', style: 'margin-top:0.5rem;font-size:0.9rem;', 'data-test': 'current-label' }, 'Fetching server list…');
  const errorList = h('ul', { class: 'error-list', style: 'margin-top:0.6rem;font-size:0.85rem;color:#b04;' });

  body.appendChild(h('div', { class: 'counters', style: 'display:flex;gap:2rem;align-items:baseline;font-size:1.1rem;' },
    h('div', {},
      h('span', { style: 'font-weight:600;' }, 'Servers crawled: '),
      serversCounter, ' / ', totalCounter
    ),
    h('div', {},
      h('span', { style: 'font-weight:600;' }, 'Metrics matched: '),
      matchedCounter
    )
  ));
  body.appendChild(currentLabel);
  body.appendChild(errorList);

  // Action bar
  const stateLabel = h('span', { class: 'execute-state muted' }, 'Starting…');
  const cancelBtn = h('button', { class: 'btn btn-secondary' }, 'Cancel');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, stateLabel),
    h('div', { class: 'right' }, cancelBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  // Subscribe to progress events
  let totalServers = null;
  let processed = 0;
  let matched = 0;
  let cancelled = false;

  const unsubscribe = events.on((event, payload) => {
    if (event !== 'sdwan:progress' || !payload) return;
    switch (payload.phase) {
      case 'servers:fetch':
        currentLabel.textContent = 'Fetching server list…';
        break;
      case 'servers:fetched':
        totalServers = Number.isFinite(payload.totalServers) ? payload.totalServers : null;
        if (totalServers != null) totalCounter.textContent = String(totalServers);
        currentLabel.textContent = totalServers != null
          ? `Found ${totalServers} server${totalServers === 1 ? '' : 's'}. Walking resource lists…`
          : 'Walking resource lists…';
        break;
      case 'groups:unavailable':
        // Non-fatal label miss; surface but keep going.
        appendError(`Server groups unavailable: ${payload.error ?? 'unknown error'}. Group labels will be blank.`);
        break;
      case 'server:start':
        currentLabel.textContent = `Crawling ${payload.serverName || `#${payload.serverId || '?'}`}…`;
        break;
      case 'server:done':
        processed = Number.isFinite(payload.processed) ? payload.processed : (processed + 1);
        matched = Number.isFinite(payload.matched) ? payload.matched : matched;
        serversCounter.textContent = String(processed);
        matchedCounter.textContent = String(matched);
        if (totalServers != null) {
          stateLabel.textContent = `Crawled ${processed} of ${totalServers} servers - ${matched} SD-WAN metrics matched`;
        } else {
          stateLabel.textContent = `Crawled ${processed} servers - ${matched} SD-WAN metrics matched`;
        }
        break;
      case 'server:error':
        appendError(`Server ${payload.serverName || payload.serverId || '?'}: ${payload.error ?? 'unknown error'}`);
        break;
      case 'metric:matched':
        // Incrementing here would race with server:done's authoritative
        // count; we intentionally skip and let server:done update the
        // matched counter. Kept for harness instrumentation.
        break;
      default:
        break;
    }
  });

  function appendError(msg) {
    const li = h('li', {}, msg);
    errorList.appendChild(li);
  }

  // Cancel button
  cancelBtn.addEventListener('click', async () => {
    if (cancelled) return;
    cancelled = true;
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelling…';
    stateLabel.textContent = 'Cancelling…';
    try {
      await call('sdwan:abort', {});
    } catch (err) {
      // The run promise will reject with AbortError; surface it there.
    }
  });

  // Kick off the run
  (async () => {
    try {
      const result = await call('sdwan:run-report', {
        patterns: store.patterns ?? null
      });
      store.runResult = result;
      stateLabel.textContent = `Done - ${result.total_records} record${result.total_records === 1 ? '' : 's'} matched`;
      stateLabel.className = 'execute-state';
      setTimeout(() => navigate('/results'), 400);
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
