// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Best-Practice Assessment viewer - 11-tab review surface (FMN-133).
//
// Each tab declares a list of "sections" (a section is a labelled
// table). The viewer renders each section as an HTML <table>; the
// per-tab "Download CSV" button concatenates every section into a
// single CSV with a comment-style section header line per section.
//
// Annotation columns (the operator-editable cells on User Activity)
// flow into store.annotations.{storeKey}.{rowKey} and are exported
// alongside the rest of the row.

import { h, downloadBlob } from '../../lib/dom.js';
import { downloadZip } from '../../lib/zip.js';
import { printReport, pdfFilename } from '../../lib/bpa-pdf.js';
import {
  buildExecutiveSummary,
  buildFeatureUtilization,
  buildRecommendations,
  buildLabs,
  buildRawCounts
} from '../../lib/bpa-synthesis.js';

// =============================================================================
// CSV helpers
// =============================================================================

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Render a tab to CSV. Each non-empty section becomes a labelled block
 * with a comment header line and the standard CSV table below it.
 */
export function buildTabCsv(tab, ctx, { generatedAt = new Date().toISOString(), customer = '' } = {}) {
  const lines = [];
  lines.push('# Unofficial FortiMonitor Toolkit - Best-Practice Assessment');
  lines.push(`# Tab: ${tab.label}`);
  if (customer) lines.push(`# Customer: ${customer}`);
  lines.push(`# Generated: ${generatedAt}`);
  lines.push('');
  for (const section of tab.sections) {
    const rows = section.rows(ctx) ?? [];
    if (rows.length === 0 && !section.alwaysIncludeHeader) continue;
    if (section.label) {
      lines.push(`# ${section.label}`);
    }
    const cols = section.columns;
    lines.push(cols.map((c) => csvEscape(c.header)).join(','));
    for (const row of rows) {
      const cells = cols.map((c) => csvEscape(csvCellValue(c, row, ctx)));
      lines.push(cells.join(','));
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function csvCellValue(col, row, ctx) {
  // FMN-135: when annotation.skipIf returns true for this row, treat the
  // column as a plain getter column. This lets a column be both an
  // editable manual-entry field (when no data) and a populated read-only
  // field (when an upstream source filled it in).
  const skipAnnotation = col.annotation?.skipIf?.(row) === true;
  if (col.annotation && !skipAnnotation) {
    const rowKey = col.annotation.rowKey(row);
    return ctx.annotations?.[col.annotation.storeKey]?.[rowKey] ?? '';
  }
  return col.getter ? col.getter(row) : '';
}

function timestampPart(d = new Date()) {
  // YYYYMMDD - matches the FMN-133 spec.
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function safeFilenamePart(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function tabFilename(tab, customer) {
  const slugCustomer = safeFilenamePart(customer);
  const prefix = slugCustomer || 'best-practice-assessment';
  return `${prefix}_${tab.filenamePart}_${timestampPart()}.csv`;
}

/**
 * Build the entries list for the combined ZIP download. One CSV per tab,
 * named so the operator can extract and rename without ambiguity.
 *
 * @param {object} ctx     viewer context: { inventory, analysis, customer, annotations }
 * @param {{ generatedAt?: string, customer?: string }} [options]
 * @returns {{ filename: string, content: string }[]}
 */
export function buildCombinedZipEntries(ctx, { generatedAt = new Date().toISOString(), customer = '' } = {}) {
  const entries = [];
  for (const tab of getTabs()) {
    entries.push({
      filename: `${String(tab.filenamePart)}.csv`,
      content: buildTabCsv(tab, ctx, { generatedAt, customer })
    });
  }
  // README so the customer-facing recipient knows what's inside.
  entries.unshift({
    filename: 'README.txt',
    content: combinedReadme(customer, generatedAt)
  });
  return entries;
}

function combinedReadme(customer, generatedAt) {
  const lines = [
    'Unofficial FortiMonitor Toolkit - Best-Practice Assessment',
    'Built by Gregori Jenkins - https://www.linkedin.com/in/gregorijenkins',
    '',
    customer ? `Customer: ${customer}` : '',
    `Generated: ${generatedAt}`,
    '',
    'Contents (one CSV per assessment tab):',
    ''
  ].filter((l) => l !== null);
  for (const tab of getTabs()) {
    lines.push(`  ${tab.filenamePart}.csv  -  ${tab.label}`);
  }
  lines.push('');
  lines.push('Each CSV begins with comment lines (# prefix) describing the tab,');
  lines.push('followed by one or more sections. Each section has its own column');
  lines.push('header row. Open in Excel / Numbers / Sheets - the comment lines');
  lines.push('are ignored by most parsers but human-readable when the file is');
  lines.push('opened as plain text.');
  return lines.join('\n');
}

export function combinedZipFilename(customer) {
  const slug = safeFilenamePart(customer);
  const prefix = slug || 'best-practice-assessment';
  return `${prefix}_best-practice-assessment_${timestampPart()}.zip`;
}

// =============================================================================
// Tab definitions
// =============================================================================
//
// Each tab:
//   {
//     id,
//     label,           // shown in the tab strip
//     filenamePart,    // CSV filename middle slot
//     sections: [{
//       label?,        // optional h3 + CSV section comment
//       columns: [{ key, header, getter, annotation? }],
//       rows: (ctx) => Row[],
//       emptyText?,    // shown when rows is empty
//       alwaysIncludeHeader?: bool   // include in CSV even when empty
//     }]
//   }

const TABS = [
  // 1. Executive Summary -----------------------------------------------------
  {
    id: 'executive-summary',
    label: 'Executive Summary',
    filenamePart: 'executive-summary',
    sections: [{
      label: 'Instance Overview',
      columns: [
        { key: 'key',   header: 'Field', getter: (r) => r.key },
        { key: 'value', header: 'Value', getter: (r) => r.value }
      ],
      rows: ({ inventory, analysis, customer }) =>
        buildExecutiveSummary(inventory, analysis, customer)
    }]
  },

  // 2. Feature Utilization --------------------------------------------------
  {
    id: 'feature-utilization',
    label: 'Feature Utilization',
    filenamePart: 'feature-utilization',
    sections: [
      {
        label: 'Actively Used Features',
        columns: [
          { key: 'feature',    header: 'Feature',    getter: (r) => r.feature },
          { key: 'count',      header: 'Count',      getter: (r) => r.count },
          { key: 'assessment', header: 'Assessment', getter: (r) => r.assessment }
        ],
        rows: ({ inventory }) => buildFeatureUtilization(inventory).active,
        emptyText: 'No actively used features detected.'
      },
      {
        label: 'Underutilized Features',
        columns: [
          { key: 'feature',    header: 'Feature',     getter: (r) => r.feature },
          { key: 'count',      header: 'Count',       getter: (r) => r.count },
          { key: 'assessment', header: 'Gap Analysis', getter: (r) => r.assessment }
        ],
        rows: ({ inventory }) => buildFeatureUtilization(inventory).underutilized,
        emptyText: 'No underutilized features detected.'
      }
    ]
  },

  // 3. Incident Summary -----------------------------------------------------
  {
    id: 'incident-summary',
    label: 'Incident Summary',
    filenamePart: 'incident-summary',
    sections: [
      {
        label: 'Top by Instance',
        columns: [
          { key: 'server', header: 'Server', getter: (r) => r.key },
          { key: 'count',  header: 'Count',  getter: (r) => r.count }
        ],
        rows: ({ analysis }) => analysis?.incidents?.top_by_instance ?? []
      },
      {
        label: 'Top by Type',
        columns: [
          { key: 'type',  header: 'Type',  getter: (r) => r.key },
          { key: 'count', header: 'Count', getter: (r) => r.count }
        ],
        rows: ({ analysis }) => analysis?.incidents?.top_by_type ?? []
      },
      {
        label: 'Trending',
        columns: [
          { key: 'metric', header: 'Metric', getter: (r) => r.key },
          { key: 'value',  header: 'Value',  getter: (r) => r.value }
        ],
        rows: ({ analysis }) => {
          const t = analysis?.incidents?.trending;
          if (!t) return [];
          return [
            { key: 'Last 7 days',         value: t.last_7d },
            { key: 'Prior week (est.)',   value: t.prior_week_est },
            { key: 'Week change',         value: t.week_change },
            { key: 'Week trend',          value: t.week_trend },
            { key: 'Last 30 days',        value: t.last_30d },
            { key: 'Prior month (est.)',  value: t.prior_month_est },
            { key: 'Month change',        value: t.month_change },
            { key: 'Month trend',         value: t.month_trend },
            { key: 'Critical (7d)',       value: t.critical_7d },
            { key: 'Warning (7d)',        value: t.warning_7d },
            { key: 'Critical (30d)',      value: t.critical_30d },
            { key: 'Warning (30d)',       value: t.warning_30d }
          ];
        }
      },
      {
        label: 'Noisy Metrics',
        columns: [
          { key: 'server',  header: 'Server',         getter: (r) => r.server },
          { key: 'total',   header: 'Total Incidents', getter: (r) => r.total_incidents },
          { key: 'short',   header: 'Short-Lived',    getter: (r) => r.short_lived },
          { key: 'rec',     header: 'Recommendation', getter: (r) => r.recommendation }
        ],
        rows: ({ analysis }) => analysis?.incidents?.noisy_metrics ?? [],
        emptyText: 'No noisy metric sources detected.'
      }
    ]
  },

  // 4. Incidents -------------------------------------------------------------
  {
    id: 'incidents',
    label: 'Incidents',
    filenamePart: 'incidents',
    sections: [{
      label: 'Active Incidents',
      columns: [
        { key: 'server',       header: 'Server',       getter: (r) => r.server },
        { key: 'id',           header: 'Incident ID',  getter: (r) => r.id },
        { key: 'severity',     header: 'Severity',     getter: (r) => r.severity },
        { key: 'acknowledged', header: 'Acknowledged', getter: (r) => r.acknowledged ? 'yes' : 'no' },
        { key: 'started',      header: 'Started',      getter: (r) => r.started }
      ],
      rows: ({ analysis }) => analysis?.incidents?.active_details ?? [],
      emptyText: 'No active incidents.'
    }]
  },

  // 5. User Activity ---------------------------------------------------------
  {
    id: 'user-activity',
    label: 'User Activity',
    filenamePart: 'user-activity',
    sections: [{
      label: 'Users',
      columns: [
        { key: 'name',    header: 'Name',           getter: (r) => r.name },
        { key: 'email',   header: 'Email',          getter: (r) => r.email },
        { key: 'created', header: 'Created (API)',  getter: (r) => r.created },
        { key: 'created_on', header: 'Created On (UI)', getter: (r) => r.created_on || '' },
        { key: 'methods', header: 'Contact Methods',getter: (r) => r.contact_methods },
        {
          // FMN-135: column is now dual-mode. When the frontend fetcher
          // populated last_login (UI toggle on, EditUser walked
          // successfully), the cell renders as plain text from the
          // getter. When it didn't, the cell falls back to the original
          // manual-annotation input behavior, so engineers can still
          // hand-fill the column for v2-only audits.
          key: 'last_login',
          header: 'Last Login',
          getter: (r) => r.last_login,
          annotation: {
            storeKey: 'user_last_login',
            rowKey: (r) => String(r.id),
            skipIf: (r) => Boolean(r.last_login && !r.last_login_manual)
          }
        },
        {
          // FMN-135: derived from last_login age (Active / Stale /
          // Inactive / Never / Unknown), no longer a manual entry.
          key: 'active_assessment',
          header: 'Active Assessment',
          getter: (r) => r.active_assessment
        }
      ],
      rows: ({ analysis }) => analysis?.users?.details ?? []
    }, {
      label: 'Issues',
      columns: [
        { key: 'issue', header: 'Issue', getter: (r) => r }
      ],
      rows: ({ analysis }) => (analysis?.users?.issues ?? []),
      emptyText: 'No user-related issues detected.'
    }]
  },

  // 6. Instance Analysis -----------------------------------------------------
  {
    id: 'instance-analysis',
    label: 'Instance Analysis',
    filenamePart: 'instance-analysis',
    sections: [
      {
        label: 'Missing Settings (peer-comparison)',
        columns: [
          { key: 'server_id',   header: 'Server ID',      getter: (r) => r.server_id },
          { key: 'server_name', header: 'Server Name',    getter: (r) => r.server_name },
          { key: 'missing',     header: 'Missing',        getter: (r) => r.missing },
          { key: 'type',        header: 'Type',           getter: (r) => r.type },
          { key: 'rec',         header: 'Recommendation', getter: (r) => r.recommendation }
        ],
        rows: ({ analysis }) => {
          const inst = analysis?.instances;
          if (!inst?.available) return [];
          return inst.missing_settings ?? [];
        },
        emptyText: 'Run with deep mode for instance analysis (Step 1 → "Run per-server deep analysis").'
      },
      {
        label: 'Valueless Metrics',
        columns: [
          { key: 'server_id',   header: 'Server ID',      getter: (r) => r.server_id },
          { key: 'server_name', header: 'Server Name',    getter: (r) => r.server_name },
          { key: 'metric',      header: 'Metric',         getter: (r) => r.metric },
          { key: 'rec',         header: 'Recommendation', getter: (r) => r.recommendation }
        ],
        rows: ({ analysis }) => {
          const inst = analysis?.instances;
          if (!inst?.available) return [];
          return inst.valueless_metrics ?? [];
        }
      }
    ]
  },

  // 7. Template Recommendations ---------------------------------------------
  // FMN-135 follow-up (2026-05-01): the default-only / cleanup / overlap
  // analyses run on CUSTOM templates only. FortiMonitor's stock "Default
  // Monitoring Templates" group is exempted - those templates get their
  // own informational section with a soft recommendation to build custom
  // templates rather than editing the stock ones.
  {
    id: 'template-recommendations',
    label: 'Template Recommendations',
    filenamePart: 'template-recommendations',
    sections: [
      {
        label: 'Custom Templates Without Thresholds',
        columns: [
          { key: 'template',          header: 'Template',           getter: (r) => r.template },
          { key: 'resource_count',    header: 'Metric Count',       getter: (r) => r.resource_count },
          { key: 'rec',               header: 'Recommendation',     getter: (r) => r.recommendation }
        ],
        rows: ({ analysis }) => analysis?.templates?.default_only_templates ?? [],
        emptyText: 'No custom templates found without thresholds. Best practice: build custom templates with thresholds tuned to your environment - FortiMonitor stock templates provide metric coverage but no alerting on their own.'
      },
      {
        label: 'Manual Threshold Candidates',
        columns: [
          { key: 'metric', header: 'Metric',     getter: (r) => r.metric_type },
          { key: 'warn',   header: 'Warning',    getter: (r) => r.warning_threshold },
          { key: 'crit',   header: 'Critical',   getter: (r) => r.critical_threshold },
          { key: 'count',  header: 'Server Count', getter: (r) => r.server_count },
          { key: 'examples', header: 'Examples', getter: (r) => r.example_servers },
          { key: 'rec',    header: 'Recommendation', getter: (r) => r.recommendation }
        ],
        rows: ({ analysis }) => analysis?.templates?.manual_threshold_candidates ?? [],
        emptyText: 'No manual threshold candidates - no metric patterns indicate the tenant would benefit from manual thresholds. (Requires deep mode; if you ran a quick assessment, re-run with "Run per-server deep analysis" enabled to surface candidates.)'
      },
      {
        label: 'Custom Templates Cleanup Candidates',
        columns: [
          { key: 'template', header: 'Template',         getter: (r) => r.template },
          { key: 'unchanged', header: 'Unalerted Metrics', getter: (r) => r.unchanged_metrics },
          { key: 'total',    header: 'Total Metrics',    getter: (r) => r.total_metrics },
          { key: 'examples', header: 'Examples',         getter: (r) => r.examples },
          { key: 'rec',      header: 'Recommendation',   getter: (r) => r.recommendation }
        ],
        rows: ({ analysis }) => analysis?.templates?.cleanup_candidates ?? [],
        emptyText: 'No custom-template cleanup candidates - custom templates that carry alerts cover most of their metrics.'
      },
      {
        label: 'Custom Template Overlap',
        columns: [
          { key: 't1',      header: 'Template 1',  getter: (r) => r.template_1 },
          { key: 't2',      header: 'Template 2',  getter: (r) => r.template_2 },
          { key: 'overlap', header: 'Overlap %',   getter: (r) => r.overlap_pct },
          { key: 'shared',  header: 'Shared',      getter: (r) => r.shared_metrics },
          { key: 'rec',     header: 'Recommendation', getter: (r) => r.recommendation }
        ],
        rows: ({ analysis }) => analysis?.templates?.overlapping_templates ?? [],
        emptyText: 'No overlapping custom templates - templates cover distinct metric sets without significant duplication.'
      },
      {
        label: 'Default Templates (FortiMonitor stock)',
        columns: [
          { key: 'template', header: 'Template',     getter: (r) => r.template },
          { key: 'metric_count', header: 'Metrics',  getter: (r) => r.metric_count },
          { key: 'alerts_count', header: 'Alerts Set', getter: (r) => r.alerts_count },
          { key: 'rec',      header: 'Recommendation', getter: (r) => r.recommendation }
        ],
        rows: ({ analysis }) => analysis?.templates?.default_templates ?? [],
        emptyText: 'No FortiMonitor stock default templates detected. (The default group is identified by the name "Default Monitoring Templates"; if your tenant uses different naming, default templates appear under the custom sections above.)'
      }
    ]
  },

  // 8. Monitoring Policy Workflow -------------------------------------------
  {
    id: 'monitoring-policy',
    label: 'Monitoring Policy',
    filenamePart: 'monitoring-policy',
    sections: [
      {
        label: 'Naming Patterns',
        columns: [
          { key: 'pattern',  header: 'Pattern',  getter: (r) => r.pattern },
          { key: 'count',    header: 'Match Count', getter: (r) => r.match_count },
          { key: 'examples', header: 'Examples', getter: (r) => r.examples },
          { key: 'sug',      header: 'Suggestion', getter: (r) => r.suggestion }
        ],
        rows: ({ analysis }) => analysis?.monitoring_policy?.naming_patterns ?? []
      },
      {
        label: 'Group → Template Mapping',
        columns: [
          { key: 'group',     header: 'Group',         getter: (r) => r.group },
          { key: 'members',   header: 'Members',       getter: (r) => r.member_count },
          { key: 'has',       header: 'Has Template?', getter: (r) => r.has_template ? 'yes' : 'no' },
          { key: 'template',  header: 'Template',      getter: (r) => r.template },
          { key: 'rec',       header: 'Recommendation', getter: (r) => r.recommendation }
        ],
        rows: ({ analysis }) => analysis?.monitoring_policy?.group_template_mapping ?? []
      },
      {
        label: 'Suggested Automation Rules',
        columns: [
          { key: 'rule',     header: 'Rule',         getter: (r) => r.rule },
          { key: 'desc',     header: 'Description',  getter: (r) => r.description },
          { key: 'affected', header: 'Affected',     getter: (r) => r.affected },
          { key: 'rec',      header: 'Recommendation', getter: (r) => r.recommendation }
        ],
        rows: ({ analysis }) => analysis?.monitoring_policy?.automation_rules ?? []
      }
    ]
  },

  // 9. Recommendations -------------------------------------------------------
  {
    id: 'recommendations',
    label: 'Recommendations',
    filenamePart: 'recommendations',
    sections: [{
      label: 'Prioritized Recommendations',
      columns: [
        { key: 'priority', header: 'Priority', getter: (r) => r.priority },
        { key: 'text',     header: 'Recommendation', getter: (r) => r.text }
      ],
      rows: ({ inventory, analysis }) => buildRecommendations(inventory, analysis),
      emptyText: 'No recommendations - looks healthy on the dimensions this assessment checks.'
    }]
  },

  // 10. Recommended Labs -----------------------------------------------------
  {
    id: 'recommended-labs',
    label: 'Recommended Labs',
    filenamePart: 'recommended-labs',
    sections: [{
      label: 'Quick labs (15-25 min) for underutilized features',
      columns: [
        { key: 'title',   header: 'Lab Title', getter: (r) => r.title },
        { key: 'time',    header: 'Time',      getter: (r) => r.time },
        { key: 'feature', header: 'Feature',   getter: (r) => r.feature },
        { key: 'steps',   header: 'Steps',     getter: (r) => r.steps }
      ],
      rows: ({ inventory }) => buildLabs(inventory)
    }]
  },

  // 11. Raw Counts ----------------------------------------------------------
  {
    id: 'raw-counts',
    label: 'Raw Counts',
    filenamePart: 'raw-counts',
    sections: [{
      label: 'Resource Counts',
      columns: [
        { key: 'resource', header: 'Resource', getter: (r) => r.resource },
        { key: 'count',    header: 'Count',    getter: (r) => r.count }
      ],
      rows: ({ inventory }) => buildRawCounts(inventory)
    }]
  }
];

export function getTabs() {
  return TABS;
}

// =============================================================================
// DOM render
// =============================================================================

/**
 * Render the full viewer. Returns a teardown function.
 *
 * @param {object} args
 * @param {HTMLElement} args.root
 * @param {object} args.store - the wizard store (provides annotations + customerName + runResult)
 */
export function renderViewer({ root, store }) {
  const result = store.runResult ?? {};
  const inventory = result.inventory ?? {};
  const analysis = result.analysis ?? {};
  const customer = store.customerName ?? '';
  if (!store.annotations || typeof store.annotations !== 'object') store.annotations = {};

  const ctx = () => ({
    inventory,
    analysis,
    customer,
    annotations: store.annotations
  });

  // Top action bar: combined-report download (ZIP + PDF)
  const filenameStatus = h('span', { class: 'muted', style: 'font-size:0.85rem;margin-left:0.6rem;' }, '');
  const combinedBtn = h('button', {
    class: 'btn btn-primary',
    'data-test': 'download-combined-report'
  }, 'Download Combined Report (ZIP)');
  combinedBtn.addEventListener('click', () => {
    const entries = buildCombinedZipEntries(ctx(), { customer });
    const fname = combinedZipFilename(customer);
    downloadZip(fname, entries);
    filenameStatus.textContent = `Saved ${fname}`;
  });

  // FMN-136: PDF print via hidden iframe + browser print dialog. The
  // cover-page checkbox is opt-in; default behavior is a plain print of
  // all 11 sections without a cover or TOC.
  const coverCheckbox = h('input', {
    type: 'checkbox',
    'data-test': 'pdf-cover-toggle',
    style: 'margin-right:0.3rem;'
  });
  const coverLabel = h('label', {
    style: 'font-size:0.85rem;display:inline-flex;align-items:center;cursor:pointer;'
  }, coverCheckbox, 'Cover page + TOC');
  const pdfBtn = h('button', {
    class: 'btn btn-secondary',
    'data-test': 'download-combined-pdf'
  }, 'Download PDF (Full Report)');
  pdfBtn.addEventListener('click', () => {
    printReport(ctx(), { customer, coverPage: coverCheckbox.checked });
    filenameStatus.textContent = `Opening print dialog (suggested: ${pdfFilename(customer)})`;
  });

  root.appendChild(h('div', {
    class: 'viewer-toolbar',
    style: 'display:flex;align-items:center;gap:0.6rem;margin-bottom:0.6rem;flex-wrap:wrap;'
  },
    combinedBtn,
    pdfBtn,
    coverLabel,
    h('span', { class: 'muted', style: 'font-size:0.85rem;' },
      'ZIP packs all 11 tabs as CSVs plus a README. PDF opens the print dialog - choose "Save as PDF" as destination.'
    ),
    filenameStatus
  ));

  // Tab strip
  const strip = h('div', {
    class: 'tab-strip',
    role: 'tablist',
    style: 'display:flex;flex-wrap:wrap;gap:0.4rem;border-bottom:1px solid #ddd;margin-bottom:0.6rem;'
  });
  // Active tab pane
  const pane = h('div', { class: 'tab-pane', 'data-test': 'tab-pane' });

  const tabButtons = new Map();
  for (const tab of TABS) {
    const btn = h('button', {
      class: 'tab-btn',
      role: 'tab',
      'data-tab': tab.id,
      style: 'padding:0.4rem 0.8rem;border:1px solid #ccc;background:#fff;cursor:pointer;border-radius:4px 4px 0 0;'
    }, tab.label);
    btn.addEventListener('click', () => activate(tab.id));
    strip.appendChild(btn);
    tabButtons.set(tab.id, btn);
  }

  function activate(id) {
    const tab = TABS.find((t) => t.id === id) ?? TABS[0];
    for (const [otherId, btn] of tabButtons) {
      const isActive = otherId === tab.id;
      btn.style.background = isActive ? '#1f4e79' : '#fff';
      btn.style.color = isActive ? '#fff' : '#000';
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    pane.innerHTML = '';
    pane.appendChild(renderTab(tab, ctx, store, filenameStatus, customer));
  }

  root.appendChild(strip);
  root.appendChild(pane);

  activate(TABS[0].id);
  return () => { /* no-op teardown - DOM lives inside container */ };
}

function renderTab(tab, ctx, store, filenameStatus, customer) {
  const wrap = h('div', {});
  const ctxNow = ctx();

  // Header bar with title + Download CSV
  const downloadBtn = h('button', { class: 'btn btn-secondary' }, 'Download CSV');
  downloadBtn.addEventListener('click', () => {
    const csv = buildTabCsv(tab, ctx(), { customer });
    const fname = tabFilename(tab, customer);
    downloadBlob(fname, 'text/csv', csv);
    filenameStatus.textContent = `Saved ${fname}`;
  });

  wrap.appendChild(h('div', {
    style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:0.6rem;'
  },
    h('h2', { style: 'margin:0;' }, tab.label),
    downloadBtn
  ));

  // Optional global filter input - applies to every section's first column
  const filterInput = h('input', {
    type: 'search',
    placeholder: 'Filter rows...',
    style: 'min-width:0;width:100%;max-width:18rem;padding:0.3rem 0.5rem;border:1px solid #ccc;border-radius:4px;margin-bottom:0.5rem;'
  });
  wrap.appendChild(filterInput);

  const sectionsWrap = h('div', {});
  wrap.appendChild(sectionsWrap);

  function renderSections() {
    sectionsWrap.innerHTML = '';
    const filter = filterInput.value.trim().toLowerCase();
    for (const section of tab.sections) {
      const block = h('div', { class: 'review-section', style: 'margin-bottom:1.2rem;' });
      if (section.label) block.appendChild(h('h3', { class: 'subhead', style: 'margin-bottom:0.3rem;' }, section.label));
      let rows = section.rows(ctxNow) ?? [];
      if (filter && rows.length > 0) {
        rows = rows.filter((row) => sectionMatchesFilter(section, row, filter));
      }
      if (rows.length === 0) {
        block.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;' },
          section.emptyText ?? 'No rows.'
        ));
        sectionsWrap.appendChild(block);
        continue;
      }
      block.appendChild(renderTable(section, rows, store));
      sectionsWrap.appendChild(block);
    }
  }

  filterInput.addEventListener('input', renderSections);
  renderSections();

  return wrap;
}

function sectionMatchesFilter(section, row, filter) {
  for (const col of section.columns) {
    const v = col.annotation
      ? '' // annotations aren't filtered (they're user-typed scratch)
      : col.getter(row);
    if (v != null && String(v).toLowerCase().includes(filter)) return true;
  }
  return false;
}

function renderTable(section, rows, store) {
  const table = h('table', { class: 'review-table' });
  const thead = h('thead', {}, h('tr', {}, ...section.columns.map((c) => h('th', {}, c.header))));
  const tbody = h('tbody', {});
  for (const row of rows) {
    tbody.appendChild(h('tr', {}, ...section.columns.map((c) => renderCell(c, row, store))));
  }
  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

function renderCell(col, row, store) {
  const skipAnnotation = col.annotation?.skipIf?.(row) === true;
  if (col.annotation && !skipAnnotation) {
    const rowKey = col.annotation.rowKey(row);
    const storeBucket = store.annotations[col.annotation.storeKey] ?? {};
    if (!store.annotations[col.annotation.storeKey]) {
      store.annotations[col.annotation.storeKey] = storeBucket;
    }
    const input = h('input', {
      type: 'text',
      class: 'annotation-input',
      style: 'min-width:0;width:100%;padding:0.2rem 0.4rem;border:1px solid #ccc;border-radius:3px;'
    });
    input.value = storeBucket[rowKey] ?? '';
    input.addEventListener('input', () => {
      storeBucket[rowKey] = input.value;
    });
    return h('td', {}, input);
  }
  const v = col.getter ? col.getter(row) : '';
  return h('td', {}, fmtCell(v));
}

function fmtCell(v) {
  if (v === '' || v == null) return '-';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  // Preserve newlines (the labs steps use \n).
  if (typeof v === 'string' && v.includes('\n')) {
    const out = document.createElement('span');
    out.style.whiteSpace = 'pre-wrap';
    out.textContent = v;
    return out;
  }
  return String(v);
}
