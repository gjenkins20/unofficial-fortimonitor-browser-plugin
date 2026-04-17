// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Manage Server Attributes — Step 1 (Start).
// Pick operation (set/remove), attribute type, value (if set), and paste
// a list of servers to apply to.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';

const TOOL_NAME = 'Manage Server Attributes (Bulk)';

export function attrBreadcrumbs(active) {
  const steps = [
    { id: 'start', label: '1. Choose' },
    { id: 'preview', label: '2. Preview' },
    { id: 'execute', label: '3. Execute' },
    { id: 'results', label: '4. Results' }
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

function parseEntries(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Choose operation and targets', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    attrBreadcrumbs('start'),
    h('h2', {}, 'Set or remove an attribute across many servers'),
    h('p', {}, 'Pick an attribute type, optionally a value, and paste the list of servers to apply to. The preview step shows exactly what will change before anything is written.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ---- Operation ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Operation'));
  const opSet = h('input', { type: 'radio', name: 'attr-op', value: 'set', checked: store.operation === 'set' });
  const opRemove = h('input', { type: 'radio', name: 'attr-op', value: 'remove', checked: store.operation === 'remove' });
  body.appendChild(h('div', { class: 'radio-row' },
    h('label', {}, opSet, h('span', {}, 'Set (add or replace value)')),
    h('label', {}, opRemove, h('span', {}, 'Remove (drop the attribute)'))
  ));

  // ---- Type + Value ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Attribute'));
  const typeSelect = h('select', { class: 'select' }, h('option', { value: '' }, 'Loading types…'));
  const valueInput = h('input', { type: 'text', class: 'select', placeholder: 'Value', value: store.value ?? '' });

  const attrGrid = h('div', { class: 'targets-grid' },
    h('label', {}, h('span', { class: 'label-text' }, 'Type'), typeSelect),
    h('label', {}, h('span', { class: 'label-text' }, 'Value'), valueInput)
  );
  body.appendChild(attrGrid);

  function refreshValueVisibility() {
    valueInput.disabled = opRemove.checked;
    valueInput.parentElement.style.opacity = opRemove.checked ? '0.4' : '1';
    if (opRemove.checked) valueInput.placeholder = '(not used for Remove)';
    else valueInput.placeholder = 'Value';
  }
  opSet.addEventListener('change', refreshValueVisibility);
  opRemove.addEventListener('change', refreshValueVisibility);
  refreshValueVisibility();

  // ---- Targets ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Target servers'));
  body.appendChild(h('p', { class: 'format-hint' },
    'One per line. Each line is either a server name (resolved via the v2 API) or a numeric server id.'
  ));
  const textarea = h('textarea', {
    class: 'paste-area',
    placeholder: 'FGVM01TM24006844\nFGVM01TM24006845\n42024075'
  });
  textarea.value = store.entries.join('\n');
  body.appendChild(textarea);

  const statusRow = h('div', { class: 'parse-result empty' });
  body.appendChild(statusRow);

  // ---- Action bar ----
  const continueBtn = h('button', { class: 'btn btn-primary', disabled: true }, 'Continue → Preview');
  const clearBtn = h('button', { class: 'btn btn-secondary' }, 'Clear');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, h('span', { class: 'muted' }, 'Nothing is written until you execute.')),
    h('div', { class: 'right' }, clearBtn, continueBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  // ---- Populate attribute types (async) ----
  (async () => {
    try {
      const types = store.attributeTypes?.length
        ? store.attributeTypes
        : await call('attr:list-types', {});
      store.attributeTypes = types;
      while (typeSelect.firstChild) typeSelect.removeChild(typeSelect.firstChild);
      typeSelect.appendChild(h('option', { value: '' }, `— Choose type (${types.length}) —`));
      for (const t of types) {
        const label = t.textkey && t.textkey !== t.name ? `${t.name}  (${t.textkey})` : t.name;
        typeSelect.appendChild(h('option', { value: t.resourceUrl }, label));
      }
      if (store.typeUrl) typeSelect.value = store.typeUrl;
      updateContinue();
    } catch (err) {
      while (typeSelect.firstChild) typeSelect.removeChild(typeSelect.firstChild);
      typeSelect.appendChild(h('option', { value: '' }, `Error: ${err?.message ?? err}`));
      statusRow.className = 'parse-result error';
      statusRow.textContent = err?.message
        ? `Could not load attribute types: ${err.message}. Check your API key in Settings (⚙).`
        : 'Could not load attribute types.';
    }
  })();

  // ---- Wiring ----
  function updateContinue() {
    const hasType = !!typeSelect.value;
    const hasValue = opRemove.checked || valueInput.value.trim().length > 0;
    const entries = parseEntries(textarea.value);
    const hasTargets = entries.length > 0;
    continueBtn.disabled = !(hasType && hasValue && hasTargets);

    if (entries.length > 0) {
      statusRow.className = 'parse-result ok';
      statusRow.textContent = `${entries.length} target${entries.length === 1 ? '' : 's'} queued — preview will resolve names and show the plan.`;
    } else if (!textarea.value.trim()) {
      statusRow.className = 'parse-result empty';
      statusRow.textContent = '';
    }
  }

  typeSelect.addEventListener('change', updateContinue);
  valueInput.addEventListener('input', updateContinue);
  textarea.addEventListener('input', updateContinue);
  opSet.addEventListener('change', updateContinue);
  opRemove.addEventListener('change', updateContinue);

  clearBtn.addEventListener('click', () => {
    textarea.value = '';
    valueInput.value = '';
    typeSelect.value = '';
    updateContinue();
  });

  continueBtn.addEventListener('click', () => {
    store.operation = opRemove.checked ? 'remove' : 'set';
    store.typeUrl = typeSelect.value;
    const selectedOpt = typeSelect.options[typeSelect.selectedIndex];
    store.typeName = selectedOpt ? selectedOpt.textContent : null;
    store.value = valueInput.value.trim();
    store.entries = parseEntries(textarea.value);
    store.plan = null;
    store.runResult = null;
    navigate('/preview');
  });

  updateContinue();
}
