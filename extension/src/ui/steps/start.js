// Step 1 — Load devices. Operator pastes/uploads a list of server IDs
// (optionally with device names via CSV), we validate by silently
// reading each device's port scope, then hand off to the review step.

import { h, titleBar, breadcrumbs } from '../../lib/dom.js';
import { parseServerList } from '../parse-csv.js';
import { call } from '../../lib/messaging.js';

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });

  frame.appendChild(titleBar('Start Batch'));
  frame.appendChild(h('div', { class: 'step-header' },
    breadcrumbs('start'),
    h('h2', {}, 'Load devices from CSV'),
    h('p', {}, 'Provide the list of FortiMonitor server IDs you want to review. The plugin will read each device\'s port scope using your active FortiCloud session, group devices by identical interface state, and surface one review prompt per unique group.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const fileInput = h('input', { type: 'file', accept: '.csv,.txt', hidden: true });
  const dropZone = h('label', { class: 'drop-zone' },
    h('div', { class: 'dz-icon' }, '↑'),
    h('div', { class: 'dz-primary' },
      'Drop CSV here, or ',
      h('span', { class: 'dz-link' }, 'click to browse')
    ),
    h('div', { class: 'dz-secondary' }, 'Accepts .csv or plain text · one server ID per line'),
    fileInput
  );
  body.appendChild(dropZone);

  body.appendChild(h('div', { class: 'divider' }, 'or paste below'));

  const paste = h('textarea', {
    class: 'paste-area',
    placeholder: '42024060\n42024061\n42024075\n...'
  });
  paste.value = store.serverIds.length ? rebuildPasteValue(store.serverIds, store.nameById) : '';
  body.appendChild(paste);

  body.appendChild(h('div', { class: 'format-hint', html:
    '<strong>Format:</strong> plain list of server IDs (one per line) <em>or</em> a CSV with a <code>server_id</code> column.' +
    '<pre># plain list\n42024060\n42024061\n\n# or CSV\nserver_id,device_name\n42024060,FGT-Branch-001\n42024061,FGT-Branch-002</pre>'
  }));

  const parseResult = h('div', { class: 'parse-result empty' });
  body.appendChild(parseResult);

  // --- action bar ---
  const startBtn = h('button', { class: 'btn btn-primary', disabled: true }, 'Start review →');
  const cancelBtn = h('button', { class: 'btn btn-secondary' }, 'Clear');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, 'Uses your active FortiCloud session (cookies)'),
    h('div', { class: 'right' }, cancelBtn, startBtn)
  );
  frame.appendChild(actionBar);

  container.appendChild(frame);

  // --- wiring ---
  function updateParseResult() {
    const parsed = parseServerList(paste.value);
    store.serverIds = parsed.serverIds;
    store.nameById = parsed.nameById;
    store.inputWarnings = parsed.warnings;

    if (parsed.serverIds.length === 0) {
      parseResult.className = 'parse-result empty';
      parseResult.replaceChildren(
        h('div', { class: 'headline' }, 'No server IDs detected'),
        h('div', { class: 'sub' }, 'Paste a list above or drop a CSV file.')
      );
      startBtn.disabled = true;
      return;
    }

    parseResult.className = 'parse-result';
    const sample = parsed.serverIds.slice(0, 25).join(', ');
    const more = parsed.serverIds.length > 25 ? `, … +${parsed.serverIds.length - 25} more` : '';
    const kids = [
      h('div', { class: 'headline' }, `${parsed.serverIds.length} device${parsed.serverIds.length === 1 ? '' : 's'} ready to review`),
      h('div', { class: 'sub' }, `${parsed.totalLines} line${parsed.totalLines === 1 ? '' : 's'} read · ${Object.keys(parsed.nameById).length} named from CSV`),
      h('div', { class: 'sample-ids' }, h('span', { class: 'sid' }, sample + more))
    ];
    if (parsed.warnings.length) {
      kids.push(h('div', { class: 'warn-list' },
        h('strong', {}, `${parsed.warnings.length} warning${parsed.warnings.length === 1 ? '' : 's'}: `),
        h('ul', {}, ...parsed.warnings.map((w) => h('li', {}, w)))
      ));
    }
    parseResult.replaceChildren(...kids);
    startBtn.disabled = false;
  }

  paste.addEventListener('input', updateParseResult);

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    paste.value = text;
    updateParseResult();
  });

  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const text = await file.text();
    paste.value = text;
    updateParseResult();
  });

  cancelBtn.addEventListener('click', () => {
    paste.value = '';
    store.serverIds = [];
    store.nameById = {};
    store.inputWarnings = [];
    updateParseResult();
  });

  startBtn.addEventListener('click', async () => {
    if (!store.serverIds.length) return;
    startBtn.disabled = true;
    startBtn.textContent = 'Scanning…';
    try {
      const result = await call('scan-devices', { serverIds: store.serverIds });
      store.scanResult = result;
      store.batchId = `b_${new Date().toISOString().replace(/[:\-TZ.]/g, '').slice(0, 14)}`;
      store.reviewIndex = 0;
      store.decisions = new Map();
      store.queueEntries = [];
      store.executePlan = null;
      store.runResult = null;
      navigate('/review');
    } catch (err) {
      startBtn.disabled = false;
      startBtn.textContent = 'Start review →';
      parseResult.className = 'parse-result';
      parseResult.appendChild(h('div', { class: 'warn-list' },
        h('strong', {}, 'Scan failed: '), err?.message ?? String(err)
      ));
    }
  });

  if (paste.value) updateParseResult();
}

function rebuildPasteValue(serverIds, nameById) {
  return serverIds.map((id) => nameById[id] ? `${id},${nameById[id]}` : id).join('\n');
}
