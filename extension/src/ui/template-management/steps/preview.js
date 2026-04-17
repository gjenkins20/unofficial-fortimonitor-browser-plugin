// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Manage Server Templates — Step 2 (Preview).
// Resolve names → ids, fetch each server's current mappings, decide
// attach / detach / skip per row. Destructive detach requires typed
// confirmation before the Execute button unlocks.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { tmplBreadcrumbs } from './start.js';

const TOOL_NAME = 'Manage Server Templates (Bulk)';

const PLAN_LABELS = {
  attach: 'ATTACH',
  detach: 'DETACH',
  destroy: 'DELETE',
  skip: 'SKIP',
  error: 'ERROR',
  pending: 'pending…'
};
const PLAN_CLASSES = {
  attach: 'plan-pill add',
  detach: 'plan-pill replace',
  destroy: 'plan-pill remove',
  skip: 'plan-pill skip',
  error: 'plan-pill error',
  pending: 'plan-pill skip'
};

function renderRow(i, row) {
  const cells = [h('td', { class: 'col-n' }, String(i + 1))];
  if (row.status === 'error' || row.plan === 'error') {
    cells.push(
      h('td', { class: 'col-server' }, row.input || row.displayName || '—'),
      h('td', { colspan: 1, class: 'col-error' }, row.error || 'Resolution error'),
      h('td', { class: 'col-plan' }, h('span', { class: PLAN_CLASSES.error }, PLAN_LABELS.error))
    );
  } else {
    const label = row.displayName && row.displayName !== String(row.serverId)
      ? `${row.displayName}  #${row.serverId}`
      : `#${row.serverId}`;
    const current = row.attached
      ? `attached (continuous=${row.attached.continuous})`
      : 'not attached';
    cells.push(
      h('td', { class: 'col-server' }, label),
      h('td', { class: 'col-before' }, current),
      h('td', { class: 'col-plan' },
        h('span', { class: PLAN_CLASSES[row.plan] || PLAN_CLASSES.pending }, PLAN_LABELS[row.plan] || row.plan)
      )
    );
  }
  return h('tr', { class: row.plan === 'error' ? 'error-row' : row.plan === 'skip' ? 'skip-row' : '' }, ...cells);
}

function summarize(rows) {
  const counts = { attach: 0, detach: 0, destroy: 0, skip: 0, error: 0 };
  for (const r of rows) {
    const k = r.plan in counts ? r.plan : 'error';
    counts[k]++;
  }
  return counts;
}

function confirmationPhrase(operation, strategy, actionableCount) {
  if (operation === 'detach' && strategy === 'delete') return 'DELETE METRICS';
  if (operation === 'attach' && actionableCount > 10) return `ATTACH ${actionableCount} SERVERS`;
  if (operation === 'detach' && actionableCount > 10) return `DETACH ${actionableCount} SERVERS`;
  return null;
}

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Preview plan', { toolName: TOOL_NAME, runningDot: !store.plan }));

  const opVerb = store.operation === 'attach' ? 'Attach' : 'Detach';
  frame.appendChild(h('div', { class: 'step-header' },
    tmplBreadcrumbs('preview'),
    h('h2', {}, `${opVerb} ${store.templateName || 'template'} on ${store.entries.length} server${store.entries.length === 1 ? '' : 's'}`),
    h('p', {}, store.operation === 'detach' && store.strategy === 'delete'
      ? 'Pre-flighting each server… Detach strategy = DELETE (metrics and attributes the template added will be wiped).'
      : 'Pre-flighting each server via GET /server/{id}/template… Review before executing.'
    )
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const summaryBar = h('div', { class: 'summary-bar' }, 'Working…');
  body.appendChild(summaryBar);

  const table = h('table', { class: 'preview-table' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'col-n' }, '#'),
      h('th', {}, 'Server'),
      h('th', {}, 'Currently'),
      h('th', { class: 'col-plan' }, 'Plan')
    )),
    h('tbody', {})
  );
  body.appendChild(h('div', { class: 'table-wrap' }, table));
  const tbody = table.querySelector('tbody');

  // Typed-confirmation block (only rendered if the plan meets the gate
  // criteria; see confirmationPhrase above).
  const confirmWrap = h('div', { class: 'confirm-block', hidden: true });
  body.appendChild(confirmWrap);

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
      const { plan } = await call('tmpl:plan-batch', {
        operation: store.operation,
        templateUrl: store.templateUrl,
        templateId: store.templateId,
        entries: store.entries
      });
      store.plan = plan;

      while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
      plan.forEach((row, i) => tbody.appendChild(renderRow(i, row)));

      const c = summarize(plan);
      const actionable = c.attach + c.detach + c.destroy;
      summaryBar.textContent =
        `${plan.length} target${plan.length === 1 ? '' : 's'} · ` +
        `${c.attach} attach · ${c.detach + c.destroy} detach · ${c.skip} skip · ${c.error} error`;

      if (store.operation === 'detach' && store.strategy === 'delete' && actionable > 0) {
        summaryBar.className = 'summary-bar error';
      }

      const phrase = confirmationPhrase(store.operation, store.strategy, actionable);
      if (actionable === 0) {
        execBtn.disabled = true;
        execBtn.textContent = 'Nothing to do';
      } else if (phrase) {
        // Destructive or large — require typed confirmation.
        const isDestructive = store.operation === 'detach' && store.strategy === 'delete';
        confirmWrap.hidden = false;
        confirmWrap.className = isDestructive ? 'confirm-block danger' : 'confirm-block';
        confirmWrap.innerHTML = '';
        confirmWrap.appendChild(h('div', { class: 'warn-head' },
          isDestructive ? '⚠ Destructive operation' : '⚠ Large batch'
        ));
        confirmWrap.appendChild(h('div', { class: 'warn-body' },
          isDestructive
            ? `You are about to detach "${store.templateName}" from ${actionable} server${actionable === 1 ? '' : 's'} using strategy=delete. This removes metrics and attributes the template seeded — metric history on those counters will be wiped. Switch to Dissociate on the previous step if you meant the safe path.`
            : `${actionable} servers will be ${store.operation === 'attach' ? 'attached to' : 'detached from'} "${store.templateName}". Confirm below to proceed.`
        ));
        const confirmInput = h('input', { type: 'text', placeholder: phrase, class: 'confirm-input' });
        confirmWrap.appendChild(h('div', { class: 'typed-row' },
          h('span', {}, 'Type '),
          h('code', { class: isDestructive ? 'confirm-code danger' : 'confirm-code' }, phrase),
          h('span', {}, ' to confirm:'),
          confirmInput
        ));
        execBtn.textContent = isDestructive
          ? `Execute DELETE on ${actionable} →`
          : `Execute on ${actionable} →`;
        if (isDestructive) execBtn.classList.add('btn-danger');
        confirmInput.addEventListener('input', () => {
          execBtn.disabled = confirmInput.value.trim() !== phrase;
        });
        execBtn.disabled = true;
      } else {
        execBtn.disabled = false;
        execBtn.textContent = `Execute on ${actionable} server${actionable === 1 ? '' : 's'} →`;
      }
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
