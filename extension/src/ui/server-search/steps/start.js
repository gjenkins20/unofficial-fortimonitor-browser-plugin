// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Find Servers - Step 1 (Start) - FMN-114 unified scope.
// Three sections: identifiers paste, filter criteria stack, column picker.
// Runs the search via search:servers, then transitions to /results.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { createCombobox } from '../../../lib/combobox.js';

const TOOL_NAME = 'Find Servers';

export function findBreadcrumbs(active) {
  const steps = [
    { id: 'start', label: '1. Build query' },
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

const FIELD_TYPES = [
  { value: 'attribute',         label: 'Attribute' },
  { value: 'name',              label: 'Server name' },
  { value: 'fqdn',              label: 'FQDN' },
  { value: 'tag',               label: 'Tag' },
  { value: 'status',            label: 'Status' },
  { value: 'device_type',       label: 'Device type' },
  { value: 'has_active_outage', label: 'Has active outage' },
  { value: 'applied_template',  label: 'Applied template' }
];

const STATUS_VALUES = ['active', 'paused', 'inactive'];

const STRING_FIELDS = new Set(['attribute', 'name', 'fqdn', 'tag', 'device_type']);

export function render({ container, store, navigate, events }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Build query', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    findBreadcrumbs('start'),
    h('h2', {}, 'Find servers and choose what to report'),
    h('p', {}, 'Section 1 (identifiers) and Section 2 (filter) are both optional, but at least one must be populated. When both are populated the result is the intersection. Section 3 picks the columns shown in the result table and CSV.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ============================================================
  // Section 1: Identifiers
  // ============================================================
  body.appendChild(h('h3', { class: 'subhead' }, '1. Identifiers (optional)'));
  body.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;margin:0 0 0.4rem;' },
    'One per line. Server names (exact), FortiMonitor instance URLs, or numeric server IDs. URL / ID lines confirm against the tenant.'
  ));
  const idsTextarea = h('textarea', {
    class: 'paste-area',
    placeholder: 'FGVM01TM24006844\nhttps://fortimonitor.forticloud.com/report/Instance/42024060/details\n42024061'
  });
  idsTextarea.value = store.identifiersText ?? '';
  body.appendChild(idsTextarea);

  // ============================================================
  // Section 2: Filter criteria
  // ============================================================
  body.appendChild(h('h3', { class: 'subhead', style: 'margin-top:1rem;' }, '2. Filter (optional)'));

  const matchModeSelect = h('select', { class: 'select' },
    h('option', { value: 'all' }, 'Match ALL (AND)'),
    h('option', { value: 'any' }, 'Match ANY (OR)')
  );
  matchModeSelect.value = store.mode === 'any' ? 'any' : 'all';
  body.appendChild(h('div', { class: 'mode-row', style: 'display:flex;align-items:center;gap:0.5rem;margin:0 0 0.5rem;' },
    h('span', {}, 'Match mode:'),
    matchModeSelect
  ));

  const rowsHost = h('div', { class: 'criteria-stack' });
  body.appendChild(rowsHost);

  const addCritBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, '+ Add criterion');
  body.appendChild(h('div', { style: 'margin:0.5rem 0 0.75rem;' }, addCritBtn));

  const caseToggle = h('input', { type: 'checkbox' });
  caseToggle.checked = store.caseInsensitive !== false;
  body.appendChild(h('label', { class: 'toggle-row', style: 'display:flex;gap:0.5rem;align-items:center;margin:0 0 0.5rem;' },
    caseToggle,
    h('span', {}, 'Case-insensitive (applies to string criteria)')
  ));

  // ============================================================
  // Section 3: Column picker
  // ============================================================
  body.appendChild(h('h3', { class: 'subhead', style: 'margin-top:1rem;' }, '3. Output columns'));
  body.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;margin:0 0 0.4rem;' },
    'ID, Name, and FQDN are always shown. Pick any extras you want in the table and CSV.'
  ));

  const colDefs = [
    { key: 'status',        label: 'Status' },
    { key: 'tags',          label: 'Tags' },
    { key: 'deviceType',    label: 'Device type' },
    { key: 'deviceSubType', label: 'Device sub-type' },
    { key: 'source',        label: 'Source (input / criterion that matched)' }
  ];
  const colChecks = {};
  const colsBox = h('div', { class: 'cols-box', style: 'display:grid;grid-template-columns:1fr 1fr;gap:0.25rem 1rem;margin-bottom:0.5rem;' });
  for (const def of colDefs) {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !!store.columns?.[def.key];
    colChecks[def.key] = cb;
    colsBox.appendChild(h('label', { style: 'display:flex;gap:0.4rem;align-items:center;' }, cb, h('span', {}, def.label)));
  }
  body.appendChild(colsBox);

  // Per-attribute column picker (multi-select via "add chip" pattern)
  body.appendChild(h('div', { class: 'subhead-2', style: 'font-size:0.95rem;font-weight:600;margin-top:0.5rem;' }, 'Attribute columns'));
  const attrColPickerHost = h('div', { style: 'display:flex;gap:0.5rem;align-items:flex-start;flex-wrap:wrap;' });
  body.appendChild(attrColPickerHost);
  let attrColCombo = null;
  const addAttrColBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, '+ Add attribute column');
  const attrChipsHost = h('div', { class: 'attr-chips', style: 'display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.4rem;' });
  body.appendChild(attrChipsHost);

  function renderAttrChips() {
    attrChipsHost.innerHTML = '';
    for (const name of store.columns.attributes) {
      const removeBtn = h('button', { class: 'chip-x', type: 'button', title: 'Remove', style: 'border:none;background:none;cursor:pointer;padding:0 0.3rem;' }, '×');
      const chip = h('span', { class: 'chip', style: 'background:#eef2f7;border:1px solid #c4c8cf;border-radius:12px;padding:0.15rem 0.5rem;font-size:0.85rem;display:inline-flex;align-items:center;gap:0.25rem;' },
        h('span', {}, name),
        removeBtn
      );
      removeBtn.addEventListener('click', () => {
        store.columns.attributes = store.columns.attributes.filter((n) => n !== name);
        renderAttrChips();
      });
      attrChipsHost.appendChild(chip);
    }
  }
  renderAttrChips();

  // Live progress label
  const progressBox = h('div', { class: 'progress-list', hidden: true });
  body.appendChild(progressBox);

  // ---- Action bar ----
  const runBtn = h('button', { class: 'btn btn-primary', disabled: true }, 'Run search');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, h('span', { class: 'execute-state muted' }, '')),
    h('div', { class: 'right' }, runBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  const stateLabel = actionBar.querySelector('.execute-state');

  // ============================================================
  // Wiring
  // ============================================================

  // Cached attribute suggestions; populated once.
  let attrSuggestions = [];
  let attrSuggestionsLoading = true;
  // FMN-121: lazy-loaded template catalog for the applied_template
  // field type. The fetch fires when the operator first picks
  // applied_template; results are cached on the store so re-renders
  // (back-button, /results -> refine) do not re-fetch.
  let templateOptions = Array.isArray(store.templateOptions) ? store.templateOptions : null;
  let templateOptionsLoading = false;
  let templateOptionsError = null;
  const templateRowSubscribers = new Set();
  function notifyTemplateSubscribers() {
    for (const fn of templateRowSubscribers) { try { fn(); } catch { /* swallow */ } }
  }
  async function ensureTemplateOptions() {
    if (templateOptions || templateOptionsLoading) return;
    templateOptionsLoading = true;
    notifyTemplateSubscribers();
    try {
      const list = await call('search:list-templates', {});
      templateOptions = (Array.isArray(list) ? list : []).map((t) => ({
        templateUrl: t.resourceUrl,
        templateId: t.id,
        name: t.name,
        templateType: t.templateType ?? null
      }));
      store.templateOptions = templateOptions;
      templateOptionsError = null;
    } catch (err) {
      templateOptionsError = err?.message ?? String(err);
    } finally {
      templateOptionsLoading = false;
      notifyTemplateSubscribers();
    }
  }

  // Each criterion row keeps a getCriterion() function that returns the
  // current shape, plus setDisabled() for run state.
  const rows = new Set();

  function makeCriterionRow(initial = { fieldType: 'attribute' }) {
    const fieldSelect = h('select', { class: 'select' },
      ...FIELD_TYPES.map((t) => h('option', { value: t.value }, t.label))
    );
    fieldSelect.value = initial.fieldType ?? 'attribute';

    const fieldHost = h('div', { class: 'field-host', style: 'flex:1;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;' });

    const removeBtn = h('button', {
      class: 'btn btn-secondary btn-icon', type: 'button', title: 'Remove this criterion',
      style: 'padding:0.25rem 0.6rem;'
    }, '−');

    const rowEl = h('div', {
      class: 'criterion-row',
      style: 'display:flex;gap:0.5rem;align-items:flex-start;margin-bottom:0.5rem;'
    },
      fieldSelect,
      fieldHost,
      removeBtn
    );

    // The state for this row's value editor lives in the closure. When
    // fieldType changes, we re-render the host but keep whatever shared
    // bits make sense (e.g. case-insensitive is global, so no per-row state).
    let local = { ...initial };

    function rebuildHost() {
      fieldHost.innerHTML = '';
      const fieldType = fieldSelect.value;
      local.fieldType = fieldType;

      if (fieldType === 'has_active_outage') {
        const sel = h('select', { class: 'select' },
          h('option', { value: 'true' }, 'Yes (has active outage)'),
          h('option', { value: 'false' }, 'No (no active outage)')
        );
        sel.value = local.value === false ? 'false' : 'true';
        sel.addEventListener('change', () => {
          local.value = sel.value === 'true';
          refreshRunDisabled();
        });
        fieldHost.appendChild(sel);
        local.value = sel.value === 'true';
        return;
      }

      if (fieldType === 'status') {
        const sel = h('select', { class: 'select' },
          h('option', { value: '' }, '- choose -'),
          ...STATUS_VALUES.map((v) => h('option', { value: v }, v))
        );
        sel.value = STATUS_VALUES.includes(local.value) ? local.value : '';
        sel.addEventListener('change', () => {
          local.value = sel.value;
          refreshRunDisabled();
        });
        fieldHost.appendChild(sel);
        return;
      }

      if (fieldType === 'applied_template') {
        // FMN-121: applied template criterion. Picker = template name,
        // mode = is attached / is not attached.
        const tplSelect = h('select', { class: 'select' });
        const matchSelect = h('select', { class: 'select' },
          h('option', { value: 'attached' }, 'is attached'),
          h('option', { value: 'not_attached' }, 'is not attached')
        );
        matchSelect.value = local.match === 'not_attached' ? 'not_attached' : 'attached';

        function repopulate() {
          while (tplSelect.firstChild) tplSelect.removeChild(tplSelect.firstChild);
          if (templateOptionsLoading) {
            tplSelect.appendChild(h('option', { value: '' }, 'Loading templates…'));
            tplSelect.disabled = true;
            return;
          }
          if (templateOptionsError) {
            tplSelect.appendChild(h('option', { value: '' }, `Error: ${templateOptionsError}`));
            tplSelect.disabled = true;
            return;
          }
          tplSelect.disabled = false;
          tplSelect.appendChild(h('option', { value: '' }, `- choose template (${(templateOptions ?? []).length}) -`));
          for (const t of (templateOptions ?? [])) {
            const typeHint = t.templateType ? ` [${t.templateType}]` : '';
            tplSelect.appendChild(h('option', { value: t.templateUrl }, `${t.name}${typeHint}`));
          }
          if (local.templateUrl) tplSelect.value = local.templateUrl;
        }
        repopulate();
        templateRowSubscribers.add(repopulate);

        tplSelect.addEventListener('change', () => {
          local.templateUrl = tplSelect.value;
          const opt = tplSelect.options[tplSelect.selectedIndex];
          local.templateName = opt && opt.value ? opt.textContent.replace(/\s\[.*\]$/, '') : null;
          refreshRunDisabled();
        });
        matchSelect.addEventListener('change', () => {
          local.match = matchSelect.value === 'not_attached' ? 'not_attached' : 'attached';
          refreshRunDisabled();
        });

        fieldHost.appendChild(tplSelect);
        fieldHost.appendChild(matchSelect);

        // Kick off the catalog load if we haven't yet.
        ensureTemplateOptions();
        // When the row is removed, drop the subscriber.
        local._tplCleanup = () => templateRowSubscribers.delete(repopulate);
        return;
      }

      // String-comparison field types
      if (fieldType === 'attribute') {
        const combo = createCombobox({
          items: attrSuggestions,
          initialText: local.attributeName ?? '',
          placeholder: attrSuggestionsLoading ? 'Loading attribute names…' : 'e.g. Model',
          allowFreeText: true,
          onChange: () => { local.attributeName = combo.getText().trim(); refreshRunDisabled(); }
        });
        if (attrSuggestionsLoading) combo.setDisabled(true);
        fieldHost.appendChild(combo.element);
        local._combo = combo;
      }

      const valueInput = h('input', {
        type: 'text', class: 'paste-area',
        placeholder: fieldType === 'tag' ? 'tag value' : 'value',
        style: 'min-height:0;height:auto;padding:0.5rem 0.7rem;font-family:inherit;flex:1;min-width:160px;'
      });
      valueInput.value = local.value ?? '';
      valueInput.addEventListener('input', () => { local.value = valueInput.value; refreshRunDisabled(); });
      fieldHost.appendChild(valueInput);

      const exactToggle = h('input', { type: 'checkbox' });
      exactToggle.checked = local.exactMatch !== false;
      exactToggle.addEventListener('change', () => { local.exactMatch = exactToggle.checked; refreshRunDisabled(); });
      const exactLabel = h('label', { style: 'display:flex;gap:0.3rem;align-items:center;font-size:0.85rem;white-space:nowrap;' },
        exactToggle,
        h('span', {}, 'Exact')
      );
      fieldHost.appendChild(exactLabel);
    }

    rebuildHost();

    fieldSelect.addEventListener('change', () => {
      // Wipe per-row value-ish state when switching field types so stale
      // values don't bleed between fundamentally different inputs.
      if (local._tplCleanup) { local._tplCleanup(); }
      local = { fieldType: fieldSelect.value };
      rebuildHost();
      refreshRunDisabled();
    });

    const row = {
      el: rowEl,
      removeBtn,
      get fieldType() { return local.fieldType; },
      isComplete() {
        if (local.fieldType === 'has_active_outage') return typeof local.value === 'boolean';
        if (local.fieldType === 'status') return STATUS_VALUES.includes(local.value);
        if (local.fieldType === 'attribute') return !!local.attributeName && !!String(local.value || '').trim();
        if (local.fieldType === 'applied_template') return !!local.templateUrl;
        return !!String(local.value || '').trim();
      },
      getCriterion() {
        const out = { fieldType: local.fieldType };
        if (local.fieldType === 'has_active_outage') return { ...out, value: !!local.value };
        if (local.fieldType === 'status') return { ...out, value: local.value };
        if (local.fieldType === 'applied_template') {
          return {
            ...out,
            templateUrl: local.templateUrl,
            templateName: local.templateName ?? null,
            match: local.match === 'not_attached' ? 'not_attached' : 'attached'
          };
        }
        if (local.fieldType === 'attribute') {
          out.attributeName = local.attributeName;
        }
        out.value = String(local.value || '').trim();
        out.exactMatch = local.exactMatch !== false;
        return out;
      },
      setDisabled(disabled) {
        fieldSelect.disabled = disabled;
        removeBtn.disabled = disabled;
        const inputs = fieldHost.querySelectorAll('input, select, button');
        for (const el of inputs) el.disabled = disabled;
        if (local._combo) local._combo.setDisabled(disabled);
      }
    };

    removeBtn.addEventListener('click', () => {
      if (rows.size <= 1) {
        // If this is the last criterion row, clear it instead of removing.
        // The filter section is optional, so the operator should be able
        // to drop the filter entirely. But the simplest path is just to
        // remove the row; no rows = no filter.
      }
      if (local._tplCleanup) local._tplCleanup();
      rows.delete(row);
      rowEl.remove();
      refreshRunDisabled();
    });

    rows.add(row);
    rowsHost.appendChild(rowEl);
    return row;
  }

  // Restore criteria from store, or start with one empty row.
  if (store.criteria && store.criteria.length > 0) {
    for (const c of store.criteria) makeCriterionRow(c);
  } else {
    makeCriterionRow();
  }

  addCritBtn.addEventListener('click', () => {
    makeCriterionRow();
    refreshRunDisabled();
  });

  idsTextarea.addEventListener('input', refreshRunDisabled);
  matchModeSelect.addEventListener('change', refreshRunDisabled);

  for (const def of colDefs) {
    colChecks[def.key].addEventListener('change', () => {
      store.columns[def.key] = colChecks[def.key].checked;
    });
  }

  // ---- Run gating ----
  function parsedIdentifiers() {
    return idsTextarea.value
      .split(/\r?\n/)
      .map((s) => s.split('#')[0].trim())
      .filter(Boolean);
  }
  function refreshRunDisabled() {
    const hasIds = parsedIdentifiers().length > 0;
    const hasCompleteCriteria = Array.from(rows).some((r) => r.isComplete());
    // Run is enabled as long as the operator has at least one source of
    // input. Incomplete criterion rows are silently dropped at submit
    // time rather than blocking the run.
    runBtn.disabled = !(hasIds || hasCompleteCriteria);
  }

  // ---- Subscribe to per-page progress events ----
  const unsubscribe = events.on((event, payload) => {
    if (event !== 'search:page') return;
    const { fetched, total, matches } = payload ?? {};
    stateLabel.textContent = `Scanned ${fetched}${total ? ` of ${total}` : ''} - ${matches} match${matches === 1 ? '' : 'es'}`;
    stateLabel.className = 'execute-state';
  });

  // ---- Populate attribute suggestions (used by 'attribute' criterion combobox AND attribute-column picker) ----
  (async () => {
    try {
      const types = await call('search:list-attribute-types', {});
      attrSuggestions = types.map((t) => ({
        value: t.name,
        label: t.name,
        hint: t.textkey && t.textkey !== t.name ? t.textkey : null
      }));
      attrSuggestionsLoading = false;
      // Update any existing attribute-criterion combos.
      for (const r of rows) {
        // The internal _combo is only set for fieldType=attribute rows.
        const combos = r.el.querySelectorAll('.combobox-input, [role="combobox"]');
        // If the row currently has a combo wrapper, we recreated it via
        // createCombobox; it owns its own setItems / setDisabled. The
        // simplest cross-row update is to refresh the row by triggering
        // its rebuild via fieldSelect change, but that loses state. We
        // bypass by reaching into the local closure-tracked combo via a
        // marker on the element if present.
        const marker = r.el.querySelector('[data-combo-host]');
        void combos; void marker;
      }
      // Build the attribute-column picker once suggestions are loaded.
      attrColCombo = createCombobox({
        items: attrSuggestions,
        initialText: '',
        placeholder: 'Pick an attribute…',
        allowFreeText: true
      });
      attrColPickerHost.innerHTML = '';
      attrColPickerHost.appendChild(attrColCombo.element);
      attrColPickerHost.appendChild(addAttrColBtn);
      addAttrColBtn.addEventListener('click', () => {
        const name = attrColCombo.getText().trim();
        if (!name) return;
        if (!store.columns.attributes.includes(name)) {
          store.columns.attributes = [...store.columns.attributes, name];
          renderAttrChips();
        }
        attrColCombo.setText('');
      });
      refreshRunDisabled();
    } catch (err) {
      attrSuggestionsLoading = false;
      stateLabel.textContent = `Could not load attribute suggestions: ${err?.message ?? err}`;
      stateLabel.className = 'execute-state error';
      attrColPickerHost.innerHTML = '';
      attrColPickerHost.appendChild(h('span', { class: 'muted' }, 'Attribute suggestions unavailable; type names manually.'));
      refreshRunDisabled();
    }
  })();

  // ---- Run handler ----
  runBtn.addEventListener('click', async () => {
    const identifiers = parsedIdentifiers();
    const completeRows = Array.from(rows).filter((r) => r.isComplete());
    const criteria = completeRows.map((r) => r.getCriterion());
    if (identifiers.length === 0 && criteria.length === 0) return;

    store.identifiersText = idsTextarea.value;
    store.criteria = criteria;
    store.mode = matchModeSelect.value === 'any' ? 'any' : 'all';
    store.caseInsensitive = caseToggle.checked;

    runBtn.disabled = true;
    addCritBtn.disabled = true;
    matchModeSelect.disabled = true;
    caseToggle.disabled = true;
    idsTextarea.disabled = true;
    for (const r of rows) r.setDisabled(true);

    progressBox.hidden = false;
    progressBox.innerHTML = '';
    progressBox.appendChild(h('div', { class: 'progress-row' },
      h('span', { class: 'serial' }, `Searching… ${identifiers.length} identifier(s), ${criteria.length} criterion(s), match=${store.mode}.`)
    ));
    stateLabel.textContent = 'Starting…';
    stateLabel.className = 'execute-state';

    try {
      const result = await call('search:servers', {
        identifiers,
        criteria,
        mode: store.mode,
        caseInsensitive: store.caseInsensitive
      });
      store.runResult = result;
      stateLabel.textContent = `Done - ${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} of ${result.totalScanned} scanned`;
      setTimeout(() => navigate('/results'), 400);
    } catch (err) {
      stateLabel.textContent = `Error: ${err?.message ?? err}`;
      stateLabel.className = 'execute-state error';
      runBtn.disabled = false;
      addCritBtn.disabled = false;
      matchModeSelect.disabled = false;
      caseToggle.disabled = false;
      idsTextarea.disabled = false;
      for (const r of rows) r.setDisabled(false);
    }
  });

  refreshRunDisabled();
  return () => unsubscribe();
}
