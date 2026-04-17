// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Add Fabric Connection — Step 4 (Results).
// Final per-device outcome with export buttons.

import { h, titleBar, downloadBlob } from '../../../lib/dom.js';
import { fcBreadcrumbs } from './start.js';

const TOOL_NAME = 'Add Fabric Connection (API)';

function buildCsv(results) {
  const header = ['serial', 'ip', 'port', 'status', 'attempts', 'resource_id', 'error'];
  const rows = results.map((r) => [
    r.device.serial,
    r.device.ip,
    String(r.device.port),
    r.status,
    String(r.attempts),
    r.value?.resourceId ?? '',
    (r.error ?? '').replace(/"/g, '""')
  ]);
  return [header, ...rows].map((row) => row.map((c) => `"${c}"`).join(',')).join('\n');
}

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  const dryRunSuffix = store.dryRun ? ' (dry-run)' : '';
  frame.appendChild(titleBar(`Results${dryRunSuffix}`, { toolName: TOOL_NAME }));

  const results = store.runResult?.results ?? [];
  const succeeded = results.filter((r) => r.status === 'succeeded').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  frame.appendChild(h('div', { class: 'step-header' },
    fcBreadcrumbs('results'),
    h('h2', {}, store.dryRun
      ? `${results.length} payload${results.length === 1 ? '' : 's'} built (no API calls made)`
      : `${succeeded} created · ${failed} failed`),
    h('p', {}, store.dryRun
      ? 'No fabric connections were created. Switch to Live mode in Review to actually POST.'
      : `Started ${store.runResult?.startedAt ?? ''}, finished ${store.runResult?.finishedAt ?? ''}.`)
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ---- Per-device table ----
  const table = h('table', { class: 'review-table' });
  const thead = h('thead', {}, h('tr', {},
    h('th', {}, '#'),
    h('th', {}, 'Serial'),
    h('th', {}, 'IP:Port'),
    h('th', {}, 'Status'),
    h('th', {}, 'Attempts'),
    h('th', {}, 'Detail')
  ));
  const tbody = h('tbody', {});
  results.forEach((r, i) => {
    let detail = '—';
    if (r.status === 'failed') detail = r.error ?? '(no error message)';
    else if (r.value?.resourceId) detail = `id ${r.value.resourceId}`;
    else if (r.dryRun) detail = 'preview built';
    tbody.appendChild(h('tr', {},
      h('td', {}, String(i + 1)),
      h('td', {}, r.device.serial),
      h('td', {}, `${r.device.ip}:${r.device.port}`),
      h('td', {}, h('span', { class: `status ${r.status}` }, r.status)),
      h('td', {}, String(r.attempts)),
      h('td', {}, detail)
    ));
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  body.appendChild(table);

  // ---- Export ----
  const exportJsonBtn = h('button', { class: 'btn btn-secondary' }, 'Export JSON');
  const exportCsvBtn = h('button', { class: 'btn btn-secondary' }, 'Export CSV');
  const newBatchBtn = h('button', { class: 'btn btn-primary' }, 'Run another batch');

  exportJsonBtn.addEventListener('click', () => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(`fabric-connection-results-${ts}.json`, 'application/json',
      JSON.stringify({ ...store.runResult, dryRun: store.dryRun }, null, 2));
  });
  exportCsvBtn.addEventListener('click', () => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(`fabric-connection-results-${ts}.csv`, 'text/csv', buildCsv(results));
  });
  newBatchBtn.addEventListener('click', () => {
    // Reset run-specific state but keep targets so the operator can re-run
    // with a new device list against the same OnSight + server group.
    store.runResult = null;
    store.devices = [];
    store.warnings = [];
    store.dryRun = true;
    store.confirmationPhrase = null;
    navigate('/start');
  });

  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, exportJsonBtn, exportCsvBtn),
    h('div', { class: 'right' }, newBatchBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);
}
