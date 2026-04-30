// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Find Servers - Step 2 (Results) - FMN-114 unified scope.
// Renders the matched server table with operator-chosen columns and exports
// a matching CSV.

import { h, titleBar, downloadBlob } from '../../../lib/dom.js';
import { findBreadcrumbs } from './start.js';
import { listReceivers, writeSelection } from '../../../lib/selection-handoff.js';

const TOOL_NAME = 'Find Servers';

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

const FIELD_LABEL = {
  attribute: 'Attribute',
  name: 'Name',
  fqdn: 'FQDN',
  tag: 'Tag',
  status: 'Status',
  device_type: 'Device type',
  has_active_outage: 'Active outage'
};

function describeCriteria(criteria, mode) {
  if (!Array.isArray(criteria) || criteria.length === 0) return null;
  const joiner = mode === 'any' ? ' OR ' : ' AND ';
  return criteria
    .map((c) => {
      const label = FIELD_LABEL[c.fieldType] ?? c.fieldType;
      if (c.fieldType === 'has_active_outage') return `${label} ${c.value ? '= true' : '= false'}`;
      if (c.fieldType === 'status') return `${label} = "${c.value}"`;
      const op = c.exactMatch ? '=' : '~';
      if (c.fieldType === 'attribute') return `${c.attributeName} ${op} "${c.value}"`;
      return `${label} ${op} "${c.value}"`;
    })
    .join(joiner);
}

function describeSource(source) {
  if (!source) return '';
  if (source.kind === 'name') return `name: ${source.name ?? source.raw ?? ''}`;
  if (source.kind === 'url') return `URL: ${source.raw ?? ''}`;
  if (source.kind === 'id') return `ID: ${source.raw ?? source.serverId ?? ''}`;
  return '';
}

function findAttributeValue(server, name) {
  if (!server || !Array.isArray(server.attributes)) return null;
  const lc = String(name).toLowerCase();
  for (const a of server.attributes) {
    if (String(a?.name ?? '').toLowerCase() === lc) return a.value ?? '';
    if (String(a?.textkey ?? '').toLowerCase() === lc) return a.value ?? '';
  }
  return null;
}

function buildColumnList(columns) {
  // Build the ordered list of {key, label, getter} based on operator
  // selections. ID / Name / FQDN are always present.
  const list = [
    { key: 'id',   label: 'Server ID', getter: (m) => m.id ?? '' },
    { key: 'name', label: 'Name',      getter: (m) => m.name ?? '' },
    { key: 'fqdn', label: 'FQDN',      getter: (m) => m.fqdn ?? '' }
  ];
  if (columns.status)        list.push({ key: 'status',        label: 'Status',          getter: (m) => m.status ?? '' });
  if (columns.tags)          list.push({ key: 'tags',          label: 'Tags',            getter: (m) => Array.isArray(m.tags) ? m.tags.join('|') : '' });
  if (columns.deviceType)    list.push({ key: 'deviceType',    label: 'Device type',     getter: (m) => m.deviceType ?? '' });
  if (columns.deviceSubType) list.push({ key: 'deviceSubType', label: 'Device sub-type', getter: (m) => m.deviceSubType ?? '' });
  if (columns.source)        list.push({ key: 'source',        label: 'Source',          getter: (m) => describeSource(m.source) });
  for (const attrName of (columns.attributes ?? [])) {
    list.push({
      key: `attr:${attrName}`,
      label: attrName,
      getter: (m) => findAttributeValue(m, attrName) ?? ''
    });
  }
  return list;
}

function buildCsv(result, columns) {
  const cols = buildColumnList(columns);
  const lines = [];
  lines.push(`# Unofficial FortiMonitor Toolkit - Find Servers report`);
  lines.push(`# Author: Gregori Jenkins - https://www.linkedin.com/in/gregorijenkins`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  const filt = describeCriteria(result.criteria, result.mode);
  if (filt) lines.push(`# Filter (${result.mode === 'any' ? 'OR' : 'AND'}): ${filt}`);
  if (Array.isArray(result.identifiers) && result.identifiers.length > 0) {
    lines.push(`# Identifiers: ${result.identifiers.length} input${result.identifiers.length === 1 ? '' : 's'}`);
  }
  lines.push(`# ${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} out of ${result.totalScanned} scanned`);
  lines.push(cols.map((c) => c.label).map(csvEscape).join(','));
  for (const m of result.matches) {
    lines.push(cols.map((c) => csvEscape(c.getter(m))).join(','));
  }
  return lines.join('\n');
}

function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('Clipboard API unavailable'));
}

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Results', { toolName: TOOL_NAME }));

  const result = store.runResult ?? { matches: [], totalScanned: 0, criteria: [], identifiers: [], mode: 'all' };
  const matchCount = result.matches.length;
  const cols = buildColumnList(store.columns ?? {});

  const filt = describeCriteria(result.criteria, result.mode);
  const idCount = Array.isArray(result.identifiers) ? result.identifiers.length : 0;
  const subtitleParts = [];
  if (idCount > 0) subtitleParts.push(`${idCount} identifier${idCount === 1 ? '' : 's'}`);
  if (filt) subtitleParts.push(`filter (${result.mode === 'any' ? 'OR' : 'AND'}): ${filt}`);

  frame.appendChild(h('div', { class: 'step-header' },
    findBreadcrumbs('results'),
    h('h2', {}, `${matchCount} server${matchCount === 1 ? '' : 's'} matched`),
    h('p', {}, subtitleParts.join(' · ') || '-'),
    h('p', { class: 'muted' }, `Scanned ${result.totalScanned} server record${result.totalScanned === 1 ? '' : 's'}.`)
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // Selection set for the "Send to" handoff. Default: every matched row
  // is selected. Operator can untick rows or use the header checkbox to
  // toggle all.
  const selectedIds = new Set(result.matches.map((m) => m.id));
  const rowCheckboxes = new Map();   // id -> input
  let headerCheckbox = null;

  function refreshSendToState() {
    const count = selectedIds.size;
    sendToBtn.disabled = count === 0;
    sendToCount.textContent = count > 0 ? ` (${count})` : '';
    if (headerCheckbox) {
      headerCheckbox.checked = count > 0 && count === result.matches.length;
      headerCheckbox.indeterminate = count > 0 && count < result.matches.length;
    }
  }

  if (matchCount === 0) {
    body.appendChild(h('div', { class: 'parse-result empty' }, 'No servers matched.'));
  } else {
    const table = h('table', { class: 'review-table' });
    headerCheckbox = h('input', { type: 'checkbox', class: 'fmn-row-select fmn-row-select-all', checked: true });
    headerCheckbox.addEventListener('change', () => {
      if (headerCheckbox.checked) {
        for (const m of result.matches) selectedIds.add(m.id);
        for (const cb of rowCheckboxes.values()) cb.checked = true;
      } else {
        selectedIds.clear();
        for (const cb of rowCheckboxes.values()) cb.checked = false;
      }
      refreshSendToState();
    });
    const headerRow = h('tr', {},
      h('th', { class: 'fmn-row-select-cell' }, headerCheckbox),
      h('th', {}, '#'),
      ...cols.map((c) => h('th', {}, c.label))
    );
    const thead = h('thead', {}, headerRow);
    const tbody = h('tbody', {});
    result.matches.forEach((m, i) => {
      const cb = h('input', { type: 'checkbox', class: 'fmn-row-select', checked: true });
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(m.id);
        else selectedIds.delete(m.id);
        refreshSendToState();
      });
      rowCheckboxes.set(m.id, cb);
      const cells = [
        h('td', { class: 'fmn-row-select-cell' }, cb),
        h('td', {}, String(i + 1))
      ];
      for (const c of cols) {
        const v = c.getter(m);
        cells.push(h('td', {}, v == null || v === '' ? '-' : String(v)));
      }
      tbody.appendChild(h('tr', {}, ...cells));
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    body.appendChild(table);
  }

  const copyCsvBtn = h('button', { class: 'btn btn-secondary', disabled: matchCount === 0 }, 'Copy CSV');
  const exportCsvBtn = h('button', { class: 'btn btn-secondary', disabled: matchCount === 0 }, 'Download CSV');
  const sendToBtn = h('button', {
    class: 'btn btn-secondary fmn-send-to-btn',
    disabled: matchCount === 0,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false'
  }, 'Send selection to ▾');
  const sendToCount = h('span', { class: 'fmn-send-to-count' }, '');
  sendToBtn.appendChild(sendToCount);
  const sendToMenu = h('div', { class: 'fmn-send-to-menu', role: 'menu', hidden: true });
  for (const r of listReceivers()) {
    const item = h('button', { type: 'button', class: 'fmn-send-to-item', role: 'menuitem' }, r.label);
    item.addEventListener('click', async () => {
      sendToMenu.hidden = true;
      sendToBtn.setAttribute('aria-expanded', 'false');
      const ids = result.matches.filter((m) => selectedIds.has(m.id)).map((m) => m.id);
      const names = result.matches.filter((m) => selectedIds.has(m.id)).map((m) => m.name).filter(Boolean);
      if (ids.length === 0) return;
      try {
        await writeSelection({ receiverId: r.id, ids, names, source: 'find-servers' });
        // Open the receiver tab. Same window as a new tab; receiver
        // start.js consumes the blob on mount.
        const url = chrome.runtime.getURL(r.appPath);
        chrome.tabs.create({ url });
      } catch (err) {
        sendToStatus.textContent = `Send failed: ${err?.message ?? err}`;
      }
    });
    sendToMenu.appendChild(item);
  }
  sendToBtn.addEventListener('click', () => {
    const wasOpen = !sendToMenu.hidden;
    sendToMenu.hidden = wasOpen;
    sendToBtn.setAttribute('aria-expanded', String(!wasOpen));
  });
  // Click-away dismiss.
  document.addEventListener('click', (ev) => {
    if (sendToMenu.hidden) return;
    if (sendToBtn.contains(ev.target) || sendToMenu.contains(ev.target)) return;
    sendToMenu.hidden = true;
    sendToBtn.setAttribute('aria-expanded', 'false');
  });
  const sendToStatus = h('span', { class: 'muted' }, '');
  const refineBtn = h('button', { class: 'btn btn-secondary' }, 'Refine query');
  const newBatchBtn = h('button', { class: 'btn btn-primary' }, 'New search');
  const copyStatus = h('span', { class: 'muted' }, '');

  copyCsvBtn.addEventListener('click', async () => {
    try {
      await copyToClipboard(buildCsv(result, store.columns ?? {}));
      copyStatus.textContent = 'Copied.';
      setTimeout(() => { copyStatus.textContent = ''; }, 2000);
    } catch (err) {
      copyStatus.textContent = `Copy failed: ${err?.message ?? err}`;
    }
  });
  exportCsvBtn.addEventListener('click', () => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(`find-servers-${ts}.csv`, 'text/csv', buildCsv(result, store.columns ?? {}));
  });
  refineBtn.addEventListener('click', () => {
    // Keep query intact; just navigate back so the operator can adjust.
    store.runResult = null;
    navigate('/start');
  });
  newBatchBtn.addEventListener('click', () => {
    store.runResult = null;
    store.identifiersText = '';
    store.criteria = [];
    store.columns = { status: false, tags: false, deviceType: false, deviceSubType: false, source: false, attributes: [] };
    navigate('/start');
  });

  const sendToWrap = h('span', { class: 'fmn-send-to-wrap' }, sendToBtn, sendToMenu);
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, copyCsvBtn, exportCsvBtn, sendToWrap, sendToStatus, copyStatus),
    h('div', { class: 'right' }, refineBtn, newBatchBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);
  refreshSendToState();
}
