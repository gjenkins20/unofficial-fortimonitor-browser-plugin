// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Server Lookup - Step 2 (Results) - FMN-113.
// Renders the resolved table and exports a CSV with input/source columns
// so downstream tooling can audit where each server_id came from.

import { h, titleBar, downloadBlob } from '../../../lib/dom.js';
import { lookupBreadcrumbs } from './start.js';

const TOOL_NAME = 'Server Lookup';

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function inputLabel(r) {
  if (r.kind === 'name') return r.name ?? '';
  return r.raw ?? '';
}

/**
 * One row per input. The `source` column carries the parser's classification
 * (url / id / name) so consumers can tell where the server_id came from.
 */
function buildCsv(results) {
  const header = ['input', 'source', 'server_id', 'status', 'match_count', 'detail'];
  const rows = results.map((r) => [
    inputLabel(r),
    r.kind ?? 'name',
    r.status === 'found' ? String(r.serverId ?? '') : '',
    r.status,
    String(r.matches?.length ?? 0),
    r.status === 'error' ? (r.error ?? '') : ''
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
}

function copyToClipboard(text) {
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
    h('h2', {}, `${results.length} entr${results.length === 1 ? 'y' : 'ies'} processed`),
    h('p', {}, summaryParts.join(' · ') || '-')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ---- Per-entry table ----
  const table = h('table', { class: 'review-table' });
  const thead = h('thead', {}, h('tr', {},
    h('th', {}, '#'),
    h('th', {}, 'Input'),
    h('th', {}, 'Source'),
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
      // For URL/ID inputs the server ID was the input; "candidates" is not
      // meaningful, so leave it blank. Names that found exactly one match
      // show "1" so the operator can see the lookup hit cleanly.
      candidatesCell = r.kind === 'name' ? '1' : '-';
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
      h('td', {}, inputLabel(r) || '-'),
      h('td', {}, h('span', { class: `source-tag ${r.kind ?? 'name'}` }, r.kind ?? 'name')),
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
    store.entries = [];
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
