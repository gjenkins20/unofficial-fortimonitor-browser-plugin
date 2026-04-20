// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Search Servers — Step 2 (Results).
// Renders the matched server table and exports a CSV of server_id, name,
// fqdn — the report the operator asked for.

import { h, titleBar, downloadBlob } from '../../../lib/dom.js';
import { searchBreadcrumbs } from './start.js';

const TOOL_NAME = 'Search Servers';

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function buildCsv(result) {
  const lines = [];
  lines.push(`# Unofficial FortiMonitor Toolkit — Search Servers report`);
  lines.push(`# Author: Gregori Jenkins — https://www.linkedin.com/in/gregorijenkins`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push(`# Term: ${result.term} — caseInsensitive=${result.caseInsensitive}`);
  lines.push(`# ${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} out of ${result.totalScanned} scanned`);
  lines.push(['server_id', 'name', 'fqdn', 'additional_fqdns', 'device_type', 'device_sub_type', 'matched_field', 'matched_value']
    .map(csvEscape).join(','));
  for (const m of result.matches) {
    lines.push([
      m.id ?? '',
      m.name ?? '',
      m.fqdn ?? '',
      (m.additionalFqdns ?? []).join('|'),
      m.deviceType ?? '',
      m.deviceSubType ?? '',
      m.matchedField ?? '',
      m.matchedValue ?? ''
    ].map(csvEscape).join(','));
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

  const result = store.runResult ?? { term: '', matches: [], totalScanned: 0 };
  const matchCount = result.matches.length;

  frame.appendChild(h('div', { class: 'step-header' },
    searchBreadcrumbs('results'),
    h('h2', {}, `${matchCount} match${matchCount === 1 ? '' : 'es'} for "${result.term}"`),
    h('p', {}, `Scanned ${result.totalScanned} server record${result.totalScanned === 1 ? '' : 's'}.`)
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  if (matchCount === 0) {
    body.appendChild(h('div', { class: 'parse-result empty' }, 'No servers matched.'));
  } else {
    const table = h('table', { class: 'review-table' });
    const thead = h('thead', {}, h('tr', {},
      h('th', {}, '#'),
      h('th', {}, 'Server ID'),
      h('th', {}, 'Name'),
      h('th', {}, 'FQDN'),
      h('th', {}, 'Matched field'),
      h('th', {}, 'Matched value')
    ));
    const tbody = h('tbody', {});
    result.matches.forEach((m, i) => {
      tbody.appendChild(h('tr', {},
        h('td', {}, String(i + 1)),
        h('td', {}, m.id != null ? String(m.id) : '—'),
        h('td', {}, m.name ?? '—'),
        h('td', {}, m.fqdn ?? '—'),
        h('td', {}, h('span', { class: 'muted' }, m.matchedField ?? '—')),
        h('td', {}, m.matchedValue ?? '—')
      ));
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    body.appendChild(table);
  }

  const copyCsvBtn = h('button', { class: 'btn btn-secondary', disabled: matchCount === 0 }, 'Copy CSV');
  const exportCsvBtn = h('button', { class: 'btn btn-secondary', disabled: matchCount === 0 }, 'Download CSV');
  const newBatchBtn = h('button', { class: 'btn btn-primary' }, 'New search');
  const copyStatus = h('span', { class: 'muted' }, '');

  copyCsvBtn.addEventListener('click', async () => {
    try {
      await copyToClipboard(buildCsv(result));
      copyStatus.textContent = 'Copied.';
      setTimeout(() => { copyStatus.textContent = ''; }, 2000);
    } catch (err) {
      copyStatus.textContent = `Copy failed: ${err?.message ?? err}`;
    }
  });
  exportCsvBtn.addEventListener('click', () => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTerm = (result.term || 'search').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
    downloadBlob(`server-search-${safeTerm}-${ts}.csv`, 'text/csv', buildCsv(result));
  });
  newBatchBtn.addEventListener('click', () => {
    store.runResult = null;
    navigate('/start');
  });

  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, copyCsvBtn, exportCsvBtn, copyStatus),
    h('div', { class: 'right' }, newBatchBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);
}
