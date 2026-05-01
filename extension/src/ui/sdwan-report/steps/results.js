// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SD-WAN Report - Step 3 (Results) - FMN-129.
//
// Renders the matched-metric table (preview), plus a Download CSV /
// Download JSON pair. The JSON shape mirrors the Python BPA script's
// output one-for-one so it can drop into existing pipelines.

import { h, titleBar, downloadBlob } from '../../../lib/dom.js';
import { reportBreadcrumbs } from './start.js';

const TOOL_NAME = 'SD-WAN Report';

// CSV column order mirrors the Python source's CSV_FIELDS list so the
// customer-facing artifact is a drop-in replacement.
const CSV_FIELDS = [
  'server_name',
  'server_fqdn',
  'server_group',
  'interface_name',
  'interface_type',
  'metric_name',
  'metric_type',
  'metric_label',
  'metric_unit',
  'last_value',
  'last_status',
  'last_checked',
  'sla_latency_ms',
  'sla_jitter_ms',
  'sla_loss_pct',
  'sla_status',
  'server_id',
  'metric_id',
  'resource_url',
  'snmp_resource_id'
];

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export function buildCsv(result, reportName) {
  const lines = [];
  lines.push('# Unofficial FortiMonitor Toolkit - SD-WAN Report');
  lines.push('# Author: Gregori Jenkins - https://www.linkedin.com/in/gregorijenkins');
  lines.push(`# Generated: ${result.report_generated ?? new Date().toISOString()}`);
  if (reportName) lines.push(`# Report: ${reportName}`);
  lines.push(`# ${result.total_records} record${result.total_records === 1 ? '' : 's'} matched across ${result.total_servers} server${result.total_servers === 1 ? '' : 's'}`);
  lines.push(CSV_FIELDS.map(csvEscape).join(','));
  for (const r of (result.records ?? [])) {
    lines.push(CSV_FIELDS.map((f) => csvEscape(r[f])).join(','));
  }
  return lines.join('\n');
}

export function buildJson(result, reportName) {
  // Shape mirrors the Python BPA script's output. Keep field names
  // unchanged when adding new fields - extend, don't rename - so any
  // downstream pipeline keyed on the existing shape stays compatible.
  return JSON.stringify({
    report_generated: result.report_generated ?? new Date().toISOString(),
    started_at: result.started_at ?? null,
    report_name: reportName || null,
    total_servers: result.total_servers ?? null,
    total_records: result.total_records ?? (result.records?.length ?? 0),
    records: result.records ?? []
  }, null, 2);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeFilenamePart(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Results', { toolName: TOOL_NAME }));

  const result = store.runResult ?? { records: [], total_records: 0, total_servers: 0 };
  const records = Array.isArray(result.records) ? result.records : [];
  const matchCount = records.length;

  const counts = countByClassification(records);

  frame.appendChild(h('div', { class: 'step-header' },
    reportBreadcrumbs('results'),
    h('h2', {}, `${matchCount} SD-WAN metric${matchCount === 1 ? '' : 's'} matched`),
    h('p', { class: 'muted' },
      `Across ${result.total_servers ?? 0} server${result.total_servers === 1 ? '' : 's'}. `,
      `Overlay ${counts.overlay} · Underlay ${counts.underlay} · Generic ${counts.generic}.`
    )
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  if (matchCount === 0) {
    body.appendChild(h('div', { class: 'parse-result empty' },
      'No SD-WAN metrics matched. Confirm your tenant has FortiGate devices ',
      'monitored, then re-run with custom regex patterns under Advanced if ',
      'your interface naming convention diverges from the FortiGate defaults.'
    ));
  } else {
    body.appendChild(buildPreviewTable(records));
  }

  const downloadCsvBtn = h('button', { class: 'btn btn-secondary', disabled: matchCount === 0 }, 'Download CSV');
  const downloadJsonBtn = h('button', { class: 'btn btn-primary', disabled: matchCount === 0 }, 'Download JSON');
  const newRunBtn = h('button', { class: 'btn btn-secondary' }, 'New report');
  const downloadStatus = h('span', { class: 'muted' }, '');

  downloadCsvBtn.addEventListener('click', () => {
    const fname = filename(store.reportName, 'csv');
    downloadBlob(fname, 'text/csv', buildCsv(result, store.reportName));
    downloadStatus.textContent = `Saved ${fname}`;
  });
  downloadJsonBtn.addEventListener('click', () => {
    const fname = filename(store.reportName, 'json');
    downloadBlob(fname, 'application/json', buildJson(result, store.reportName));
    downloadStatus.textContent = `Saved ${fname}`;
  });
  newRunBtn.addEventListener('click', () => {
    store.runResult = null;
    store.runError = null;
    store.runCancelled = false;
    navigate('/start');
  });

  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, downloadCsvBtn, downloadJsonBtn, downloadStatus),
    h('div', { class: 'right' }, newRunBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);
}

function countByClassification(records) {
  const c = { overlay: 0, underlay: 0, generic: 0 };
  for (const r of records) {
    if (c[r.classification] != null) c[r.classification] += 1;
  }
  return c;
}

function filename(reportName, ext) {
  const slug = safeFilenamePart(reportName);
  const base = slug ? `sdwan-report-${slug}` : 'sdwan-report';
  return `${base}-${timestamp()}.${ext}`;
}

function buildPreviewTable(records) {
  // Cap the on-screen preview at 500 rows so the popup doesn't choke on
  // very large reports. The full set is still in the CSV / JSON files.
  const PREVIEW_LIMIT = 500;
  const slice = records.slice(0, PREVIEW_LIMIT);
  const hidden = records.length - slice.length;

  const cols = [
    { label: 'Server', getter: (r) => r.server_name || r.server_id || '' },
    { label: 'Interface', getter: (r) => r.interface_name || '' },
    { label: 'Class', getter: (r) => r.classification || '' },
    { label: 'Metric', getter: (r) => r.metric_name || '' },
    { label: 'OID type', getter: (r) => r.metric_type_oid || '' },
    { label: 'Latency', getter: (r) => fmtNum(r.sla_latency_ms) },
    { label: 'Jitter', getter: (r) => fmtNum(r.sla_jitter_ms) },
    { label: 'Loss', getter: (r) => fmtNum(r.sla_loss_pct) },
    { label: 'Last value', getter: (r) => fmtNum(r.last_value) }
  ];

  const table = h('table', { class: 'review-table' });
  const thead = h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', {}, c.label))));
  const tbody = h('tbody', {});
  for (const r of slice) {
    const cells = cols.map((c) => h('td', {}, fmtCell(c.getter(r))));
    tbody.appendChild(h('tr', {}, ...cells));
  }
  table.appendChild(thead);
  table.appendChild(tbody);

  const wrap = h('div', {});
  wrap.appendChild(table);
  if (hidden > 0) {
    wrap.appendChild(h('p', { class: 'muted', style: 'margin-top:0.5rem;font-size:0.85rem;' },
      `Preview shows the first ${PREVIEW_LIMIT} rows. ${hidden} additional record${hidden === 1 ? '' : 's'} included in the CSV / JSON downloads.`
    ));
  }
  return wrap;
}

function fmtNum(v) {
  if (v == null) return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  // Two decimals max; trim trailing zeros for readability.
  return n.toFixed(2).replace(/\.?0+$/, '');
}

function fmtCell(v) {
  if (v === '' || v == null) return '-';
  return String(v);
}
