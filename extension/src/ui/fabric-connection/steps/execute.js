// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Add Fabric Connection - Step 3 (Execute).
// Trigger 'fc:create-batch' on entry. Subscribe to fc:entry-start /
// fc:entry-done events to render per-device progress.

import { h, titleBar } from '../../../lib/dom.js';
import { call } from '../../../lib/messaging.js';
import { fcBreadcrumbs } from './start.js';

const TOOL_NAME = 'Add Fabric Connection (API)';

export function render({ container, store, navigate, events }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar(store.dryRun ? 'Execute (dry-run)' : 'Execute (live)', {
    toolName: TOOL_NAME,
    runningDot: true
  }));

  frame.appendChild(h('div', { class: 'step-header' },
    fcBreadcrumbs('execute'),
    h('h2', {}, `Processing ${store.devices.length} device${store.devices.length === 1 ? '' : 's'}`),
    h('p', {}, store.dryRun
      ? 'Dry-run mode: payloads built per device, no API calls made.'
      : 'Live mode: POSTing to api2.panopta.com per device.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const progressList = h('div', { class: 'progress-list' });
  body.appendChild(progressList);

  const rowBySerial = new Map();
  for (const d of store.devices) {
    const statusEl = h('span', { class: 'status pending' }, 'pending');
    const detailEl = h('span', { class: 'detail muted' }, '');
    const row = h('div', { class: 'progress-row' },
      h('span', { class: 'serial' }, d.serial),
      h('span', { class: 'ip' }, `${d.ip}:${d.port}`),
      statusEl,
      detailEl
    );
    rowBySerial.set(d.serial, { statusEl, detailEl });
    progressList.appendChild(row);
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

  // ---- Subscribe to events ----
  const stateLabel = actionBar.querySelector('.execute-state');
  let done = 0;
  let succeeded = 0;
  let failed = 0;

  const unsubscribe = events.on((event, payload) => {
    if (event === 'fc:entry-start') {
      const row = rowBySerial.get(payload.serial);
      if (row) {
        row.statusEl.textContent = 'running';
        row.statusEl.className = 'status running';
      }
    } else if (event === 'fc:entry-done') {
      const row = rowBySerial.get(payload.serial);
      if (row) {
        row.statusEl.textContent = payload.status;
        row.statusEl.className = `status ${payload.status}`;
        if (payload.status === 'failed') {
          row.detailEl.textContent = payload.error ?? '';
          row.detailEl.className = 'detail error';
        } else if (payload.resourceId) {
          row.detailEl.textContent = `id ${payload.resourceId}`;
          row.detailEl.className = 'detail muted';
        }
      }
      done++;
      if (payload.status === 'succeeded') succeeded++;
      else failed++;
      summary.textContent = `${done}/${store.devices.length} complete · ${succeeded} ok · ${failed} failed`;
    }
  });

  abortBtn.addEventListener('click', async () => {
    abortBtn.disabled = true;
    try { await call('fc:abort', {}); } catch { /* no-op */ }
  });

  // ---- Trigger the batch ----
  call('fc:create-batch', {
    devices: store.devices,
    onsightUrl: store.onsightUrl,
    serverGroupUrl: store.serverGroupUrl,
    applianceGroupUrl: store.applianceGroupUrl,
    discoverFrequency: store.discoverFrequency,
    dryRun: store.dryRun,
    concurrency: 1
  }).then((result) => {
    store.runResult = result;
    stateLabel.textContent = 'Done';
    abortBtn.textContent = 'Close';
    abortBtn.disabled = false;
    setTimeout(() => navigate('/results'), 600);
  }).catch((err) => {
    stateLabel.textContent = `Error: ${err?.message ?? err}`;
    summary.textContent = '';
    abortBtn.textContent = 'Back to Review';
    abortBtn.disabled = false;
    abortBtn.onclick = () => navigate('/review');
  });

  return () => unsubscribe();
}
