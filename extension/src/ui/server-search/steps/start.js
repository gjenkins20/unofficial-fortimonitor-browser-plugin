// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Search Servers - Step 1 (Start).
// Operator picks an attribute (e.g., "Model") from the tenant's
// /server_attribute_type catalog, enters a value (e.g., "FGT60F"), and
// fires the search. Pages through /server with live progress, then
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
    h('h2', {}, 'Filter servers by attribute'),
    h('p', {}, 'Example: find every device with Model = FGT60F. Pick the attribute name from your tenant\'s catalog, then enter the value you want to match.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ---- Attribute name (free-text with datalist suggestions) ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Attribute'));

  const datalistId = 'server-search-attr-suggestions';
  const attrInput = h('input', {
    type: 'text',
    class: 'paste-area',
    placeholder: 'Loading suggestions…',
    list: datalistId,
    autocomplete: 'off',
    spellcheck: 'false',
    style: 'min-height:0;height:auto;padding:0.6rem 0.8rem;font-family:inherit;'
  });
  attrInput.value = store.attributeName ?? '';
  attrInput.disabled = true;
  body.appendChild(attrInput);

  const attrDatalist = h('datalist', { id: datalistId });
  body.appendChild(attrDatalist);

  const attrHint = h('div', { class: 'muted', style: 'font-size:0.85rem;margin-top:0.25rem;' },
    'Type or pick an attribute name (e.g., Model). Suggestions come from your tenant\'s attribute catalog plus attributes seen on a sample of servers.'
  );
  body.appendChild(attrHint);

  // ---- Value ----
  body.appendChild(h('h3', { class: 'subhead', style: 'margin-top:1rem;' }, 'Value'));

  const valueInput = h('input', {
    type: 'text',
    class: 'paste-area',
    placeholder: 'FGT60F',
    style: 'min-height:0;height:auto;padding:0.6rem 0.8rem;font-family:inherit;'
  });
  valueInput.value = store.value ?? '';
  body.appendChild(valueInput);

  // ---- Match options ----
  const exactToggle = h('input', { type: 'checkbox' });
  exactToggle.checked = store.exactMatch !== false;
  const exactRow = h('label', { class: 'toggle-row', style: 'display:flex;gap:0.5rem;align-items:center;margin:0.75rem 0 0.25rem;' },
    exactToggle,
    h('span', {}, 'Exact match (off = substring / contains)')
  );
  body.appendChild(exactRow);

  const caseToggle = h('input', { type: 'checkbox' });
  caseToggle.checked = store.caseInsensitive !== false;
  const caseRow = h('label', { class: 'toggle-row', style: 'display:flex;gap:0.5rem;align-items:center;margin:0 0 0.75rem;' },
    caseToggle,
    h('span', {}, 'Case-insensitive')
  );
  body.appendChild(caseRow);

  body.appendChild(h('div', { class: 'format-hint', html:
    '<strong>How this works:</strong> the tool pages your full <code>/server</code> list and keeps only servers whose <code>attributes[]</code> array contains an entry whose <code>name</code> (or <code>textkey</code>) equals the selected attribute <em>and</em> whose <code>value</code> matches what you enter. Other fields (name, FQDN, tags) are ignored.'
  }));

  // Live progress label
  const progressBox = h('div', { class: 'progress-list', hidden: true });
  body.appendChild(progressBox);

  const runBtn = h('button', { class: 'btn btn-primary', disabled: true }, 'Run search');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, h('span', { class: 'execute-state muted' }, '')),
    h('div', { class: 'right' }, runBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  const stateLabel = actionBar.querySelector('.execute-state');

  function refreshRunDisabled() {
    runBtn.disabled = !attrInput.value.trim() || !valueInput.value.trim() || attrInput.disabled;
  }

  attrInput.addEventListener('input', refreshRunDisabled);
  valueInput.addEventListener('input', refreshRunDisabled);

  // Subscribe to per-page progress events from the service worker.
  const unsubscribe = events.on((event, payload) => {
    if (event !== 'search:page') return;
    const { fetched, total, matches } = payload ?? {};
    stateLabel.textContent = `Scanned ${fetched}${total ? ` of ${total}` : ''} - ${matches} match${matches === 1 ? '' : 'es'}`;
    stateLabel.className = 'execute-state';
  });

  // Populate the datalist suggestions. The handler unions the
  // /server_attribute_type catalog with attributes seen on a sample of
  // servers - necessary because built-in types (Model, Operating System)
  // are absent from the catalog but appear on server records.
  (async () => {
    try {
      const types = await call('search:list-attribute-types', {});
      attrDatalist.innerHTML = '';
      for (const t of types) {
        const label = t.textkey && t.textkey !== t.name ? `${t.name} - ${t.textkey}` : t.name;
        attrDatalist.appendChild(h('option', { value: t.name }, label));
      }
      attrInput.disabled = false;
      attrInput.placeholder = 'Model';
      refreshRunDisabled();
    } catch (err) {
      attrInput.disabled = false;
      attrInput.placeholder = 'Attribute name (suggestions unavailable)';
      stateLabel.textContent = `Could not load attribute suggestions: ${err?.message ?? err}`;
      stateLabel.className = 'execute-state error';
      refreshRunDisabled();
    }
  })();

  runBtn.addEventListener('click', async () => {
    const attributeName = attrInput.value.trim();
    const value = valueInput.value.trim();
    if (!attributeName || !value) return;
    store.attributeName = attributeName;
    store.value = value;
    store.exactMatch = exactToggle.checked;
    store.caseInsensitive = caseToggle.checked;

    runBtn.disabled = true;
    attrInput.disabled = true;
    valueInput.disabled = true;
    exactToggle.disabled = true;
    caseToggle.disabled = true;
    progressBox.hidden = false;
    progressBox.innerHTML = '';
    progressBox.appendChild(h('div', { class: 'progress-row' },
      h('span', { class: 'serial' }, `Searching for ${attributeName} ${exactToggle.checked ? '=' : '~'} "${value}"…`)
    ));
    stateLabel.textContent = 'Starting…';
    stateLabel.className = 'execute-state';

    try {
      const result = await call('search:servers', {
        attributeName,
        value,
        exactMatch: exactToggle.checked,
        caseInsensitive: caseToggle.checked
      });
      store.runResult = result;
      stateLabel.textContent = `Done - ${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} of ${result.totalScanned} scanned`;
      setTimeout(() => navigate('/results'), 400);
    } catch (err) {
      stateLabel.textContent = `Error: ${err?.message ?? err}`;
      stateLabel.className = 'execute-state error';
      runBtn.disabled = false;
      attrInput.disabled = false;
      valueInput.disabled = false;
      exactToggle.disabled = false;
      caseToggle.disabled = false;
    }
  });

  return () => unsubscribe();
}
