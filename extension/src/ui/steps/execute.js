// Step 4 — Executing Batch. Two execution paths:
//   Dry run: simulate locally, do not touch the service worker queue.
//   Live:    call execute-queue, listen for execute:entry-start/-done events.
//
// In both cases the UI has the same shape: per-device rows tick through
// pending → running → ok/fail, with running/progress/pending counts in
// the metric strip. The filter pills limit the device-list view.

import { h, titleBar, breadcrumbs } from '../dom.js';
import { call } from '../messaging.js';

export function render({ container, store, navigate, events }) {
  const plan = store.executePlan;
  if (!plan) {
    navigate('/queue');
    return;
  }
  const entries = plan.entries;

  // Per-entry progress store: Map<entryId, { status, durationMs?, error?, startedAt? }>
  if (!store.executeProgress || !(store.executeProgress instanceof Map)) {
    store.executeProgress = new Map();
  }
  // Initialize all entries as pending.
  for (const e of entries) {
    if (!store.executeProgress.has(e.id)) {
      store.executeProgress.set(e.id, { status: 'pending' });
    }
  }

  const state = {
    filter: 'all',
    aborted: false,
    finished: false,
    startedAt: Date.now(),
    dryRun: plan.dryRun
  };

  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar(plan.dryRun ? 'Dry-run Batch' : 'Executing Batch', { runningDot: true }));

  frame.appendChild(h('div', { class: 'step-header' },
    breadcrumbs('execute'),
    h('h2', {}, plan.dryRun
      ? `Simulating ${plan.totalPortsToRemove} port removals…`
      : `Executing ${plan.totalPortsToRemove} port removals…`),
    h('p', {}, plan.dryRun
      ? 'Dry run mode — no requests are sent to FortiMonitor. This screen shows exactly what the live run would dispatch.'
      : `The plugin is working through the queue. Up to ${plan.verbose ? 1 : 3} device${plan.verbose ? '' : 's'} are processed in parallel to respect FortiMonitor session limits.`)
  ));

  if (plan.dryRun) {
    frame.appendChild(h('div', { class: 'dryrun-banner' },
      h('strong', {}, 'DRY RUN'),
      ' — no changes sent to FortiMonitor. Rows labeled "Would remove" instead of "Removed".'
    ));
  }

  const pbOk = h('div', { class: 'pb-ok' });
  const pbFail = h('div', { class: 'pb-fail' });
  const pbRunning = h('div', { class: 'pb-running' });
  const statsTotal = h('span', {}, h('strong', {}, '0'), ` of ${entries.length} devices processed`);
  const statsElapsed = h('span', {}, '');
  frame.appendChild(h('div', { class: 'progress-strip' },
    h('div', { class: 'progress-bar' }, pbOk, pbFail, pbRunning),
    h('div', { class: 'progress-stats' }, statsTotal, statsElapsed)
  ));

  const m = {
    ok: metric('Succeeded', '0', 'ok'),
    fail: metric('Failed', '0', 'fail'),
    running: metric('Running', '0', 'running'),
    pending: metric('Pending', String(entries.length), 'muted'),
    removed: metric('Ports' + (plan.dryRun ? ' would remove' : ' removed'), '0', 'accent')
  };
  frame.appendChild(h('div', { class: 'overview-strip' },
    m.ok.el, m.fail.el, m.running.el, m.pending.el, m.removed.el
  ));

  // Body with filter pills and device list
  const pillAll = pill('All', entries.length, true, () => setFilter('all'));
  const pillRunning = pill('Running', 0, false, () => setFilter('running'));
  const pillFailed = pill('Failed', 0, false, () => setFilter('fail'));
  const pillPending = pill('Pending', entries.length, false, () => setFilter('pending'));
  const deviceList = h('div', { class: 'device-list' });
  frame.appendChild(h('div', { class: 'body-section' },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' } },
      h('h3', {}, 'Device log'),
      h('div', { class: 'filter-pills' }, pillAll.el, pillRunning.el, pillFailed.el, pillPending.el)
    ),
    deviceList
  ));

  // Render rows
  const rowByEntry = new Map();
  for (const e of entries) {
    const row = buildRow(e, store.executeProgress.get(e.id) ?? { status: 'pending' }, plan);
    deviceList.appendChild(row.el);
    rowByEntry.set(e.id, row);
  }

  // Action bar
  const stopBtn = h('button', { class: 'btn btn-danger' }, 'Stop batch');
  const viewResultsBtn = h('button', { class: 'btn btn-primary', disabled: true }, 'View results');
  frame.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' },
      plan.dryRun ? 'Dry run' : `Concurrency: ${plan.verbose ? 1 : 3}`,
      ' · Logs persist until this tab is closed'
    ),
    h('div', { class: 'right' }, stopBtn, viewResultsBtn)
  ));

  container.appendChild(frame);

  // Elapsed-timer tick
  const tickInterval = setInterval(() => {
    const elapsedMs = Date.now() - state.startedAt;
    statsElapsed.textContent = `Elapsed ${fmtDuration(elapsedMs)}`;
  }, 1000);

  // Wire filter pills
  function setFilter(f) {
    state.filter = f;
    for (const p of [pillAll, pillRunning, pillFailed, pillPending]) {
      p.el.classList.toggle('selected', false);
    }
    ({ all: pillAll, running: pillRunning, fail: pillFailed, pending: pillPending })[f].el.classList.add('selected');
    applyFilter();
  }
  function applyFilter() {
    for (const [id, row] of rowByEntry) {
      const { status } = store.executeProgress.get(id) ?? { status: 'pending' };
      const show = state.filter === 'all'
        || (state.filter === 'running' && status === 'running')
        || (state.filter === 'fail' && status === 'fail')
        || (state.filter === 'pending' && status === 'pending');
      row.el.style.display = show ? '' : 'none';
    }
  }

  function refreshCounts() {
    let ok = 0, fail = 0, running = 0, pending = 0;
    let removedPorts = 0;
    for (const e of entries) {
      const p = store.executeProgress.get(e.id) ?? { status: 'pending' };
      if (p.status === 'ok') { ok++; removedPorts += (e.removedPortNames?.length ?? 0); }
      else if (p.status === 'fail') fail++;
      else if (p.status === 'running') running++;
      else pending++;
    }
    m.ok.setValue(ok);
    m.fail.setValue(fail);
    m.running.setValue(running);
    m.pending.setValue(pending);
    m.removed.setValue(removedPorts);

    pillAll.setCount(entries.length);
    pillRunning.setCount(running);
    pillFailed.setCount(fail);
    pillPending.setCount(pending);

    const doneCount = ok + fail;
    statsTotal.replaceChildren(h('strong', {}, String(doneCount)), ` of ${entries.length} devices processed`);

    // Progress bar
    const okPct = (ok / entries.length) * 100;
    const failPct = (fail / entries.length) * 100;
    const runningPct = (running / entries.length) * 100;
    pbOk.style.width = `${okPct}%`;
    pbFail.style.width = `${failPct}%`;
    pbRunning.style.width = `${runningPct}%`;

    if (doneCount === entries.length && !state.finished) {
      state.finished = true;
      viewResultsBtn.disabled = false;
      stopBtn.disabled = true;
      finishExecution();
    }
  }

  function finishExecution() {
    clearInterval(tickInterval);
    const results = entries.map((e) => {
      const p = store.executeProgress.get(e.id) ?? { status: 'pending' };
      return {
        entry: e,
        status: p.status === 'ok' ? 'succeeded' : p.status === 'fail' ? 'failed' : 'cancelled',
        reason: p.error ? { message: p.error } : null,
        attempts: p.attempts ?? 1,
        durationMs: p.durationMs ?? 0
      };
    });
    store.runResult = {
      results,
      startedAt: plan.startedAt,
      finishedAt: new Date().toISOString(),
      dryRun: plan.dryRun,
      totalDevices: plan.totalDevices,
      totalPortsToRemove: plan.totalPortsToRemove
    };
  }

  // Bind event stream — live run only.
  let unsubscribe = null;
  if (!plan.dryRun) {
    unsubscribe = events.on((event, payload) => {
      if (event === 'execute:entry-start') {
        const prog = store.executeProgress.get(payload.entryId) ?? {};
        prog.status = 'running';
        prog.startedAt = Date.now();
        store.executeProgress.set(payload.entryId, prog);
        updateRow(payload.entryId);
        refreshCounts();
        applyFilter();
      } else if (event === 'execute:entry-done') {
        const prog = store.executeProgress.get(payload.entryId) ?? {};
        prog.status = payload.status === 'succeeded' ? 'ok' : 'fail';
        prog.durationMs = prog.startedAt ? Date.now() - prog.startedAt : 0;
        prog.attempts = payload.attempts;
        if (payload.status !== 'succeeded') {
          // Find the queue's lastError via a handler callback on execute-queue.
          // (The service worker updates queue entries; we'll show "see run log"
          //  if we don't have an inline error here.)
        }
        store.executeProgress.set(payload.entryId, prog);
        updateRow(payload.entryId);
        refreshCounts();
        applyFilter();
      }
    });

    // Kick off live run.
    (async () => {
      try {
        const res = await call('execute-queue', { verbose: plan.verbose });
        // Merge any errors surfaced in the result payload — the events
        // flag status changes but don't carry error messages.
        for (const r of res.results ?? []) {
          const prog = store.executeProgress.get(r.entry.id) ?? {};
          if (r.status === 'failed' && r.reason) {
            prog.error = r.reason?.message ?? String(r.reason);
            prog.status = 'fail';
          }
          if (r.attempts != null) prog.attempts = r.attempts;
          store.executeProgress.set(r.entry.id, prog);
          updateRow(r.entry.id);
        }
        refreshCounts();
      } catch (err) {
        // Whole-run error. Flag every still-pending entry as failed.
        for (const e of entries) {
          const prog = store.executeProgress.get(e.id) ?? {};
          if (prog.status !== 'ok' && prog.status !== 'fail') {
            prog.status = 'fail';
            prog.error = err?.message ?? String(err);
            store.executeProgress.set(e.id, prog);
            updateRow(e.id);
          }
        }
        refreshCounts();
      }
    })();
  } else {
    // Dry-run simulator — tick through entries with up to 3 in flight.
    runDryRunSimulator({ entries, store, plan, state, updateRow, refreshCounts });
  }

  function updateRow(entryId) {
    const row = rowByEntry.get(entryId);
    if (!row) return;
    const p = store.executeProgress.get(entryId) ?? { status: 'pending' };
    row.update(p);
  }

  stopBtn.addEventListener('click', async () => {
    state.aborted = true;
    stopBtn.disabled = true;
    if (!plan.dryRun) {
      try { await call('abort-run'); } catch { /* idempotent */ }
    }
  });
  viewResultsBtn.addEventListener('click', () => navigate('/results'));

  refreshCounts();

  return function teardown() {
    clearInterval(tickInterval);
    if (unsubscribe) unsubscribe();
  };
}

function buildRow(entry, prog, plan) {
  const statusInd = h('span', { class: 'status-ind' });
  const nameEl = h('span', { class: 'dev-name' },
    entry.deviceName ?? String(entry.serverId),
    h('span', { class: 'sid' }, String(entry.serverId))
  );
  const portNames = (entry.removedPortNames ?? []).join(', ');
  const actionEl = h('span', { class: 'dev-action removing' },
    (plan.dryRun ? 'Would remove ' : 'Will remove '),
    h('code', {}, portNames || '(none)')
  );
  const statusText = h('span', { class: 'dev-status-text' }, 'Queued');
  const retryCell = h('span', {});

  const el = h('div', { class: 'dev-row pending' },
    statusInd, nameEl, actionEl, statusText, retryCell);

  function update(p) {
    el.classList.remove('pending', 'running', 'ok', 'fail');
    el.classList.add(p.status ?? 'pending');
    if (p.status === 'ok') {
      actionEl.replaceChildren(
        plan.dryRun ? 'Would remove ' : 'Removed ',
        h('code', {}, portNames)
      );
      const dur = typeof p.durationMs === 'number' && p.durationMs > 0 ? ` — ${(p.durationMs / 1000).toFixed(1)}s` : '';
      statusText.replaceChildren(plan.dryRun ? 'Simulated' + dur : 'Success' + dur);
    } else if (p.status === 'fail') {
      statusText.replaceChildren(
        p.error ?? 'Failed',
        p.error ? h('span', { class: 'err-detail' }, summarizeError(p.error)) : null
      );
    } else if (p.status === 'running') {
      statusText.replaceChildren(plan.dryRun ? 'Simulating…' : 'Saving…');
    } else {
      statusText.replaceChildren('Queued');
    }
  }

  return { el, update };
}

function summarizeError(msg) {
  if (typeof msg !== 'string') return '';
  if (/xsrf/i.test(msg)) return 'Session cookie may have expired';
  if (/timeout/i.test(msg)) return 'Network timeout — FortiMonitor did not respond';
  if (/HTTP 4\d\d/.test(msg)) return 'FortiMonitor rejected the request';
  if (/HTTP 5\d\d/.test(msg)) return 'FortiMonitor server error';
  return 'See network tab for details';
}

function metric(label, value, color = '') {
  const valEl = h('div', { class: `value ${color}` }, String(value));
  const el = h('div', { class: 'metric' },
    h('div', { class: 'label' }, label),
    valEl
  );
  return { el, setValue(v) { valEl.textContent = String(v); } };
}

function pill(label, count, selected, onClick) {
  const el = h('span', { class: `filter-pill${selected ? ' selected' : ''}`, onClick },
    `${label} (${count})`);
  return {
    el,
    setCount(n) { el.textContent = `${label} (${n})`; }
  };
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${rs}s`;
}

function runDryRunSimulator({ entries, store, plan, state, updateRow, refreshCounts }) {
  const maxInflight = plan.verbose ? 1 : 3;
  let idx = 0;
  let inflight = 0;

  function dispatchNext() {
    if (state.aborted) return;
    while (inflight < maxInflight && idx < entries.length) {
      const entry = entries[idx++];
      inflight++;
      const start = Date.now();
      const prog = store.executeProgress.get(entry.id) ?? {};
      prog.status = 'running';
      prog.startedAt = start;
      store.executeProgress.set(entry.id, prog);
      updateRow(entry.id);
      refreshCounts();

      const duration = 300 + Math.random() * 700;
      setTimeout(() => {
        const p = store.executeProgress.get(entry.id) ?? {};
        p.status = 'ok';
        p.durationMs = Date.now() - start;
        p.attempts = 1;
        store.executeProgress.set(entry.id, p);
        inflight--;
        updateRow(entry.id);
        refreshCounts();
        if (!state.aborted) dispatchNext();
      }, duration);
    }
  }
  dispatchNext();
}
