// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Server Name → ID Lookup - Step 1 (Start).
// Operator pastes/uploads a list of server names. "Run lookup" fires the
// lookup:server-ids call, shows per-name progress inline, then transitions
// to /results when the batch finishes.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { parseNameList } from '../parse-names.js';

const TOOL_NAME = 'Server Name → ID Lookup';

export function lookupBreadcrumbs(active) {
  const steps = [
    { id: 'start', label: '1. Load names' },
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

function rebuildPasteValue(names) {
  if (!names.length) return '';
  return names.join('\n');
}

export function render({ container, store, navigate, events }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Load Names', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    lookupBreadcrumbs('start'),
    h('h2', {}, 'Paste server names to resolve to IDs'),
    h('p', {}, 'One name per line. Exact, case-sensitive match against the FortiMonitor v2 /server endpoint. Names with multiple matches are reported as ambiguous and list all candidates.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ---- File / paste input ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Server names'));

  const fileInput = h('input', { type: 'file', accept: '.csv,.txt', hidden: true });
  const dropZone = h('label', { class: 'drop-zone' },
    h('div', { class: 'dz-icon' }, '↑'),
    h('div', { class: 'dz-primary' },
      'Drop CSV/TXT here, or ',
      h('span', { class: 'dz-link' }, 'click to browse')
    ),
    h('div', { class: 'dz-secondary' }, 'Accepts .csv or plain text · one name per line'),
    fileInput
  );
  body.appendChild(dropZone);

  body.appendChild(h('div', { class: 'divider' }, 'or paste below'));

  const paste = h('textarea', {
    class: 'paste-area',
    placeholder: 'FGVM01TM24006844\nFGVM01TM24006845\nFGVM01TM24006846'
  });
  paste.value = rebuildPasteValue(store.names);
  body.appendChild(paste);

  body.appendChild(h('div', { class: 'format-hint', html:
    '<strong>Format:</strong> one server name per line. First line may be the literal header <code>name</code> (optional). Duplicates are deduplicated.' +
    '<pre># header optional\nname\nFGVM01TM24006844\nFGVM01TM24006845\n\n# or positional\nFGVM01TM24006844\nFGVM01TM24006845</pre>'
  }));

  const parseResult = h('div', { class: 'parse-result empty' });
  body.appendChild(parseResult);

  // ---- Progress (shown while a run is in flight) ----
  const progressBox = h('div', { class: 'progress-list', hidden: true });
  body.appendChild(progressBox);

  // ---- Action bar ----
  const runBtn = h('button', { class: 'btn btn-primary', disabled: true }, 'Run lookup');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, h('span', { class: 'execute-state muted' }, '')),
    h('div', { class: 'right' }, runBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  const stateLabel = actionBar.querySelector('.execute-state');

  function refreshParseDisplay(result) {
    parseResult.innerHTML = '';
    parseResult.className = 'parse-result';
    if (!result || result.names.length === 0) {
      parseResult.classList.add('empty');
      parseResult.textContent = 'No names parsed yet.';
      runBtn.disabled = true;
      return;
    }
    parseResult.appendChild(h('div', { class: 'parse-summary' },
      `${result.names.length} unique name${result.names.length === 1 ? '' : 's'} ready`
    ));
    if (result.warnings.length) {
      const warnList = h('ul', { class: 'warning-list' },
        ...result.warnings.slice(0, 10).map((w) => h('li', {}, w))
      );
      parseResult.appendChild(h('div', { class: 'warnings' },
        h('strong', {}, `${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}:`),
        warnList,
        result.warnings.length > 10 ? h('div', { class: 'muted' },
          `…and ${result.warnings.length - 10} more`) : null
      ));
    }
    runBtn.disabled = false;
  }

  function reparse() {
    const parsed = parseNameList(paste.value);
    store.names = parsed.names;
    store.warnings = parsed.warnings;
    refreshParseDisplay(parsed);
  }

  paste.addEventListener('input', reparse);

  // ---- File upload handling ----
  dropZone.addEventListener('click', (e) => {
    // Clicking the label triggers the input; no manual dispatch needed.
    if (e.target === fileInput) e.stopPropagation();
  });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const text = await f.text();
    paste.value = text;
    reparse();
  });
  // Drag-and-drop
  ['dragover', 'dragenter'].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    dropZone.addEventListener(ev, () => dropZone.classList.remove('drag'));
  });
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const text = await f.text();
    paste.value = text;
    reparse();
  });

  // Initial parse if the store has names from a previous mount.
  if (paste.value) reparse();

  // ---- Event subscription for inline progress ----
  const rowByName = new Map();
  const unsubscribe = events.on((event, payload) => {
    if (event === 'lookup:entry-start') {
      const row = rowByName.get(payload.name);
      if (row) {
        row.statusEl.textContent = 'running';
        row.statusEl.className = 'status running';
      }
    } else if (event === 'lookup:entry-done') {
      const row = rowByName.get(payload.name);
      if (row) {
        row.statusEl.textContent = payload.status;
        row.statusEl.className = `status ${payload.status}`;
        if (payload.status === 'found') {
          row.detailEl.textContent = `id ${payload.serverId}`;
          row.detailEl.className = 'detail muted';
        } else if (payload.status === 'ambiguous') {
          row.detailEl.textContent = `${payload.matchCount} matches`;
          row.detailEl.className = 'detail warn';
        } else if (payload.status === 'not_found') {
          row.detailEl.textContent = 'no match';
          row.detailEl.className = 'detail muted';
        } else if (payload.status === 'error') {
          row.detailEl.textContent = payload.error ?? '(error)';
          row.detailEl.className = 'detail error';
        }
      }
    }
  });

  runBtn.addEventListener('click', async () => {
    if (!store.names.length) return;
    runBtn.disabled = true;
    paste.disabled = true;
    stateLabel.textContent = 'Looking up…';
    stateLabel.className = 'execute-state';

    // Render a pending row per unique name so the user sees progress.
    progressBox.hidden = false;
    progressBox.innerHTML = '';
    rowByName.clear();
    for (const name of store.names) {
      const statusEl = h('span', { class: 'status pending' }, 'pending');
      const detailEl = h('span', { class: 'detail muted' }, '');
      const row = h('div', { class: 'progress-row' },
        h('span', { class: 'serial' }, name),
        statusEl,
        detailEl
      );
      rowByName.set(name, { statusEl, detailEl });
      progressBox.appendChild(row);
    }

    try {
      const result = await call('lookup:server-ids', {
        names: store.names,
        concurrency: 4
      });
      store.runResult = result;
      stateLabel.textContent = 'Done';
      setTimeout(() => navigate('/results'), 400);
    } catch (err) {
      stateLabel.textContent = `Error: ${err?.message ?? err}`;
      stateLabel.className = 'execute-state error';
      runBtn.disabled = false;
      paste.disabled = false;
    }
  });

  return () => unsubscribe();
}
