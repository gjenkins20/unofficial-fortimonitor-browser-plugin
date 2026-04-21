// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Manage Server Templates - Step 3 (Execute).
// Apply the plan; stream per-row progress via events.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { tmplBreadcrumbs } from './start.js';

const TOOL_NAME = 'Manage Server Templates (Bulk)';

export function render({ container, store, navigate, events }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Execute', { toolName: TOOL_NAME, runningDot: true }));

  frame.appendChild(h('div', { class: 'step-header' },
    tmplBreadcrumbs('execute'),
    h('h2', {}, `Applying ${store.plan.length} row${store.plan.length === 1 ? '' : 's'}`),
    h('p', {}, 'Writing to api2.panopta.com. Partial failures do not abort the batch.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const progressList = h('div', { class: 'progress-list' });
  body.appendChild(progressList);

  const rowByInput = new Map();
  for (const row of store.plan) {
    const label = row.displayName || row.input || '-';
    const detail = row.plan === 'attach' ? `attach (continuous=${store.continuous})`
      : row.plan === 'detach' ? 'detach (dissociate)'
      : row.plan === 'destroy' ? 'detach (delete - wipes metrics)'
      : row.plan === 'skip' ? 'skip (pre-flight matched target state)'
      : row.plan === 'error' ? (row.error || 'resolution error')
      : row.plan;
    const initial = row.plan === 'skip' ? 'skipped' : row.plan === 'error' ? 'error' : 'pending';
    const statusEl = h('span', { class: `status ${initial}` }, initial);
    const detailEl = h('span', { class: 'detail muted' }, detail);
    const rowEl = h('div', { class: 'progress-row' },
      h('span', { class: 'serial' }, label),
      h('span', { class: 'ip' }, ''),
      statusEl,
      detailEl
    );
    rowByInput.set(row.input, { statusEl, detailEl });
    progressList.appendChild(rowEl);
  }

  const summary = h('div', { class: 'execute-summary' }, '');
  body.appendChild(summary);

  const abortBtn = h('button', { class: 'btn btn-secondary' }, 'Abort');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, h('span', { class: 'execute-state' }, 'Running…')),
    h('div', { class: 'right' }, abortBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  const stateLabel = actionBar.querySelector('.execute-state');
  let done = 0, succeeded = 0, failed = 0, skipped = 0;
  const total = store.plan.length;

  const unsubscribe = events.on((event, payload) => {
    if (event === 'tmpl:exec-start') {
      const r = rowByInput.get(payload.input);
      if (r && r.statusEl.textContent === 'pending') {
        r.statusEl.textContent = 'running';
        r.statusEl.className = 'status running';
      }
    } else if (event === 'tmpl:exec-done') {
      const r = rowByInput.get(payload.input);
      if (r) {
        r.statusEl.textContent = payload.status;
        r.statusEl.className = `status ${payload.status}`;
        if (payload.status === 'failed') {
          r.detailEl.textContent = payload.error ?? '';
          r.detailEl.className = 'detail error';
        }
      }
      done++;
      if (payload.status === 'succeeded') succeeded++;
      else if (payload.status === 'skipped') skipped++;
      else failed++;
      summary.textContent = `${done}/${total} complete · ${succeeded} ok · ${failed} failed · ${skipped} skipped`;
    }
  });

  abortBtn.addEventListener('click', async () => {
    abortBtn.disabled = true;
    try { await call('tmpl:abort', {}); } catch { /* no-op */ }
  });

  call('tmpl:execute-batch', {
    plan: store.plan,
    templateUrl: store.templateUrl,
    templateId: store.templateId,
    continuous: store.continuous,
    strategy: store.strategy,
    concurrency: 4
  }).then((result) => {
    store.runResult = result;
    stateLabel.textContent = 'Done';
    abortBtn.textContent = 'View results →';
    abortBtn.disabled = false;
    abortBtn.onclick = () => navigate('/results');
    setTimeout(() => navigate('/results'), 600);
  }).catch((err) => {
    stateLabel.textContent = `Error: ${err?.message ?? err}`;
    abortBtn.textContent = 'Back to Preview';
    abortBtn.disabled = false;
    abortBtn.onclick = () => navigate('/preview');
  });

  return () => unsubscribe();
}
