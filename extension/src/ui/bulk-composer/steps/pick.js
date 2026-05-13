// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-163: pick step rebuilt as a 1:1 visual port of the Add to Port Scope
// (Fabric) "Load devices from CSV" step. Drop-zone + paste textarea + green
// format-hint card + parse-result preview table + single Continue button.
//
// Replaces the FMN-155 layout that led with an omni-search dropdown plus
// clipboard / page-selection loader buttons and rendered the selection as
// chips. Operator-confirmed 2026-05-13: the screenshot of Add to Port Scope's
// load step IS the whole step. No omni-search. No loader buttons. No chips.
//
// Downstream contract preserved: store.targets is an array of
//   { id: number, name: string | null }
// which is the same shape the action / configure / commit steps read.

import { h, titleBar } from '../../../lib/dom.js';
import { parseServerList } from '../../parse-csv.js';
import { bulkBreadcrumbs } from './breadcrumbs.js';

const TOOL_NAME = 'Bulk Action Composer';

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Pick instances', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    bulkBreadcrumbs('pick'),
    h('h2', {}, 'Load instances by ID'),
    h('p', {}, 'Provide the list of FortiMonitor server IDs you want to operate on. The Composer resolves each ID against your active FortiMonitor session and takes you to the action picker.')
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
  // If the operator already picked instances on a prior pass, rebuild the
  // paste value from the existing targets so the step is idempotent on revisit.
  if (Array.isArray(store.targets) && store.targets.length) {
    paste.value = store.targets.map((t) => t.name ? `${t.id},${t.name}` : String(t.id)).join('\n');
  }
  body.appendChild(paste);

  body.appendChild(h('div', { class: 'format-hint', html:
    '<strong>Format:</strong> plain list of server IDs (one per line) <em>or</em> a CSV with a <code>server_id</code> column.' +
    '<pre># plain list\n42024060\n42024061\n\n# or CSV\nserver_id,device_name\n42024060,FGT-Branch-001\n42024061,FGT-Branch-002</pre>'
  }));

  const parseResult = h('div', { class: 'parse-result empty' });
  body.appendChild(parseResult);

  // Action bar - matches Port Scope's footer copy exactly so the chrome
  // reads as a sibling step.
  const clearBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Clear');
  const nextBtn = h('button', {
    class: 'btn btn-primary',
    'data-test': 'pick-next',
    type: 'button',
    disabled: true
  }, 'Continue to action picker →');
  frame.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, 'Uses your active FortiMonitor session (cookies)'),
    h('div', { class: 'right' }, clearBtn, nextBtn)
  ));

  container.appendChild(frame);

  function updateParseResult() {
    const parsed = parseServerList(paste.value);

    if (parsed.serverIds.length === 0) {
      // Empty state - match Port Scope's exact copy.
      parseResult.className = 'parse-result empty';
      parseResult.replaceChildren(
        h('div', { class: 'headline' }, 'No server IDs detected'),
        h('div', { class: 'sub' }, 'Paste a list above or drop a CSV file.')
      );
      store.targets = [];
      nextBtn.disabled = true;
      return;
    }

    parseResult.className = 'parse-result';
    const namedCount = Object.keys(parsed.nameById).length;
    const kids = [
      h('div', { class: 'headline' },
        `${parsed.serverIds.length} instance${parsed.serverIds.length === 1 ? '' : 's'} ready to operate on`),
      h('div', { class: 'sub' },
        `${parsed.totalLines} line${parsed.totalLines === 1 ? '' : 's'} read · ${namedCount} named from CSV` +
        (namedCount < parsed.serverIds.length ? ' (unnamed rows resolve by ID downstream)' : '')),
      renderSampleTable(parsed.serverIds, parsed.nameById)
    ];
    if (parsed.warnings.length) {
      kids.push(h('div', { class: 'warn-list' },
        h('strong', {}, `${parsed.warnings.length} warning${parsed.warnings.length === 1 ? '' : 's'}: `),
        h('ul', {}, ...parsed.warnings.map((w) => h('li', {}, w)))
      ));
    }
    parseResult.replaceChildren(...kids);

    // Mirror the parsed result onto store.targets so action / configure /
    // commit get the same data shape they did under the chip-based UI.
    // .id is numeric (downstream PATCH calls send the int), .name is the
    // operator-supplied display name or null.
    store.targets = parsed.serverIds.map((id) => ({
      id: Number(id),
      name: parsed.nameById[id] ?? null
    }));
    nextBtn.disabled = false;
  }

  paste.addEventListener('input', updateParseResult);

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    paste.value = text;
    updateParseResult();
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
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

  clearBtn.addEventListener('click', () => {
    paste.value = '';
    store.targets = [];
    updateParseResult();
  });

  nextBtn.addEventListener('click', () => {
    if (!store.targets || store.targets.length === 0) return;
    navigate('/action');
  });

  // Always render the parse-result once on mount so the empty state shows
  // its "No server IDs detected" headline immediately (matches Port Scope).
  updateParseResult();
}

// Two-column Name | Server ID preview, same shape as Port Scope's. Up to 25
// rows shown inline; anything beyond collapses into a "+N more" line.
function renderSampleTable(serverIds, nameById) {
  const PREVIEW_LIMIT = 25;
  const rows = serverIds.slice(0, PREVIEW_LIMIT).map((id) => {
    const name = nameById[id];
    return h('tr', {},
      h('td', { class: name ? 'name' : 'name missing' }, name ?? '-'),
      h('td', { class: 'id' }, id)
    );
  });
  const tbody = h('tbody', {}, ...rows);
  const overflow = serverIds.length > PREVIEW_LIMIT
    ? h('div', { class: 'sample-table-overflow' }, `… +${serverIds.length - PREVIEW_LIMIT} more`)
    : null;
  return h('div', { class: 'sample-table-wrap' },
    h('table', { class: 'sample-table' },
      h('thead', {}, h('tr', {},
        h('th', { class: 'name' }, 'Instance name'),
        h('th', { class: 'id' }, 'Server ID')
      )),
      tbody
    ),
    overflow
  );
}
