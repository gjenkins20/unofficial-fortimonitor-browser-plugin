// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Step 5 — Batch complete. Final verdict, downloadable audit report,
// failure details with retry, success and skipped summaries.

import { h, titleBar, breadcrumbs, downloadBlob } from '../../lib/dom.js';
import { call } from '../../lib/messaging.js';

export function render({ container, store, navigate }) {
  const run = store.runResult;
  if (!run) {
    navigate('/queue');
    return;
  }

  const toolMode = store.toolMode === 'add' ? 'add' : 'remove';
  const verbs = toolMode === 'add' ? ADD_VERBS : REMOVE_VERBS;
  const toolName = toolMode === 'add'
    ? 'Add to Port Scope (Fabric)'
    : 'Remove from Port Scope (Fabric)';

  const ok = run.results.filter((r) => r.status === 'succeeded');
  const failed = run.results.filter((r) => r.status === 'failed');
  const cancelled = run.results.filter((r) => r.status === 'cancelled');
  const groups = store.scanResult?.groups ?? [];
  const allDevices = groups.reduce((n, g) => n + g.devices.length, 0);
  const queuedDevices = run.totalDevices;
  const skippedDevices = Math.max(0, allDevices - queuedDevices);
  const portsChanged = ok.reduce((n, r) => n + entryPortNames(r.entry).length, 0);
  const durationMs = dateDelta(run.finishedAt, run.startedAt);
  const avgMs = ok.length ? Math.round(ok.reduce((n, r) => n + (r.durationMs ?? 0), 0) / ok.length) : 0;

  let verdict = 'success';
  let verdictIcon = '✓';
  let verdictHeadline = run.dryRun
    ? `Dry run complete — ${ok.length} of ${run.results.length} devices simulated successfully`
    : `Success — all ${ok.length} devices completed`;
  let verdictSub = run.dryRun
    ? 'No changes were sent to FortiMonitor. Re-run with dry-run off to apply.'
    : `${portsChanged} ports ${verbs.pastTenseLower} across FortiMonitor.`;
  if (failed.length && ok.length) {
    verdict = 'partial';
    verdictIcon = '!';
    verdictHeadline = run.dryRun
      ? `Dry run partial — ${ok.length} simulated, ${failed.length} would have failed`
      : `Partial success — ${ok.length} of ${run.results.length} devices completed`;
    verdictSub = `${failed.length} device${failed.length === 1 ? '' : 's'} failed after retry attempts. ${portsChanged} ports ${verbs.pastTenseLower}.`;
  } else if (failed.length && !ok.length) {
    verdict = 'fail';
    verdictIcon = '✕';
    verdictHeadline = run.dryRun
      ? `Dry run failed for all ${failed.length} devices`
      : `Batch failed — no devices completed`;
    verdictSub = 'Every device encountered an error. Review the failures below.';
  }

  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar(run.dryRun ? 'Dry-run Complete' : 'Batch Complete', { toolName }));
  frame.appendChild(h('div', { class: 'step-header' },
    breadcrumbs('execute'),
    h('h2', {}, run.dryRun ? 'Dry-run complete' : 'Batch complete'),
    h('p', {}, run.dryRun
      ? `Dry-run completed at ${fmtTime(run.finishedAt)}. No writes were sent.`
      : `Queue executed at ${fmtTime(run.finishedAt)}. Review the details below and download the report for audit.`)
  ));

  frame.appendChild(h('div', { class: `verdict-banner ${verdict}` },
    h('div', { class: 'verdict-icon' }, verdictIcon),
    h('div', { class: 'verdict-text' },
      h('h3', {}, verdictHeadline),
      h('div', { class: 'sub' }, verdictSub)
    )
  ));

  // Metric strip
  frame.appendChild(h('div', { class: 'overview-strip' },
    metric('In batch', allDevices, '', `queued ${queuedDevices} · skipped ${skippedDevices}`),
    metric('Succeeded', ok.length, 'ok', queuedDevices ? `${pct(ok.length, queuedDevices)}% of queued` : ''),
    metric('Failed', failed.length, 'fail', failed.length ? 'see below' : ''),
    metric(
      run.dryRun ? `Ports would ${verbs.verb}` : `Ports ${verbs.pastTenseLower}`,
      portsChanged,
      toolMode === 'add' ? 'ok' : 'accent',
      ''
    ),
    metric('Duration', fmtDuration(durationMs), 'muted', ok.length ? `avg ${(avgMs / 1000).toFixed(1)}s / device` : '')
  ));

  // Download strip
  const dlCsv = h('button', { class: 'dl-btn' }, '↓ Report (CSV)');
  const dlJson = h('button', { class: 'dl-btn' }, '↓ Report (JSON)');
  frame.appendChild(h('div', { class: 'download-strip' },
    h('div', { class: 'dl-label' },
      h('strong', {}, 'Download the batch report'),
      run.dryRun
        ? ' — the dry-run plan is the basis for the live run; keep a copy for reference.'
        : (toolMode === 'add'
            ? ' — keep a copy for audit. Added ports can be reversed by re-running the Remove tool.'
            : ' — the executed changes are irreversible; keep a copy for audit.')
    ),
    dlCsv, dlJson
  ));

  const body = h('div', { class: 'body-section' });

  if (failed.length) {
    body.appendChild(h('h3', {}, `Failures (${failed.length})`));
    for (const r of failed) {
      body.appendChild(buildFailCard(r, store, verbs));
    }
  }
  if (ok.length) {
    body.appendChild(h('h3', { style: { marginTop: failed.length ? '20px' : '0' } }, 'Succeeded'));
    const successCopy = toolMode === 'add'
      ? (run.dryRun
          ? 'would have had the selected interface added to port scope. No changes were sent.'
          : 'had the selected interface added to port scope. FortiMonitor has provisioned fresh agent resources and begun metric collection for those interfaces.')
      : (run.dryRun
          ? 'would have had their WAN interface removed from port scope. No changes were sent.'
          : 'had their WAN interface removed from port scope. FortiMonitor has deleted the corresponding agent resources and metric history.');
    body.appendChild(h('div', { class: 'success-summary' },
      h('span', { class: 'ok-icon' }),
      h('div', {}, h('strong', {}, `${ok.length} device${ok.length === 1 ? '' : 's'} `),
        successCopy)
    ));
  }
  if (skippedDevices) {
    body.appendChild(h('h3', { style: { marginTop: '20px' } }, 'Skipped (operator choice)'));
    body.appendChild(h('div', { class: 'skipped-summary' },
      h('span', { class: 'dash-icon' }),
      h('div', {}, h('strong', {}, `${skippedDevices} device${skippedDevices === 1 ? '' : 's'}`),
        ' in skipped groups were not queued. Their port scope is unchanged.')
    ));
  }
  frame.appendChild(body);

  // Action bar
  const retryAllBtn = h('button', {
    class: `btn ${toolMode === 'add' ? 'btn-secondary' : 'btn-danger'}`
  }, 'Retry all failures');
  retryAllBtn.disabled = failed.length === 0 || run.dryRun;
  const newBatchBtn = h('button', { class: 'btn btn-secondary' }, 'Start new batch');
  const closeBtn = h('button', { class: 'btn btn-primary' }, 'Close');
  frame.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, 'Batch ID ', h('code', { class: 'mono' }, store.batchId ?? '—'),
      run.dryRun ? h('span', { class: 'dryrun-badge', style: { marginLeft: '10px' } }, 'DRY RUN') : null
    ),
    h('div', { class: 'right' }, retryAllBtn, newBatchBtn, closeBtn)
  ));

  container.appendChild(frame);

  dlCsv.addEventListener('click', () => downloadBlob(
    `${store.batchId || 'run'}.csv`,
    'text/csv',
    toCsv(run, toolMode)
  ));
  dlJson.addEventListener('click', () => downloadBlob(
    `${store.batchId || 'run'}.json`,
    'application/json',
    JSON.stringify({ _generator: GENERATOR, batchId: store.batchId, tool: toolMode, ...run }, null, 2)
  ));
  retryAllBtn.addEventListener('click', () => {
    const failedEntries = failed.map((r) => ({ ...r.entry, status: 'pending', attempts: [] }));
    const totalChanged = failedEntries.reduce((n, e) => n + entryPortNames(e).length, 0);
    store.executePlan = {
      entries: failedEntries,
      totalDevices: failedEntries.length,
      ...(toolMode === 'add'
        ? { totalPortsToAdd: totalChanged }
        : { totalPortsToRemove: totalChanged }),
      dryRun: false,
      verbose: store.executeConfig.verbose === true,
      startedAt: new Date().toISOString()
    };
    store.executeProgress = new Map();
    store.runResult = null;
    call('queue:replace', { entries: failedEntries }).catch(() => {});
    navigate('/execute');
  });
  newBatchBtn.addEventListener('click', async () => {
    try { await call('queue:clear'); } catch {}
    resetStore(store);
    navigate('/start');
  });
  closeBtn.addEventListener('click', () => {
    if (chrome?.tabs?.getCurrent) {
      chrome.tabs.getCurrent((tab) => { if (tab?.id) chrome.tabs.remove(tab.id); });
    } else {
      window.close();
    }
  });
}

function resetStore(store) {
  store.batchId = null;
  store.serverIds = [];
  store.nameById = {};
  store.inputWarnings = [];
  store.scanResult = null;
  store.reviewIndex = 0;
  store.decisions = new Map();
  store.queueEntries = [];
  store.executeConfig = { dryRun: true, verbose: false };
  store.executePlan = null;
  store.executeProgress = new Map();
  store.runResult = null;
}

function metric(label, value, color, sub) {
  return h('div', { class: 'metric' },
    h('div', { class: 'label' }, label),
    h('div', { class: `value ${color}` }, String(value)),
    sub ? h('div', { class: 'sub' }, sub) : null
  );
}

function buildFailCard(r, store, verbs = REMOVE_VERBS) {
  const name = r.entry.deviceName ?? String(r.entry.serverId);
  const portNames = entryPortNames(r.entry).join(', ');
  const errMsg = r.reason?.message ?? 'Unknown error';
  const retryBtn = h('button', { class: 'btn btn-secondary' }, 'Retry');
  const capitalizedVerb = verbs.verb.charAt(0).toUpperCase() + verbs.verb.slice(1);
  const card = h('div', { class: 'fail-card' },
    h('div', { class: 'fail-head' },
      h('span', { class: 'fail-icon' }),
      h('span', { class: 'dev-name' },
        name, ' ',
        h('span', { class: 'sid' }, String(r.entry.serverId))
      ),
      h('span', { class: 'dev-action' }, `${capitalizedVerb} `, h('code', {}, portNames)),
      retryBtn
    ),
    h('div', { class: 'fail-body' },
      h('div', { class: 'err-summary' }, summarizeFailure(errMsg)),
      h('div', {}, explainFailure(errMsg)),
      h('div', { class: 'err-detail' }, errMsg),
      h('div', { class: 'attempts' }, `Attempts: ${r.attempts ?? 1}`)
    )
  );
  retryBtn.addEventListener('click', async () => {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Retrying…';
    try {
      const entry = { ...r.entry, status: 'pending', attempts: [] };
      await call('queue:replace', { entries: [entry] });
      const out = await call('execute-queue', {});
      const result = out.results?.[0];
      if (result?.status === 'succeeded') {
        retryBtn.textContent = '✓ Succeeded';
        retryBtn.className = 'btn btn-secondary';
        card.classList.remove('fail-card');
        card.style.opacity = '0.6';
      } else {
        retryBtn.disabled = false;
        retryBtn.textContent = 'Retry';
        alert(`Retry failed: ${result?.reason?.message ?? 'unknown error'}`);
      }
    } catch (err) {
      retryBtn.disabled = false;
      retryBtn.textContent = 'Retry';
      alert(`Retry failed: ${err?.message ?? err}`);
    }
  });
  return card;
}

function summarizeFailure(msg) {
  if (/HTTP 403/i.test(msg) || /xsrf/i.test(msg)) return 'HTTP 403 — authentication rejected';
  if (/HTTP 401/i.test(msg)) return 'HTTP 401 — session expired';
  if (/timeout/i.test(msg)) return 'Network timeout — no response';
  if (/HTTP 5\d\d/i.test(msg)) return `${msg.match(/HTTP \d+/)?.[0] ?? 'HTTP 5xx'} — server error`;
  if (/HTTP 4\d\d/i.test(msg)) return `${msg.match(/HTTP \d+/)?.[0] ?? 'HTTP 4xx'} — request rejected`;
  return msg.slice(0, 80);
}

function explainFailure(msg) {
  if (/xsrf|HTTP 4(01|03)/i.test(msg)) {
    return 'Session cookie may have expired. Re-authenticate in FortiMonitor and retry this device. No change was written.';
  }
  if (/timeout/i.test(msg)) {
    return 'FortiMonitor did not respond within the timeout. The device may be unreachable or the session is experiencing degraded connectivity.';
  }
  if (/HTTP 5\d\d/i.test(msg)) {
    return 'FortiMonitor returned a server error. The device\'s port scope is unchanged. Inspect this server manually in FortiMonitor before retrying.';
  }
  return 'Investigate the error below before retrying.';
}

function toCsv(run, toolMode) {
  const portsColumn = toolMode === 'add' ? 'add_ports' : 'remove_ports';
  const header = `# Generated by ${GENERATOR.tool} (${toolMode}) on ${new Date().toISOString()}\n# Author: ${GENERATOR.author} — ${GENERATOR.url}\n`;
  const rows = [['server_id', 'device_name', 'group_fingerprint', 'status', portsColumn, 'attempts', 'duration_ms', 'error']];
  for (const r of run.results) {
    rows.push([
      String(r.entry.serverId),
      String(r.entry.deviceName ?? ''),
      String(r.entry.groupId ?? ''),
      r.status,
      entryPortNames(r.entry).join('|'),
      String(r.attempts ?? 1),
      String(r.durationMs ?? 0),
      r.reason?.message ?? ''
    ]);
  }
  return header + rows.map((r) => r.map(csvEscape).join(',')).join('\n');
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso ?? ''; }
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${rs}s`;
}

function pct(n, d) {
  if (!d) return '0';
  return ((n / d) * 100).toFixed(1);
}

function dateDelta(a, b) {
  try {
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    return Math.max(0, ta - tb);
  } catch { return 0; }
}

const REMOVE_VERBS = Object.freeze({
  verb: 'remove',
  pastTense: 'Removed',
  pastTenseLower: 'removed'
});

const ADD_VERBS = Object.freeze({
  verb: 'add',
  pastTense: 'Added',
  pastTenseLower: 'added'
});

function entryPortNames(entry) {
  return entry?.addedPortNames ?? entry?.removedPortNames ?? [];
}

const GENERATOR = Object.freeze({
  tool: 'Unofficial FortiMonitor Toolkit',
  author: 'Gregori Jenkins',
  url: 'https://www.linkedin.com/in/gregorijenkins'
});
