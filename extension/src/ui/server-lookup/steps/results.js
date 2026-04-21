// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Server Name → ID Lookup - Step 2 (Results).
// Renders the resolved table and exports a minimal two-column
// name,server_id CSV that drops cleanly into other tools.

import { h, titleBar, downloadBlob } from '../../../lib/dom.js';
import { lookupBreadcrumbs } from './start.js';

const TOOL_NAME = 'Server Name → ID Lookup';

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Build the CSV the user asked for: one row per input name, with the
 * server_id if there was exactly one match. Ambiguous/not_found/error
 * rows have an empty server_id so the file is a safe drop-in for other
 * tools - the status column preserves the distinction for humans.
 */
function buildCsv(results) {
  const header = ['name', 'server_id', 'status', 'match_count', 'detail'];
  const rows = results.map((r) => [
    r.name,
    r.status === 'found' ? String(r.serverId) : '',
    r.status,
    String(r.matches?.length ?? 0),
    r.status === 'error' ? (r.error ?? '') : ''
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
}

function copyToClipboard(text) {
  // Prefer the async clipboard API - extension pages have permission by
  // default when triggered by a user gesture.
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error('Clipboard API unavailable'));
}

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Results', { toolName: TOOL_NAME }));

  const results = store.runResult?.results ?? [];
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  const summaryParts = [];
  if (counts.found) summaryParts.push(`${counts.found} found`);
  if (counts.ambiguous) summaryParts.push(`${counts.ambiguous} ambiguous`);
  if (counts.not_found) summaryParts.push(`${counts.not_found} not found`);
  if (counts.error) summaryParts.push(`${counts.error} error${counts.error === 1 ? '' : 's'}`);

  frame.appendChild(h('div', { class: 'step-header' },
    lookupBreadcrumbs('results'),
    h('h2', {}, `${results.length} name${results.length === 1 ? '' : 's'} resolved`),
    h('p', {}, summaryParts.join(' · ') || '-')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ---- Per-name table ----
  const table = h('table', { class: 'review-table' });
  const thead = h('thead', {}, h('tr', {},
    h('th', {}, '#'),
    h('th', {}, 'Name'),
    h('th', {}, 'Status'),
    h('th', {}, 'Server ID'),
    h('th', {}, 'Candidates')
  ));
  const tbody = h('tbody', {});
  results.forEach((r, i) => {
    let idCell = '-';
    let candidatesCell = '-';
    if (r.status === 'found') {
      idCell = String(r.serverId);
      candidatesCell = '1';
    } else if (r.status === 'ambiguous') {
      const list = (r.matches ?? []).map((m) => `${m.id}`).join(', ');
      candidatesCell = `${r.matches?.length ?? 0}: ${list}`;
    } else if (r.status === 'not_found') {
      candidatesCell = '0';
    } else if (r.status === 'error') {
      candidatesCell = r.error ?? '(error)';
    }
    tbody.appendChild(h('tr', {},
      h('td', {}, String(i + 1)),
      h('td', {}, r.name),
      h('td', {}, h('span', { class: `status ${r.status}` }, r.status)),
      h('td', {}, idCell),
      h('td', {}, candidatesCell)
    ));
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  body.appendChild(table);

  // ---- Export / copy ----
  const copyCsvBtn = h('button', { class: 'btn btn-secondary' }, 'Copy CSV');
  const exportCsvBtn = h('button', { class: 'btn btn-secondary' }, 'Download CSV');
  const newBatchBtn = h('button', { class: 'btn btn-primary' }, 'Look up another list');
  const copyStatus = h('span', { class: 'muted' }, '');

  copyCsvBtn.addEventListener('click', async () => {
    try {
      await copyToClipboard(buildCsv(results));
      copyStatus.textContent = 'Copied.';
      setTimeout(() => { copyStatus.textContent = ''; }, 2000);
    } catch (err) {
      copyStatus.textContent = `Copy failed: ${err?.message ?? err}`;
    }
  });
  exportCsvBtn.addEventListener('click', () => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(`server-lookup-${ts}.csv`, 'text/csv', buildCsv(results));
  });
  newBatchBtn.addEventListener('click', () => {
    store.runResult = null;
    store.names = [];
    store.warnings = [];
    store.executeProgress = new Map();
    navigate('/start');
  });

  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, copyCsvBtn, exportCsvBtn, copyStatus),
    h('div', { class: 'right' }, newBatchBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);
}
