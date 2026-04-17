// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Manage Server Attributes — Step 2 (Preview).
// Build the per-row plan by resolving names → ids and fetching each
// server's current attribute value. Operator reviews before executing.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { attrBreadcrumbs } from './start.js';

const TOOL_NAME = 'Manage Server Attributes (Bulk)';

const PLAN_LABELS = {
  add: 'ADD',
  replace: 'REPLACE',
  remove: 'REMOVE',
  skip: 'SKIP',
  error: 'ERROR',
  pending: 'pending…'
};
const PLAN_CLASSES = {
  add: 'plan-pill add',
  replace: 'plan-pill replace',
  remove: 'plan-pill remove',
  skip: 'plan-pill skip',
  error: 'plan-pill error',
  pending: 'plan-pill skip'
};

function renderRow(i, row) {
  const cells = [
    h('td', { class: 'col-n' }, String(i + 1))
  ];

  if (row.status === 'error' || row.plan === 'error') {
    cells.push(
      h('td', { class: 'col-server' }, row.input || row.displayName || '—'),
      h('td', { colspan: 2, class: 'col-error' }, row.error || 'Resolution error'),
      h('td', { class: 'col-plan' }, h('span', { class: PLAN_CLASSES.error }, PLAN_LABELS.error))
    );
  } else {
    const label = row.displayName && row.displayName !== String(row.serverId)
      ? `${row.displayName}  #${row.serverId}`
      : `#${row.serverId}`;
    const current = row.existing?.value ?? row.currentValue ?? null;
    cells.push(
      h('td', { class: 'col-server' }, label),
      h('td', { class: 'col-before' }, current ?? '—'),
      h('td', { class: 'col-after' }, row.newValue ?? (row.plan === 'remove' ? '(removed)' : '—')),
      h('td', { class: 'col-plan' },
        h('span', { class: PLAN_CLASSES[row.plan] || PLAN_CLASSES.pending }, PLAN_LABELS[row.plan] || row.plan)
      )
    );
  }

  return h('tr', { class: row.plan === 'error' ? 'error-row' : row.plan === 'skip' ? 'skip-row' : '' }, ...cells);
}

function summarize(rows) {
  const counts = { add: 0, replace: 0, remove: 0, skip: 0, error: 0 };
  for (const r of rows) {
    const k = r.plan in counts ? r.plan : 'error';
    counts[k]++;
  }
  return counts;
}

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Preview plan', { toolName: TOOL_NAME, runningDot: !store.plan }));

  frame.appendChild(h('div', { class: 'step-header' },
    attrBreadcrumbs('preview'),
    h('h2', {}, store.operation === 'set'
      ? `Set ${store.typeName || 'attribute'} = "${store.value}" on ${store.entries.length} server${store.entries.length === 1 ? '' : 's'}`
      : `Remove ${store.typeName || 'attribute'} from ${store.entries.length} server${store.entries.length === 1 ? '' : 's'}`
    ),
    h('p', {}, 'Resolving names and fetching current values… Review before executing.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const summaryBar = h('div', { class: 'summary-bar' }, 'Working…');
  body.appendChild(summaryBar);

  const table = h('table', { class: 'preview-table' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'col-n' }, '#'),
      h('th', {}, 'Server'),
      h('th', {}, 'Current'),
      h('th', {}, 'New'),
      h('th', { class: 'col-plan' }, 'Plan')
    )),
    h('tbody', {})
  );
  body.appendChild(h('div', { class: 'table-wrap' }, table));
  const tbody = table.querySelector('tbody');

  const backBtn = h('button', { class: 'btn btn-secondary' }, '← Back');
  const execBtn = h('button', { class: 'btn btn-primary', disabled: true }, 'Execute →');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, h('span', { class: 'muted' }, 'Nothing is written yet.')),
    h('div', { class: 'right' }, backBtn, execBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  backBtn.addEventListener('click', () => navigate('/start'));

  // ---- Run the plan on entry ----
  (async () => {
    try {
      const { plan } = await call('attr:plan-batch', {
        operation: store.operation,
        typeUrl: store.typeUrl,
        value: store.value,
        entries: store.entries
      });
      store.plan = plan;

      while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
      plan.forEach((row, i) => tbody.appendChild(renderRow(i, row)));

      const c = summarize(plan);
      const actionable = c.add + c.replace + c.remove;
      summaryBar.textContent =
        `${plan.length} target${plan.length === 1 ? '' : 's'} · ` +
        `${c.add} add · ${c.replace} replace · ${c.remove} remove · ${c.skip} skip · ${c.error} error`;
      execBtn.disabled = actionable === 0;
      execBtn.textContent = actionable === 0
        ? 'Nothing to do'
        : `Execute on ${actionable} server${actionable === 1 ? '' : 's'} →`;
    } catch (err) {
      summaryBar.className = 'summary-bar error';
      summaryBar.textContent = `Plan failed: ${err?.message ?? err}`;
    }
  })();

  execBtn.addEventListener('click', () => {
    if (!store.plan) return;
    navigate('/execute');
  });
}
