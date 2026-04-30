// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Server Lookup - Step 1 (Start) - FMN-113.
// Operator pastes/uploads a list of server names, FortiMonitor frontend
// URLs (/instance/N/...), or raw numeric server IDs - mixed freely.
// "Run lookup" fires the lookup:server-ids call with the structured
// entries, shows per-entry progress inline, then transitions to /results
// when the batch finishes.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { parseInput } from '../parse-input.js';

const TOOL_NAME = 'Server ID Lookup';

export function lookupBreadcrumbs(active) {
  const steps = [
    { id: 'start', label: '1. Load input' },
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

function rebuildPasteValue(entries) {
  if (!entries || !entries.length) return '';
  return entries.map((e) => e.raw).join('\n');
}

function entryLabel(entry) {
  if (entry.kind === 'name') return entry.name;
  if (entry.kind === 'id') return `id ${entry.serverId}`;
  return `URL → id ${entry.serverId}`;
}

export function render({ container, store, navigate, events }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Load input', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    lookupBreadcrumbs('start'),
    h('h2', {}, 'Look up server IDs in bulk'),
    h('p', {}, 'One entry per line. Server names are exact-matched (case-sensitive) against the FortiMonitor v2 API. FortiMonitor instance URLs and server IDs are accepted directly. Names with multiple matches are reported as ambiguous and list all candidates.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ---- File / paste input ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Inputs'));

  const fileInput = h('input', { type: 'file', accept: '.csv,.txt', hidden: true });
  const dropZone = h('label', { class: 'drop-zone' },
    h('div', { class: 'dz-icon' }, '↑'),
    h('div', { class: 'dz-primary' },
      'Drop CSV/TXT here, or ',
      h('span', { class: 'dz-link' }, 'click to browse')
    ),
    h('div', { class: 'dz-secondary' }, 'Accepts .csv or plain text · one entry per line · names, FortiMonitor URLs, or server IDs'),
    fileInput
  );
  body.appendChild(dropZone);

  body.appendChild(h('div', { class: 'divider' }, 'or paste below'));

  const paste = h('textarea', {
    class: 'paste-area',
    placeholder: 'FGVM01TM24006844\nhttps://fortimonitor.forticloud.com/instance/42024060/details\n42024061'
  });
  paste.value = rebuildPasteValue(store.entries);
  body.appendChild(paste);

  body.appendChild(h('div', { class: 'format-hint', html:
    '<strong>Format:</strong> one entry per line. Each line is treated as:' +
    '<ul style="margin:0.4rem 0 0.4rem 1rem;">' +
    '<li><strong>FortiMonitor URL</strong> - the address-bar URL of an instance page.</li>' +
    '<li><strong>Server ID</strong> - a numeric server ID.</li>' +
    '<li><strong>Name</strong> - the server name (resolved by exact match).</li>' +
    '</ul>' +
    'First line may be the literal header <code>name</code> (optional). Duplicates are deduplicated.' +
    '<pre># mixed input\nFGVM01TM24006844\nhttps://fortimonitor.forticloud.com/report/Instance/42024060/details\n42024061</pre>'
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
    if (!result || result.entries.length === 0) {
      parseResult.classList.add('empty');
      parseResult.textContent = 'No input parsed yet.';
      runBtn.disabled = true;
      return;
    }
    const counts = result.entries.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] ?? 0) + 1; return acc; }, {});
    const parts = [];
    if (counts.name) parts.push(`${counts.name} name${counts.name === 1 ? '' : 's'}`);
    if (counts.url)  parts.push(`${counts.url} URL${counts.url === 1 ? '' : 's'}`);
    if (counts.id)   parts.push(`${counts.id} ID${counts.id === 1 ? '' : 's'}`);
    parseResult.appendChild(h('div', { class: 'parse-summary' },
      `${result.entries.length} unique entr${result.entries.length === 1 ? 'y' : 'ies'} ready (${parts.join(' · ') || '-'})`
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
    const parsed = parseInput(paste.value);
    store.entries = parsed.entries;
    store.warnings = parsed.warnings;
    refreshParseDisplay(parsed);
  }

  paste.addEventListener('input', reparse);

  // ---- File upload handling ----
  dropZone.addEventListener('click', (e) => {
    if (e.target === fileInput) e.stopPropagation();
  });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const text = await f.text();
    paste.value = text;
    reparse();
  });
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

  if (paste.value) reparse();

  // ---- Event subscription for inline progress ----
  const rowByLabel = new Map();
  const unsubscribe = events.on((event, payload) => {
    if (event === 'lookup:entry-start') {
      const row = rowByLabel.get(payload.name);
      if (row) {
        row.statusEl.textContent = 'running';
        row.statusEl.className = 'status running';
      }
    } else if (event === 'lookup:entry-done') {
      const row = rowByLabel.get(payload.name);
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
    if (!store.entries.length) return;
    runBtn.disabled = true;
    paste.disabled = true;
    stateLabel.textContent = 'Looking up…';
    stateLabel.className = 'execute-state';

    progressBox.hidden = false;
    progressBox.innerHTML = '';
    rowByLabel.clear();
    for (const entry of store.entries) {
      const label = entryLabel(entry);
      const statusEl = h('span', { class: 'status pending' }, 'pending');
      const detailEl = h('span', { class: 'detail muted' }, '');
      const row = h('div', { class: 'progress-row' },
        h('span', { class: 'serial' }, label),
        statusEl,
        detailEl
      );
      // Key: the handler emits with the entry's *label* for name entries
      // and `raw` for url/id entries. Cover both lookups so events from
      // both kinds find their row.
      rowByLabel.set(entry.kind === 'name' ? entry.name : entry.raw, { statusEl, detailEl });
      progressBox.appendChild(row);
    }

    try {
      const result = await call('lookup:server-ids', {
        entries: store.entries,
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
