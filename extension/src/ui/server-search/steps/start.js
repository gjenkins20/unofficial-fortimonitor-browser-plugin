// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Search Servers — Step 1 (Start).
// Operator enters a search term (e.g., "FGVMA6"). "Run search" pages
// through /server with live progress ("scanned N of M, K matches"), then
// transitions to /results.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';

const TOOL_NAME = 'Search Servers';

export function searchBreadcrumbs(active) {
  const steps = [
    { id: 'start', label: '1. Search' },
    { id: 'results', label: '2. Results' }
  ];
  const order = steps.findIndex((s) => s.id === active);
  return h('div', { class: 'step-breadcrumbs' },
    steps.flatMap((s, i) => {
      const cls = i < order ? 'step done' : i === order ? 'step active' : 'step';
      const label = i < order ? `${s.label} ✓` : s.label;
      const item = h('span', { class: cls }, label);
      return i === 0 ? [item] : [h('span', { class: 'arrow' }, '›'), item];
    })
  );
}

export function render({ container, store, navigate, events }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Search', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    searchBreadcrumbs('start'),
    h('h2', {}, 'Free-text search across all servers'),
    h('p', {}, 'Enter a term (e.g., "FGVMA6" or a FQDN fragment). Matches against server name, FQDN, additional FQDNs, device type, sub-type, tags, and every attribute value. Produces a report of server IDs, names, and FQDNs.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  body.appendChild(h('h3', { class: 'subhead' }, 'Search term'));

  const termInput = h('input', {
    type: 'text',
    class: 'paste-area',
    placeholder: 'FGVMA6',
    style: 'min-height:0;height:auto;padding:0.6rem 0.8rem;font-family:inherit;'
  });
  termInput.value = store.term ?? '';
  body.appendChild(termInput);

  const caseToggle = h('input', { type: 'checkbox' });
  caseToggle.checked = store.caseInsensitive !== false;
  const caseRow = h('label', { class: 'toggle-row', style: 'display:flex;gap:0.5rem;align-items:center;margin:0.75rem 0;' },
    caseToggle,
    h('span', {}, 'Case-insensitive match')
  );
  body.appendChild(caseRow);

  body.appendChild(h('div', { class: 'format-hint', html:
    '<strong>Where we look:</strong> <code>name</code>, <code>fqdn</code>, <code>additional_fqdns</code>, <code>device_type</code>, <code>device_sub_type</code>, <code>tags</code>, and every <code>attribute.value</code>. First matching field wins (reported so you can see <em>why</em> a server hit).'
  }));

  // Live progress
  const progressBox = h('div', { class: 'progress-list', hidden: true });
  body.appendChild(progressBox);

  const runBtn = h('button', { class: 'btn btn-primary', disabled: !termInput.value.trim() }, 'Run search');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, h('span', { class: 'execute-state muted' }, '')),
    h('div', { class: 'right' }, runBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  const stateLabel = actionBar.querySelector('.execute-state');

  termInput.addEventListener('input', () => {
    runBtn.disabled = !termInput.value.trim();
  });

  // Subscribe to per-page progress events from the service worker.
  const unsubscribe = events.on((event, payload) => {
    if (event !== 'search:page') return;
    const { fetched, total, matches } = payload ?? {};
    stateLabel.textContent = `Scanned ${fetched}${total ? ` of ${total}` : ''} — ${matches} match${matches === 1 ? '' : 'es'}`;
    stateLabel.className = 'execute-state';
  });

  runBtn.addEventListener('click', async () => {
    const term = termInput.value.trim();
    if (!term) return;
    store.term = term;
    store.caseInsensitive = caseToggle.checked;

    runBtn.disabled = true;
    termInput.disabled = true;
    caseToggle.disabled = true;
    progressBox.hidden = false;
    progressBox.innerHTML = '';
    progressBox.appendChild(h('div', { class: 'progress-row' },
      h('span', { class: 'serial' }, `Searching for "${term}"…`)
    ));
    stateLabel.textContent = 'Starting…';
    stateLabel.className = 'execute-state';

    try {
      const result = await call('search:servers', {
        term,
        caseInsensitive: caseToggle.checked
      });
      store.runResult = result;
      stateLabel.textContent = `Done — ${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} of ${result.totalScanned} scanned`;
      setTimeout(() => navigate('/results'), 400);
    } catch (err) {
      stateLabel.textContent = `Error: ${err?.message ?? err}`;
      stateLabel.className = 'execute-state error';
      runBtn.disabled = false;
      termInput.disabled = false;
      caseToggle.disabled = false;
    }
  });

  return () => unsubscribe();
}
