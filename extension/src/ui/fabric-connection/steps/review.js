// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Add Fabric Connection - Step 2 (Review).
// Show the parsed devices, the selected targets, an example payload,
// and the dry-run / live mode toggle. Live mode requires a typed
// confirmation phrase before the Execute button enables.

import { h, titleBar } from '../../../lib/dom.js';
import { fcBreadcrumbs } from './start.js';

const TOOL_NAME = 'Add Fabric Connection (API)';
const CONFIRMATION_PHRASE = 'CREATE';

function nameForUrl(url, options) {
  if (!url) return null;
  const m = options.find((o) => o.resourceUrl === url);
  return m ? `${m.name} (#${m.id})` : url;
}

function buildPreview(device, store) {
  return {
    integration_type: 'onsight_csf_tunnel',
    label: device.name || device.ip,
    onsight: store.onsightUrl,
    server_group: store.serverGroupUrl,
    ...(store.applianceGroupUrl ? { appliance_group: store.applianceGroupUrl } : {}),
    upstream_host: device.ip,
    upstream_port: device.port,
    upstream_sn: device.serial,
    discover_frequency: store.discoverFrequency
  };
}

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Review', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    fcBreadcrumbs('review'),
    h('h2', {}, `${store.devices.length} device${store.devices.length === 1 ? '' : 's'} ready to onboard`),
    h('p', {}, 'Verify the planned changes below. Dry-run is the default - switch to live mode and type the confirmation phrase to enable Execute.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ---- Targets summary ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Targets'));
  body.appendChild(h('div', { class: 'targets-summary' },
    h('div', {}, h('strong', {}, 'OnSight: '), nameForUrl(store.onsightUrl, store.onsightOptions) ?? '-'),
    h('div', {}, h('strong', {}, 'Server group: '), nameForUrl(store.serverGroupUrl, store.serverGroupOptions) ?? '-'),
    h('div', {}, h('strong', {}, 'Appliance group: '), nameForUrl(store.applianceGroupUrl, store.onsightGroupOptions) ?? '- none -'),
    h('div', {}, h('strong', {}, 'Discover frequency: '), `${store.discoverFrequency}s`)
  ));

  // ---- Devices table ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Devices'));
  const table = h('table', { class: 'review-table' });
  const thead = h('thead', {}, h('tr', {},
    h('th', {}, '#'),
    h('th', {}, 'Serial'),
    h('th', {}, 'IP'),
    h('th', {}, 'Port'),
    h('th', {}, 'Name (label)')
  ));
  const tbody = h('tbody', {});
  let anyFlagged = false;
  store.devices.forEach((d, i) => {
    const serialCell = h('td', {}, d.serial);
    if (d.flagged) {
      anyFlagged = true;
      serialCell.appendChild(h('span', { class: 'flag-badge', title: `Included despite: ${d.flagged}` }, ' ⚑ flagged'));
    }
    // Name column (FMN-291): show the entered label, or a muted "defaults to
    // IP" hint so the fallback is visible before going live.
    const nameCell = d.name
      ? h('td', {}, d.name)
      : h('td', {}, h('span', { class: 'name-fallback' }, `${d.ip} (defaults to IP)`));
    tbody.appendChild(h('tr', { class: d.flagged ? 'row-flagged' : '' },
      h('td', {}, String(i + 1)),
      serialCell,
      h('td', {}, d.ip),
      h('td', {}, String(d.port)),
      nameCell
    ));
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  body.appendChild(table);

  if (anyFlagged) {
    body.appendChild(h('div', { class: 'parse-hint' },
      '⚑ Flagged devices failed a format check (unusual serial or non-IPv4 host) and were included via the "Include flagged devices" option. Confirm the serial / host are correct before going live.'
    ));
  }

  // ---- Example payload ----
  if (store.devices.length) {
    body.appendChild(h('h3', { class: 'subhead' }, 'Example POST body (first device)'));
    body.appendChild(h('pre', { class: 'preview-payload' },
      JSON.stringify(buildPreview(store.devices[0], store), null, 2)
    ));
  }

  // ---- Mode + confirmation ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Execution mode'));
  const dryRunRadio = h('input', { type: 'radio', name: 'mode', value: 'dry-run', checked: store.dryRun !== false });
  const liveRadio = h('input', { type: 'radio', name: 'mode', value: 'live', checked: store.dryRun === false });
  body.appendChild(h('div', { class: 'mode-options' },
    h('label', {}, dryRunRadio, ' Dry-run (build payloads, no POST)'),
    h('label', {}, liveRadio, ' Live (POST to api2.panopta.com)')
  ));

  const confirmRow = h('div', { class: 'confirmation-row', hidden: store.dryRun !== false },
    h('label', {}, `Type "${CONFIRMATION_PHRASE}" to enable Execute:`),
    h('input', { type: 'text', class: 'confirmation-input', placeholder: CONFIRMATION_PHRASE })
  );
  body.appendChild(confirmRow);

  // ---- Action bar ----
  const backBtn = h('button', { class: 'btn btn-secondary' }, '← Back');
  const executeBtn = h('button', { class: 'btn btn-primary' }, 'Execute');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, ''),
    h('div', { class: 'right' }, backBtn, executeBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  // ---- Behavior ----

  function refreshExecuteEnabled() {
    if (dryRunRadio.checked) {
      executeBtn.disabled = false;
      return;
    }
    const input = confirmRow.querySelector('.confirmation-input');
    executeBtn.disabled = (input?.value ?? '').trim() !== CONFIRMATION_PHRASE;
  }

  function onModeChange() {
    store.dryRun = dryRunRadio.checked;
    confirmRow.hidden = dryRunRadio.checked;
    refreshExecuteEnabled();
  }

  dryRunRadio.addEventListener('change', onModeChange);
  liveRadio.addEventListener('change', onModeChange);
  confirmRow.querySelector('.confirmation-input').addEventListener('input', refreshExecuteEnabled);

  backBtn.addEventListener('click', () => navigate('/start'));
  executeBtn.addEventListener('click', () => {
    store.confirmationPhrase = dryRunRadio.checked ? null : CONFIRMATION_PHRASE;
    navigate('/execute');
  });

  refreshExecuteEnabled();
}
