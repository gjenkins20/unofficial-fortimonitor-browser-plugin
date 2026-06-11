// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Add Fabric Connection - Step 1 (Start).
// Operator pastes/uploads a CSV of FortiGates and picks an OnSight +
// server group from dropdowns populated by the v2 API list endpoints.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { parseFortigateList } from '../parse-csv.js';

const TOOL_NAME = 'Add Fabric Connection (API)';

export function fcBreadcrumbs(active) {
  const steps = [
    { id: 'start', label: '1. Load devices' },
    { id: 'review', label: '2. Review' },
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

function rebuildPasteValue(devices) {
  if (!devices.length) return '';
  return ['serial,ip,port', ...devices.map((d) => `${d.serial},${d.ip},${d.port}`)].join('\n');
}

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Start Batch', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    fcBreadcrumbs('start'),
    h('h2', {}, 'Load FortiGate devices and pick targets'),
    h('p', {}, 'Provide the FortiGates you want to onboard plus the OnSight instance and server group they should join. The plugin will POST one fabric_connection per device using your saved FortiMonitor v2 API key.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ---- File / paste input ----
  body.appendChild(h('h3', { class: 'subhead' }, 'FortiGate devices'));

  const fileInput = h('input', { type: 'file', accept: '.csv,.txt', hidden: true });
  const dropZone = h('label', { class: 'drop-zone' },
    h('div', { class: 'dz-icon' }, '↑'),
    h('div', { class: 'dz-primary' },
      'Drop CSV here, or ',
      h('span', { class: 'dz-link' }, 'click to browse')
    ),
    h('div', { class: 'dz-secondary' }, 'Accepts .csv or plain text · serial,ip,port per line'),
    fileInput
  );
  body.appendChild(dropZone);

  body.appendChild(h('div', { class: 'divider' }, 'or paste below'));

  const paste = h('textarea', {
    class: 'paste-area',
    placeholder: 'serial,ip,port\nFGVM01TM24006844,10.0.0.94,8013\nFGVM02TM24006845,10.0.0.95,8013'
  });
  paste.value = rebuildPasteValue(store.devices);
  body.appendChild(paste);

  body.appendChild(h('div', { class: 'format-hint', html:
    '<strong>Format:</strong> CSV with columns <code>serial,ip,port</code> (header optional). Port defaults to 8013 if omitted.' +
    '<pre># with header\nserial,ip,port\nFGVM01TM24006844,10.0.0.94,8013\n\n# positional\nFGVM01TM24006844,10.0.0.94,8013\nFGVM02TM24006845,10.0.0.95</pre>'
  }));

  // ---- Include-flagged override (FMN-265) ----
  const includeFlaggedCheckbox = h('input', { type: 'checkbox' });
  includeFlaggedCheckbox.checked = !!store.includeFlagged;
  body.appendChild(h('label', { class: 'include-flagged-row' },
    includeFlaggedCheckbox,
    h('span', {},
      h('strong', {}, 'Include flagged devices'),
      ' - onboard rows that only fail format checks (unusual serial, non-IPv4 host) anyway. Rows missing a serial or host, and duplicates, are still skipped.'
    )
  ));

  const parseResult = h('div', { class: 'parse-result empty' });
  body.appendChild(parseResult);

  // ---- Targets ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Targets'));

  const onsightSelect = h('select', { class: 'select' }, h('option', { value: '' }, 'Loading…'));
  const serverGroupSelect = h('select', { class: 'select' }, h('option', { value: '' }, 'Loading…'));
  const applianceGroupSelect = h('select', { class: 'select' }, h('option', { value: '' }, '- None (skip) -'));
  const discoverFreqInput = h('input', { type: 'number', min: '10', max: '3600', value: String(store.discoverFrequency || 60), class: 'select' });

  body.appendChild(h('div', { class: 'targets-grid' },
    h('label', {}, h('span', { class: 'label-text' }, 'OnSight'), onsightSelect),
    h('label', {}, h('span', { class: 'label-text' }, 'Server group'), serverGroupSelect),
    h('label', {}, h('span', { class: 'label-text' }, 'Appliance group (optional, HA only)'), applianceGroupSelect),
    h('label', {}, h('span', { class: 'label-text' }, 'Discover frequency (sec)'), discoverFreqInput)
  ));

  const targetsError = h('div', { class: 'parse-result empty' });
  body.appendChild(targetsError);

  // ---- Action bar ----
  const continueBtn = h('button', { class: 'btn btn-primary', disabled: true }, 'Continue → Review');
  const cancelBtn = h('button', { class: 'btn btn-secondary' }, 'Clear');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, 'Uses your saved FortiMonitor v2 API key (RW)'),
    h('div', { class: 'right' }, cancelBtn, continueBtn)
  );
  frame.appendChild(actionBar);

  container.appendChild(frame);

  // ---- Behavior ----

  function refreshContinue() {
    const hasDevices = store.devices.length > 0;
    const hasOnsight = !!onsightSelect.value;
    const hasServerGroup = !!serverGroupSelect.value;
    continueBtn.disabled = !(hasDevices && hasOnsight && hasServerGroup);
  }

  function updateParseResult(result) {
    parseResult.innerHTML = '';
    parseResult.classList.toggle('empty', !result);
    if (!result) return;
    const ok = result.devices.length;
    const bad = result.warnings.length;
    const flagged = result.devices.filter((d) => d.flagged).length;
    const softSkipped = (result.skipped || []).filter((s) => s.severity === 'soft').length;
    parseResult.appendChild(h('div', { class: ok ? 'parse-ok' : 'parse-warn' },
      `${ok} device${ok === 1 ? '' : 's'} parsed`
        + (flagged ? ` (${flagged} flagged)` : '')
        + (bad ? ` · ${bad} warning${bad === 1 ? '' : 's'}` : '')
    ));
    // When format-only rows were dropped and the override is off, point the
    // operator at the checkbox rather than leaving them stuck (FMN-265).
    if (softSkipped && !store.includeFlagged) {
      parseResult.appendChild(h('div', { class: 'parse-hint' },
        `${softSkipped} row${softSkipped === 1 ? '' : 's'} skipped by format checks. `
          + 'Enable "Include flagged devices" above to onboard them anyway.'
      ));
    }
    if (bad) {
      const list = h('ul', { class: 'parse-warnings' });
      for (const w of result.warnings.slice(0, 10)) list.appendChild(h('li', {}, w));
      if (bad > 10) list.appendChild(h('li', {}, `… and ${bad - 10} more`));
      parseResult.appendChild(list);
    }
  }

  function reparse() {
    const result = parseFortigateList(paste.value, { includeFlagged: store.includeFlagged });
    store.devices = result.devices.map((d) => ({
      serial: d.serial, ip: d.ip, port: d.port, ...(d.flagged ? { flagged: d.flagged } : {})
    }));
    store.warnings = result.warnings;
    updateParseResult(result);
    refreshContinue();
  }

  paste.addEventListener('input', reparse);
  includeFlaggedCheckbox.addEventListener('change', () => {
    store.includeFlagged = includeFlaggedCheckbox.checked;
    reparse();
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    paste.value = await file.text();
    reparse();
  });

  cancelBtn.addEventListener('click', () => {
    paste.value = '';
    store.devices = [];
    store.warnings = [];
    updateParseResult(null);
    refreshContinue();
  });

  continueBtn.addEventListener('click', () => {
    const onsight = store.onsightOptions.find((o) => String(o.id) === onsightSelect.value);
    const sg = store.serverGroupOptions.find((o) => String(o.id) === serverGroupSelect.value);
    const ag = applianceGroupSelect.value
      ? store.onsightGroupOptions.find((o) => String(o.id) === applianceGroupSelect.value)
      : null;
    store.onsightUrl = onsight?.resourceUrl ?? null;
    store.serverGroupUrl = sg?.resourceUrl ?? null;
    store.applianceGroupUrl = ag?.resourceUrl ?? null;
    store.discoverFrequency = Number(discoverFreqInput.value) || 60;
    navigate('/review');
  });

  for (const sel of [onsightSelect, serverGroupSelect, applianceGroupSelect]) {
    sel.addEventListener('change', refreshContinue);
  }

  // Initial parse from any persisted devices.
  if (store.devices.length) reparse();

  // ---- Load dropdowns from API ----
  async function loadList(messageType) {
    return call(messageType, {});
  }

  function fillSelect(select, items, { placeholder = '- Select -' } = {}) {
    select.innerHTML = '';
    select.appendChild(h('option', { value: '' }, placeholder));
    for (const item of items) {
      const opt = h('option', { value: String(item.id) }, item.name);
      select.appendChild(opt);
    }
  }

  function showTargetsError(msg) {
    targetsError.innerHTML = '';
    targetsError.classList.remove('empty');
    targetsError.appendChild(h('div', { class: 'parse-warn' }, msg));
  }

  Promise.all([
    loadList('panopta:list-onsight').catch((err) => ({ __err: err })),
    loadList('panopta:list-server-groups').catch((err) => ({ __err: err })),
    loadList('panopta:list-onsight-groups').catch((err) => ({ __err: err }))
  ]).then(([onsight, serverGroups, onsightGroups]) => {
    if (onsight?.__err || serverGroups?.__err) {
      const err = onsight?.__err ?? serverGroups?.__err;
      const msg = String(err?.message ?? err);
      if (/api key/i.test(msg) || /401/.test(msg)) {
        showTargetsError('No valid API key configured. Open the extension popup → Settings (⚙) and paste a FortiMonitor RW API key.');
      } else {
        showTargetsError(`Failed to load targets: ${msg}`);
      }
      return;
    }
    store.onsightOptions = onsight ?? [];
    store.serverGroupOptions = serverGroups ?? [];
    store.onsightGroupOptions = onsightGroups?.__err ? [] : (onsightGroups ?? []);
    fillSelect(onsightSelect, store.onsightOptions);
    fillSelect(serverGroupSelect, store.serverGroupOptions);
    fillSelect(applianceGroupSelect, store.onsightGroupOptions, { placeholder: '- None (skip) -' });
    refreshContinue();
  });
}
