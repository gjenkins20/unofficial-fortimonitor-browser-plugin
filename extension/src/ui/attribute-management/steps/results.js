// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Manage Server Attributes - Step 4 (Results).
// Final grid with per-(server, attribute) outcome. Download CSV or
// start over.

import { h, titleBar, downloadBlob } from '../../../lib/dom.js';
import { attrBreadcrumbs } from './start.js';

const TOOL_NAME = 'Manage Server Attributes (Bulk)';

const STATUS_CLASS = {
  succeeded: 'plan-pill add',
  skipped: 'plan-pill skip',
  failed: 'plan-pill error',
  error: 'plan-pill error'
};

function attrLabel(row) {
  return row.typeName || row.typeUrl?.split('/').filter(Boolean).pop() || '?';
}

function toCsv(rows) {
  const header = [
    'input', 'server_id', 'display_name',
    'attribute_key', 'attribute_url',
    'plan', 'status',
    'current_value', 'new_value',
    'created_id', 'deleted_id', 'error'
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    const cells = [
      r.input ?? '',
      r.serverId ?? '',
      r.displayName ?? '',
      attrLabel(r),
      r.typeUrl ?? '',
      r.plan ?? '',
      r.status ?? '',
      r.existing?.value ?? '',
      r.newValue ?? '',
      r.created ?? '',
      r.deleted ?? '',
      (r.error ?? '').replace(/"/g, '""')
    ].map((v) => {
      const s = String(v);
      return /[,"\n]/.test(s) ? `"${s}"` : s;
    });
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

export function render({ container, store, navigate }) {
  const rows = store.runResult?.results ?? [];
  const counts = { succeeded: 0, skipped: 0, failed: 0, error: 0 };
  for (const r of rows) counts[r.status in counts ? r.status : 'error']++;

  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Results', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    attrBreadcrumbs('results'),
    h('h2', {}, `${counts.succeeded} succeeded · ${counts.failed + counts.error} failed · ${counts.skipped} skipped`),
    h('p', {}, `Run started ${store.runResult?.startedAt ?? ''} · finished ${store.runResult?.finishedAt ?? ''}.`)
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const table = h('table', { class: 'preview-table' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'col-n' }, '#'),
      h('th', {}, 'Server'),
      h('th', {}, 'Attribute'),
      h('th', {}, 'Plan'),
      h('th', {}, 'Status'),
      h('th', {}, 'Detail')
    )),
    h('tbody', {})
  );
  const tbody = table.querySelector('tbody');
  rows.forEach((r, i) => {
    const label = r.displayName
      ? (r.serverId ? `${r.displayName}  #${r.serverId}` : r.displayName)
      : (r.input || '-');
    const detail = r.status === 'failed'
      ? (r.error || '')
      : r.status === 'error'
      ? (r.error || 'Resolution error')
      : r.status === 'skipped'
      ? (r.plan === 'error' ? (r.error || 'resolution error') : 'already matched target state')
      : r.plan === 'add' && r.created != null
      ? `created id ${r.created}`
      : r.plan === 'replace' && r.created != null
      ? `replaced → id ${r.created}`
      : r.plan === 'remove' && r.deleted != null
      ? `removed id ${r.deleted}`
      : '';
    tbody.appendChild(h('tr', {
      class: r.status === 'failed' || r.status === 'error' ? 'error-row' : r.status === 'skipped' ? 'skip-row' : ''
    },
      h('td', { class: 'col-n' }, String(i + 1)),
      h('td', { class: 'col-server' }, label),
      h('td', { class: 'col-attr' }, attrLabel(r)),
      h('td', {}, r.plan || '-'),
      h('td', {}, h('span', { class: STATUS_CLASS[r.status] || 'plan-pill skip' }, r.status)),
      h('td', { class: 'col-before' }, detail)
    ));
  });
  body.appendChild(h('div', { class: 'table-wrap' }, table));

  const csvBtn = h('button', { class: 'btn btn-secondary' }, 'Download CSV');
  const againBtn = h('button', { class: 'btn btn-secondary' }, 'Start over');
  const closeBtn = h('button', { class: 'btn btn-primary' }, 'Close');
  frame.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, h('span', { class: 'muted' }, 'You can close this tab - results are not persisted.')),
    h('div', { class: 'right' }, csvBtn, againBtn, closeBtn)
  ));
  container.appendChild(frame);

  csvBtn.addEventListener('click', () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(`attribute-management-${stamp}.csv`, 'text/csv', toCsv(rows));
  });
  againBtn.addEventListener('click', () => {
    store.plan = null;
    store.runResult = null;
    navigate('/start');
  });
  closeBtn.addEventListener('click', () => window.close());
}
