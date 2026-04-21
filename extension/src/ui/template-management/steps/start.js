// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Manage Server Templates - Step 1 (Start).
// Pick mode (attach/detach), template, strategy (detach only), continuous
// (attach only), and paste a list of servers.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';

const TOOL_NAME = 'Manage Server Templates (Bulk)';

export function tmplBreadcrumbs(active) {
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
    tmplBreadcrumbs('start'),
    h('h2', {}, 'Attach or detach a monitoring template across many servers'),
    h('p', {}, 'Pick a template, choose the operation, and paste the list of servers. The preview step pre-flights each server and shows exactly what will change before anything is written.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ---- Operation ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Operation'));
  const opAttach = h('input', { type: 'radio', name: 'tmpl-op', value: 'attach', checked: store.operation === 'attach' });
  const opDetach = h('input', { type: 'radio', name: 'tmpl-op', value: 'detach', checked: store.operation === 'detach' });
  body.appendChild(h('div', { class: 'radio-row' },
    h('label', {}, opAttach, h('span', {}, 'Attach (add template to servers)')),
    h('label', {}, opDetach, h('span', {}, 'Detach (remove template from servers)'))
  ));

  // ---- Template picker ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Template'));
  const templateSelect = h('select', { class: 'select' }, h('option', { value: '' }, 'Loading templates…'));
  body.appendChild(h('div', { class: 'targets-grid single-col' },
    h('label', {}, h('span', { class: 'label-text' }, 'Template'), templateSelect)
  ));

  // ---- Attach options (continuous) ----
  const continuousInput = h('input', { type: 'checkbox', checked: store.continuous !== false });
  const attachOpts = h('div', { class: 'radio-row option-row' },
    h('label', {}, continuousInput,
      h('span', {},
        h('strong', {}, 'Continuous'),
        h('span', { class: 'muted' }, ' - keep adding new metrics as collection discovers them (matches FortiMonitor default)')
      )
    )
  );
  body.appendChild(attachOpts);

  // ---- Detach strategy ----
  const strategyDissociate = h('input', { type: 'radio', name: 'tmpl-strategy', value: 'dissociate', checked: store.strategy !== 'delete' });
  const strategyDelete = h('input', { type: 'radio', name: 'tmpl-strategy', value: 'delete', checked: store.strategy === 'delete' });
  const detachOpts = h('div', { class: 'strategy-group' },
    h('h3', { class: 'subhead' }, 'Detach strategy'),
    h('label', { class: 'strategy-option' },
      strategyDissociate,
      h('span', { class: 'strategy-meta' },
        h('span', { class: 'strategy-head' }, 'Dissociate (safe)'),
        h('span', { class: 'strategy-sub muted' }, 'Keep metrics and attributes the template added. Reversible - you can re-attach later.')
      )
    ),
    h('label', { class: 'strategy-option destructive' },
      strategyDelete,
      h('span', { class: 'strategy-meta' },
        h('span', { class: 'strategy-head' }, 'Delete (destructive)'),
        h('span', { class: 'strategy-sub' },
          'Remove association AND wipe metrics/attributes this template added. ',
          h('strong', {}, 'Metric history is lost.')
        )
      )
    )
  );
  body.appendChild(detachOpts);

  function refreshOperationVisibility() {
    attachOpts.style.display = opAttach.checked ? '' : 'none';
    detachOpts.style.display = opDetach.checked ? '' : 'none';
  }
  opAttach.addEventListener('change', refreshOperationVisibility);
  opDetach.addEventListener('change', refreshOperationVisibility);
  refreshOperationVisibility();

  // ---- Targets ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Target servers'));
  body.appendChild(h('p', { class: 'format-hint' },
    'One per line. Each line is either a server name (resolved via the v2 API, case-sensitive exact match) or a numeric server id.'
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

  // ---- Populate templates (async) ----
  (async () => {
    try {
      const templates = store.templates?.length
        ? store.templates
        : await call('tmpl:list-templates', {});
      store.templates = templates;
      while (templateSelect.firstChild) templateSelect.removeChild(templateSelect.firstChild);
      templateSelect.appendChild(h('option', { value: '' }, `- Choose template (${templates.length}) -`));
      for (const t of templates) {
        const typeHint = t.templateType ? ` [${t.templateType}]` : '';
        const appliedHint = t.appliedServerUrls?.length ? ` · applied to ${t.appliedServerUrls.length}` : '';
        templateSelect.appendChild(h('option', { value: t.resourceUrl }, `${t.name}${typeHint}${appliedHint}`));
      }
      if (store.templateUrl) templateSelect.value = store.templateUrl;
      updateContinue();
    } catch (err) {
      while (templateSelect.firstChild) templateSelect.removeChild(templateSelect.firstChild);
      templateSelect.appendChild(h('option', { value: '' }, `Error: ${err?.message ?? err}`));
      statusRow.className = 'parse-result error';
      statusRow.textContent = err?.message
        ? `Could not load templates: ${err.message}. Check your API key in Settings (⚙).`
        : 'Could not load templates.';
    }
  })();

  // ---- Wiring ----
  function updateContinue() {
    const hasTemplate = !!templateSelect.value;
    const entries = parseEntries(textarea.value);
    const hasTargets = entries.length > 0;
    continueBtn.disabled = !(hasTemplate && hasTargets);

    if (entries.length > 0) {
      statusRow.className = 'parse-result ok';
      statusRow.textContent = `${entries.length} target${entries.length === 1 ? '' : 's'} queued - preview will resolve names and show the plan.`;
    } else if (!textarea.value.trim()) {
      statusRow.className = 'parse-result empty';
      statusRow.textContent = '';
    }
  }

  templateSelect.addEventListener('change', updateContinue);
  textarea.addEventListener('input', updateContinue);

  clearBtn.addEventListener('click', () => {
    textarea.value = '';
    templateSelect.value = '';
    updateContinue();
  });

  continueBtn.addEventListener('click', () => {
    store.operation = opDetach.checked ? 'detach' : 'attach';
    store.templateUrl = templateSelect.value;
    const selectedOpt = templateSelect.options[templateSelect.selectedIndex];
    store.templateName = selectedOpt ? selectedOpt.textContent : null;
    const match = /\/server_template\/(\d+)\/?$/.exec(templateSelect.value || '');
    store.templateId = match ? Number(match[1]) : null;
    store.continuous = continuousInput.checked;
    store.strategy = strategyDelete.checked ? 'delete' : 'dissociate';
    store.entries = parseEntries(textarea.value);
    store.plan = null;
    store.runResult = null;
    navigate('/preview');
  });

  updateContinue();
}
