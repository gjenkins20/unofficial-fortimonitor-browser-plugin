// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155: Step 4 - preview + commit.
//
// The preview table is computed client-side using the chosen action's
// describe(target, params) - pure, no network. Commit dispatches
// bulk-composer:commit; per-row events stream in via the events fixture.

import { h, titleBar, downloadBlob } from '../../../lib/dom.js';
import { bulkBreadcrumbs } from './breadcrumbs.js';
import { getAction } from '../../../lib/bulk-actions/index.js';

const TOOL_NAME = 'Bulk Action Composer';

export function render({ container, store, navigate, events, call }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Preview & commit', { toolName: TOOL_NAME }));

  const action = getAction(store.actionId);
  frame.appendChild(h('div', { class: 'step-header' },
    bulkBreadcrumbs('commit'),
    h('h2', {}, `Preview: ${action?.label ?? ''} on ${store.targets.length} instance${store.targets.length === 1 ? '' : 's'}`),
    h('p', {}, 'Each row shows the current state vs. the proposed change. Click Apply to commit with concurrency 3 - per-row status appears here as commits land.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const tableWrap = h('div', {
    class: 'bulk-preview-table-wrap',
    style: 'max-height:420px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;'
  });
  const table = h('table', {
    class: 'bulk-preview-table',
    'data-test': 'bulk-preview-table',
    style: 'width:100%;border-collapse:collapse;font-size:0.85rem;'
  });
  table.appendChild(h('thead', { style: 'background:#fafbfc;position:sticky;top:0;' },
    h('tr', {},
      h('th', { style: thStyle() }, '#'),
      h('th', { style: thStyle() }, 'Instance'),
      h('th', { style: thStyle() }, 'Prev'),
      h('th', { style: thStyle() }, 'Next'),
      h('th', { style: thStyle() }, 'Status')
    )
  ));
  const tbody = h('tbody');
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  body.appendChild(tableWrap);

  // Render preview rows from describe()
  const rowByTargetId = new Map();
  let willChangeCount = 0;
  for (let i = 0; i < store.targets.length; i++) {
    const t = store.targets[i];
    const desc = action ? action.describe(t, store.params) : { prev: '-', next: '-', willChange: false };
    if (desc.willChange) willChangeCount++;
    const statusCell = h('td', { style: tdStyle() },
      h('span', {
        class: 'status pending',
        'data-test': 'preview-status',
        style: `font-size:0.75rem;padding:0.1rem 0.45rem;border-radius:10px;background:${desc.willChange ? '#eef2f7' : '#f1f1f1'};color:${desc.willChange ? 'var(--text)' : 'var(--text-muted)'};`
      }, desc.error ? 'invalid' : (desc.willChange ? 'will change' : 'skip'))
    );
    const tr = h('tr', {
      'data-test': 'bulk-preview-row',
      'data-id': String(t.id ?? ''),
      style: 'border-bottom:1px solid var(--border);'
    },
      h('td', { style: tdStyle() }, String(i + 1)),
      h('td', { style: tdStyle() },
        h('div', { style: 'font-weight:500;' }, t.name || '(no name)'),
        h('div', { class: 'muted', style: 'color:var(--text-muted);font-size:0.72rem;font-family:"SF Mono",Menlo,monospace;' }, t.id != null ? `#${t.id}` : '')
      ),
      h('td', { style: tdStyle() + 'max-width:200px;overflow:hidden;text-overflow:ellipsis;', title: desc.prev || '' }, String(desc.prev ?? '-')),
      h('td', { style: tdStyle() + 'max-width:200px;overflow:hidden;text-overflow:ellipsis;', title: desc.next || '' }, String(desc.next ?? '-')),
      statusCell
    );
    // The detail row hangs underneath in a colspan cell to keep the
    // table compact. Always created so commit-time errors have a place
    // to land; hidden via display:none when there is nothing to show.
    const initialDetailText = desc.note || desc.error || '';
    const detailSpan = h('span', {
      class: 'detail muted',
      'data-test': 'bulk-preview-detail-text',
      style: 'color:var(--text-muted);font-size:0.78rem;white-space:pre-wrap;'
    }, initialDetailText);
    const detailTr = h('tr', {
      'data-test': 'bulk-preview-detail',
      style: 'border-bottom:1px solid var(--border);' + (initialDetailText ? '' : 'display:none;')
    },
      h('td', { colspan: '5', style: tdStyle() + 'padding-top:0;color:var(--text-muted);font-size:0.78rem;' },
        detailSpan
      )
    );
    tbody.appendChild(tr);
    tbody.appendChild(detailTr);
    rowByTargetId.set(t.id, {
      tr,
      detailTr,
      statusEl: statusCell.firstChild,
      detailEl: detailSpan
    });
  }

  const summary = h('div', {
    class: 'bulk-preview-summary',
    'data-test': 'bulk-preview-summary',
    style: 'margin-top:0.7rem;font-size:0.9rem;'
  }, `${willChangeCount} row${willChangeCount === 1 ? '' : 's'} will change · ${store.targets.length - willChangeCount} will skip · ${store.targets.length} total.`);
  body.appendChild(summary);

  // Per-row run state (filled by events / on completion)
  const runSummary = h('div', {
    class: 'bulk-run-summary',
    'data-test': 'bulk-run-summary',
    style: 'margin-top:0.4rem;font-size:0.9rem;color:var(--text-muted);'
  }, '');
  body.appendChild(runSummary);

  // Action bar
  const backBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, '← Back');
  const exportBtn = h('button', { class: 'btn btn-secondary', 'data-test': 'export-csv', type: 'button', disabled: true }, 'Export CSV');
  // FMN-207: when nothing will change, label the button accordingly so
  // the operator doesn't think "Apply to 22 instances" is going to do
  // 22 writes. Button stays enabled for confirmation runs.
  const applyLabel = willChangeCount === 0
    ? `Apply (all ${store.targets.length} will skip)`
    : `Apply to ${willChangeCount} instance${willChangeCount === 1 ? '' : 's'}`;
  const applyBtn = h('button', { class: 'btn btn-primary', 'data-test': 'apply-btn', type: 'button' }, applyLabel);
  const stateLabel = h('span', { class: 'execute-state muted', 'data-test': 'commit-state' }, '');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, stateLabel),
    h('div', { class: 'right' }, backBtn, exportBtn, applyBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  backBtn.addEventListener('click', () => navigate('/configure'));

  // ============================================================
  // Per-row event listener (streams in once commit starts)
  // ============================================================
  let done = 0, succeeded = 0, failed = 0, skipped = 0;
  const total = store.targets.length;
  const unsubscribe = events.on((event, payload) => {
    if (event === 'bulk-composer:row-start') {
      const row = rowByTargetId.get(payload?.id);
      if (row) {
        row.statusEl.textContent = 'running';
        row.statusEl.className = 'status running';
        row.statusEl.style.background = '#fff7cc';
        row.statusEl.style.color = '#7a5b00';
      }
    } else if (event === 'bulk-composer:row-done') {
      const row = rowByTargetId.get(payload?.id);
      if (row) {
        if (payload.status === 'succeeded' && payload.noop) {
          row.statusEl.textContent = 'skip';
          row.statusEl.style.background = '#e6f4ea';
          row.statusEl.style.color = '#1b6033';
        } else if (payload.status === 'succeeded') {
          row.statusEl.textContent = 'committed';
          row.statusEl.style.background = '#d4f0dc';
          row.statusEl.style.color = '#0e5a2b';
        } else {
          row.statusEl.textContent = 'failed';
          row.statusEl.style.background = '#fde0dc';
          row.statusEl.style.color = '#a02216';
          // Surface the real failure reason on the detail row. Falls
          // back to a placeholder if the SW omitted both error and
          // errorStatus so the row never reads as silently broken.
          if (row.detailEl) {
            const parts = [];
            if (payload.error) parts.push(payload.error);
            if (payload.errorStatus) parts.push(`(HTTP ${payload.errorStatus})`);
            row.detailEl.textContent = parts.join(' ') || '(no error message returned)';
            row.detailEl.style.color = '#a02216';
          }
          if (row.detailTr) row.detailTr.style.display = '';
        }
      }
      done++;
      if (payload.status === 'succeeded' && payload.noop) skipped++;
      else if (payload.status === 'succeeded') succeeded++;
      else failed++;
      runSummary.textContent = `${done}/${total} complete · ${succeeded} committed · ${failed} failed · ${skipped} skipped`;
    }
  });

  applyBtn.addEventListener('click', async () => {
    if (applyBtn.disabled) return;
    if (applyBtn.dataset.mode === 'new-job') {
      // FMN-155 QA fix: after a successful commit, the button is repurposed
      // as "Start a new job". Reset the wizard store and navigate back to
      // step 1 so the operator does not have to reload the tool.
      store.targets = [];
      store.actionId = null;
      store.params = {};
      store.runResult = null;
      navigate('/pick');
      return;
    }
    applyBtn.disabled = true;
    backBtn.disabled = true;
    stateLabel.textContent = 'Committing...';
    stateLabel.className = 'execute-state';
    try {
      const result = await call('bulk-composer:commit', {
        actionId: store.actionId,
        params: store.params,
        targets: store.targets.map((t) => ({
          id: t.id,
          name: t.name ?? null,
          tags: Array.isArray(t.tags) ? t.tags : null,
          template_names: Array.isArray(t.template_names) ? t.template_names : null
        })),
        concurrency: 3
      });
      store.runResult = result;
      stateLabel.textContent = `Done in ${msSinceStart(result.startedAt, result.finishedAt)}s · ${result.succeeded} ok · ${result.failed} failed · ${result.noops} skipped`;
      exportBtn.disabled = false;
      // FMN-155 QA fix: re-enable the button and re-label it so the operator
      // has a one-click path back to step 1. Previously the button stayed
      // disabled and there was no way to start over without reloading.
      applyBtn.disabled = false;
      applyBtn.dataset.mode = 'new-job';
      applyBtn.textContent = 'Start a new job';
      applyBtn.classList.remove('btn-primary');
      applyBtn.classList.add('btn-secondary');
      backBtn.disabled = false;
    } catch (err) {
      stateLabel.textContent = `Error: ${err?.message ?? err}`;
      stateLabel.className = 'execute-state error';
      applyBtn.disabled = false;
      backBtn.disabled = false;
    }
  });

  exportBtn.addEventListener('click', () => {
    if (!store.runResult) return;
    const csv = buildCsv(store.runResult);
    downloadBlob(`bulk-composer-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, 'text/csv', csv);
  });

  return () => unsubscribe();
}

function thStyle() {
  return 'padding:0.45rem 0.6rem;text-align:left;font-weight:600;font-size:0.78rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;border-bottom:1px solid var(--border);';
}
function tdStyle() {
  return 'padding:0.4rem 0.6rem;vertical-align:top;';
}

function msSinceStart(start, end) {
  try { return Math.round((new Date(end) - new Date(start)) / 1000); } catch { return '?'; }
}

export function buildCsv(result) {
  const headers = ['id', 'name', 'status', 'outcome', 'template', 'noop', 'error', 'errorStatus'];
  const lines = [headers.join(',')];
  for (const r of (result?.rows ?? [])) {
    lines.push([
      csvField(r.id),
      csvField(r.name),
      csvField(r.status),
      csvField(describeOutcome(r)),
      csvField(extractTemplate(r)),
      csvField(r.noop ? 'true' : 'false'),
      csvField(r.error ?? ''),
      csvField(r.errorStatus ?? '')
    ].join(','));
  }
  return lines.join('\n');
}

// Per-action outcome summary for the CSV. Reads detail.reason +
// detail.template / detail.tag and produces a human-readable string.
// Returns '' when the action doesn't supply enough info (back-compat
// with older actions).
function describeOutcome(row) {
  const d = row?.detail;
  if (!d) return '';
  if (row.status === 'failed') return d.reason || 'failed';
  if (d.reason === 'dry-run') {
    if (d.template?.would_create) return `dry-run: would create+attach "${d.template.name}"`;
    return 'dry-run';
  }
  if (d.reason === 'template-already-attached') return 'already-attached';
  if (d.reason === 'no-matching-cluster') return 'no-matching-cluster';
  if (d.template) {
    const t = d.template;
    if (t.created) return `created+attached (${t.populated_count ?? 0} metric${t.populated_count === 1 ? '' : 's'} populated)`;
    if (t.reused) return 'reused+attached';
    return 'attached';
  }
  if (typeof d.tag === 'string') return d.added ? `tag added: ${d.tag}` : d.removed ? `tag removed: ${d.tag}` : `tag: ${d.tag}`;
  if (d.reason) return d.reason;
  return '';
}

function extractTemplate(row) {
  const d = row?.detail;
  if (!d) return '';
  if (d.template?.name) return d.template.name;
  return '';
}
function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
