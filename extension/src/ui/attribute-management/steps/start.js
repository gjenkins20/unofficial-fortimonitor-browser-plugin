// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Manage Server Attributes - Step 1 (Start).
// Pick one or more attribute operations (set/remove + type + value),
// then paste a list of servers to apply them to. The cross-product of
// (server × attribute) becomes the plan.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { createCombobox } from '../../../lib/combobox.js';

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

function defaultAttribute() {
  return { operation: 'set', typeUrl: '', typeName: '', value: '' };
}

function migrateStoreAttributes(store) {
  if (Array.isArray(store.attributes) && store.attributes.length > 0) return;
  // Migrate single-attribute legacy shape if present.
  if (store.typeUrl) {
    store.attributes = [{
      operation: store.operation || 'set',
      typeUrl: store.typeUrl,
      typeName: store.typeName || '',
      value: store.value ?? ''
    }];
  } else {
    store.attributes = [defaultAttribute()];
  }
}

export function render({ container, store, navigate }) {
  migrateStoreAttributes(store);

  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Choose operations and targets', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    attrBreadcrumbs('start'),
    h('h2', {}, 'Set or remove one or more attributes across many servers'),
    h('p', {}, 'Pick attribute operations (each one is its own row), then paste the list of servers to apply them to. The preview step shows the per-server plan before anything is written.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ---- Attributes ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Attributes'));
  const attrsHost = h('div', { class: 'attribute-rows' });
  body.appendChild(attrsHost);

  const addAttrBtn = h('button', {
    type: 'button',
    class: 'btn btn-secondary attribute-add-btn'
  }, '+ Add another attribute');
  body.appendChild(addAttrBtn);

  // Each combobox gets its own controller; we track them in `controllers`
  // parallel to store.attributes so renderRows() can reapply state.
  const controllers = [];

  function renderRows() {
    while (attrsHost.firstChild) attrsHost.removeChild(attrsHost.firstChild);
    controllers.length = 0;

    store.attributes.forEach((attr, idx) => {
      const opSetId = `attr-op-set-${idx}`;
      const opRemoveId = `attr-op-remove-${idx}`;

      const opSet = h('input', {
        type: 'radio',
        name: `attr-op-${idx}`,
        id: opSetId,
        value: 'set',
        checked: attr.operation === 'set'
      });
      const opRemove = h('input', {
        type: 'radio',
        name: `attr-op-${idx}`,
        id: opRemoveId,
        value: 'remove',
        checked: attr.operation === 'remove'
      });

      const typeCombo = createCombobox({
        items: (store.attributeTypes ?? []).map((t) => ({
          value: t.resourceUrl,
          label: t.name,
          hint: t.textkey && t.textkey !== t.name ? t.textkey : null
        })),
        initialValue: attr.typeUrl || null,
        placeholder: store.attributeTypes
          ? `Search ${store.attributeTypes.length} types`
          : 'Loading types…',
        onChange: (value, item) => {
          attr.typeUrl = value || '';
          attr.typeName = item?.label ?? '';
          updateContinue();
        }
      });
      if (!store.attributeTypes) typeCombo.setDisabled(true);

      const valueInput = h('input', {
        type: 'text',
        class: 'select',
        placeholder: attr.operation === 'remove' ? '(not used for Remove)' : 'Value',
        value: attr.value ?? ''
      });
      valueInput.disabled = attr.operation === 'remove';
      valueInput.style.opacity = attr.operation === 'remove' ? '0.4' : '1';

      function refreshValueVisibility() {
        valueInput.disabled = opRemove.checked;
        valueInput.style.opacity = opRemove.checked ? '0.4' : '1';
        valueInput.placeholder = opRemove.checked ? '(not used for Remove)' : 'Value';
      }

      opSet.addEventListener('change', () => {
        attr.operation = 'set';
        refreshValueVisibility();
        updateContinue();
      });
      opRemove.addEventListener('change', () => {
        attr.operation = 'remove';
        refreshValueVisibility();
        updateContinue();
      });
      valueInput.addEventListener('input', () => {
        attr.value = valueInput.value;
        updateContinue();
      });

      const removeBtn = h('button', {
        type: 'button',
        class: 'btn btn-icon attribute-remove-btn',
        title: 'Remove this attribute row'
      }, '×');
      if (store.attributes.length === 1) removeBtn.style.visibility = 'hidden';
      removeBtn.addEventListener('click', () => {
        if (store.attributes.length === 1) return;
        store.attributes.splice(idx, 1);
        renderRows();
        updateContinue();
      });

      const opRow = h('div', { class: 'attribute-row-ops' },
        h('label', {}, opSet, h('span', {}, 'Set')),
        h('label', {}, opRemove, h('span', {}, 'Remove'))
      );

      const fieldRow = h('div', { class: 'attribute-row-fields' },
        h('label', {}, h('span', { class: 'label-text' }, 'Type'), typeCombo.element),
        h('label', {}, h('span', { class: 'label-text' }, 'Value'), valueInput)
      );

      const rowEl = h('div', { class: 'attribute-row' },
        h('div', { class: 'attribute-row-header' }, opRow, removeBtn),
        fieldRow
      );

      attrsHost.appendChild(rowEl);
      controllers.push({ typeCombo, valueInput, opSet, opRemove });
    });
  }

  addAttrBtn.addEventListener('click', () => {
    store.attributes.push(defaultAttribute());
    renderRows();
    updateContinue();
  });

  // ---- Targets ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Target servers'));
  body.appendChild(h('p', { class: 'format-hint' },
    'One per line. Each line is either a server name (resolved via the v2 API) or a numeric server id.'
  ));
  const textarea = h('textarea', {
    class: 'paste-area',
    placeholder: 'FGVM01TM24006844\nFGVM01TM24006845\n42024075'
  });
  textarea.value = (store.entries ?? []).join('\n');
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

  // ---- Async populate types ----
  (async () => {
    try {
      const types = store.attributeTypes?.length
        ? store.attributeTypes
        : await call('attr:list-types', {});
      store.attributeTypes = types;
      const items = types.map((t) => ({
        value: t.resourceUrl,
        label: t.name,
        hint: t.textkey && t.textkey !== t.name ? t.textkey : null
      }));
      for (const c of controllers) {
        c.typeCombo.setItems(items);
        c.typeCombo.setDisabled(false);
        c.typeCombo.setPlaceholder(`Search ${types.length} types`);
      }
      updateContinue();
    } catch (err) {
      for (const c of controllers) {
        c.typeCombo.setDisabled(false);
        c.typeCombo.setPlaceholder(`Error: ${err?.message ?? err}`);
      }
      statusRow.className = 'parse-result error';
      statusRow.textContent = err?.message
        ? `Could not load attribute types: ${err.message}. Check your API key in Settings (⚙).`
        : 'Could not load attribute types.';
    }
  })();

  // ---- Wiring ----
  function attrIsComplete(a) {
    if (!a.typeUrl) return false;
    if (a.operation === 'set' && !String(a.value ?? '').trim()) return false;
    return true;
  }

  function updateContinue() {
    const allReady = store.attributes.length > 0 && store.attributes.every(attrIsComplete);
    const entries = parseEntries(textarea.value);
    const hasTargets = entries.length > 0;
    continueBtn.disabled = !(allReady && hasTargets);

    if (entries.length > 0) {
      const totalRows = entries.length * store.attributes.length;
      statusRow.className = 'parse-result ok';
      statusRow.textContent = `${entries.length} target${entries.length === 1 ? '' : 's'} × ${store.attributes.length} attribute${store.attributes.length === 1 ? '' : 's'} = ${totalRows} plan row${totalRows === 1 ? '' : 's'} - preview will resolve names and show what changes.`;
    } else if (!textarea.value.trim()) {
      statusRow.className = 'parse-result empty';
      statusRow.textContent = '';
    }
  }

  textarea.addEventListener('input', updateContinue);

  clearBtn.addEventListener('click', () => {
    textarea.value = '';
    store.attributes = [defaultAttribute()];
    renderRows();
    updateContinue();
  });

  continueBtn.addEventListener('click', () => {
    // Snapshot the values from controllers (combobox values are already in
    // store.attributes via onChange, but the value input might not have
    // had time to fire its 'input' event for the latest keystroke).
    store.attributes.forEach((attr, idx) => {
      const c = controllers[idx];
      if (!c) return;
      attr.typeUrl = c.typeCombo.getValue() || '';
      attr.typeName = c.typeCombo.getItem()?.label ?? '';
      attr.value = c.valueInput.value;
      attr.operation = c.opRemove.checked ? 'remove' : 'set';
    });
    store.entries = parseEntries(textarea.value);
    store.plan = null;
    store.runResult = null;
    navigate('/preview');
  });

  renderRows();
  updateContinue();
}
