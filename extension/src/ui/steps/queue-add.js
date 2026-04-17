// Step 3 (Add tool) — Queue overview. Inverse of queue.js: audit the
// staged port additions. Non-destructive, so there is no typed-
// confirmation gate — dry-run (on by default) is the only guard.

import { h, titleBar, breadcrumbs, downloadBlob } from '../../lib/dom.js';
import { summarizeAddPlan } from '../plan.js';
import { call } from '../../lib/messaging.js';

const TOOL_NAME = 'Add to Port Scope (Fabric)';

export function render({ container, store, navigate }) {
  const entries = store.queueEntries ?? [];
  const summary = summarizeAddPlan(entries);
  const groups = store.scanResult?.groups ?? [];

  let skippedDevices = 0;
  let skippedGroups = 0;
  for (const g of groups) {
    const dec = store.decisions.get(g.fingerprint);
    const wasReviewed = !!dec;
    const noop = !dec || dec.skipped || !dec.addPortNames?.length;
    if (wasReviewed && noop) {
      skippedDevices += g.devices.length;
      skippedGroups++;
    }
  }
  const totalDevices = groups.reduce((n, g) => n + g.devices.length, 0);

  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Queue Overview', { toolName: TOOL_NAME }));
  frame.appendChild(h('div', { class: 'step-header' },
    breadcrumbs('queue'),
    h('h2', {}, 'Audit the queue before executing'),
    h('p', {}, 'Every staged change across all reviewed groups is listed below. Adding a port provisions new agent resources and begins metric collection — non-destructive and reversible via the Remove tool. Dry-run is on by default; no typed-confirmation gate is required.')
  ));

  frame.appendChild(h('div', { class: 'overview-strip' },
    metric('Devices in batch', totalDevices),
    metric('Unique groups', groups.length),
    metric('Devices affected', summary.totalDevices, 'accent'),
    metric('Ports to add', summary.totalPortsToAdd, 'ok'),
    metric('Groups skipped', skippedGroups, 'muted')
  ));

  const body = h('div', { class: 'body-section' });
  body.appendChild(h('h3', {}, 'Pending changes by group'));
  if (summary.groups.length === 0) {
    body.appendChild(h('div', { class: 'skipped-summary' },
      h('span', { class: 'dash-icon' }),
      h('div', {}, 'No groups have staged additions. Return to review to mark at least one port.')
    ));
  }
  let groupNumber = 0;
  for (const g of groups) {
    const dec = store.decisions.get(g.fingerprint);
    groupNumber++;
    const fpShort = g.fingerprint ? `${g.fingerprint.slice(0, 4)}…${g.fingerprint.slice(-4)}` : '—';
    const isSkipped = !dec || dec.skipped || !dec.addPortNames?.length;
    const added = dec?.addPortNames ?? [];

    const card = h('div', { class: `group-card ${isSkipped ? 'skipped' : ''}` });
    const head = h('div', { class: 'group-head' },
      h('div', { class: 'group-badge' }, `Group ${groupNumber}`),
      h('div', { class: 'group-title' },
        h('div', { class: 'name' }, describeGroup(dec)),
        h('div', { class: 'meta' },
          `${g.devices.length} device${g.devices.length === 1 ? '' : 's'} · fingerprint `,
          h('code', { class: 'fingerprint' }, fpShort),
          ` · ${g.portsData?.ports?.length ?? 0} ports per device`
        )
      ),
      h('div', { class: `action-summary ${isSkipped ? '' : 'add'}` },
        isSkipped ? 'No changes' : `Add ${added.join(', ')} × ${g.devices.length}`),
      h('div', { class: 'chev' }, '▸')
    );
    card.appendChild(head);
    let expanded = false;
    const bodyEl = h('div', { class: 'group-body' });
    head.addEventListener('click', () => {
      expanded = !expanded;
      head.querySelector('.chev').textContent = expanded ? '▾' : '▸';
      if (expanded) populateGroupBody(bodyEl, g, dec, store, navigate, groupNumber);
      bodyEl.style.display = expanded ? 'block' : 'none';
    });
    bodyEl.style.display = 'none';
    card.appendChild(bodyEl);
    body.appendChild(card);
  }
  frame.appendChild(body);

  // Non-destructive gate: dry-run toggle only, no typed confirmation.
  const dryRunInput = h('input', { type: 'checkbox', id: 'dryrun' });
  dryRunInput.checked = store.executeConfig.dryRun !== false;
  const verboseInput = h('input', { type: 'checkbox', id: 'verbose' });
  verboseInput.checked = store.executeConfig.verbose === true;

  const gate = h('div', { class: 'gate-section' },
    h('h3', { class: 'gate-title add' },
      h('span', { class: 'info-i' }, 'i'),
      'Ready to execute'
    ),
    h('div', { class: 'gate-body' },
      'Executing this queue will add ',
      h('strong', {}, `${summary.totalPortsToAdd} port entries across ${summary.totalDevices} devices`),
      '. FortiMonitor will provision fresh agent resources and begin metric collection for each newly-monitored interface. Non-destructive; reversible via the Remove tool.'
    ),
    h('div', { class: 'toggle-box warn' },
      dryRunInput,
      h('label', { for: 'dryrun' },
        h('strong', {}, 'Dry run'),
        ' — simulate every save without modifying FortiMonitor (recommended for the first pass)'
      )
    ),
    h('div', { class: 'toggle-box' },
      verboseInput,
      h('label', { for: 'verbose' },
        h('strong', {}, 'Verbose mode'),
        ' — ignored in dry-run. In a live run, forces serial execution (concurrency 1) so you can watch each save in the network tab. Slower; off by default.'
      )
    )
  );
  frame.appendChild(gate);

  const backBtn = h('button', { class: 'btn btn-secondary' }, '← Back to review');
  const runBtn = h('button', { class: 'btn btn-primary' }, 'Run dry run →');
  const dlJson = h('a', { class: 'download-link' }, '↓ Download plan (JSON)');
  const dlCsv = h('a', { class: 'download-link' }, '↓ Download plan (CSV)');
  frame.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, dlJson, dlCsv),
    h('div', { class: 'right' }, backBtn, runBtn)
  ));

  container.appendChild(frame);

  function updateGateState() {
    const dry = dryRunInput.checked;
    store.executeConfig.dryRun = dry;
    store.executeConfig.verbose = verboseInput.checked;
    if (dry) {
      runBtn.textContent = 'Run dry run →';
      runBtn.className = 'btn btn-primary';
    } else {
      runBtn.textContent = `Add ${summary.totalPortsToAdd} port${summary.totalPortsToAdd === 1 ? '' : 's'}`;
      runBtn.className = 'btn btn-primary btn-add';
    }
    runBtn.disabled = summary.totalDevices === 0;
  }

  dryRunInput.addEventListener('change', updateGateState);
  verboseInput.addEventListener('change', updateGateState);
  updateGateState();

  backBtn.addEventListener('click', () => {
    store.reviewIndex = Math.max(0, (store.scanResult?.groups?.length ?? 1) - 1);
    navigate('/review');
  });

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    const priorLabel = runBtn.textContent;
    runBtn.textContent = 'Preparing…';
    try {
      if (!dryRunInput.checked) {
        await call('queue:replace', { entries });
      }
      store.executePlan = {
        entries,
        totalDevices: summary.totalDevices,
        totalPortsToAdd: summary.totalPortsToAdd,
        dryRun: dryRunInput.checked,
        verbose: verboseInput.checked,
        startedAt: new Date().toISOString()
      };
      store.executeProgress = new Map();
      store.runResult = null;
      navigate('/execute');
    } catch (err) {
      runBtn.textContent = priorLabel;
      runBtn.disabled = false;
      alert(`Failed to stage queue: ${err.message ?? err}`);
    }
  });

  dlJson.addEventListener('click', (e) => {
    e.preventDefault();
    const plan = {
      batchId: store.batchId,
      tool: 'add',
      generatedAt: new Date().toISOString(),
      totalDevices: summary.totalDevices,
      totalPortsToAdd: summary.totalPortsToAdd,
      entries
    };
    downloadBlob(`${store.batchId || 'plan'}-add.json`, 'application/json', JSON.stringify(plan, null, 2));
  });
  dlCsv.addEventListener('click', (e) => {
    e.preventDefault();
    const rows = [['server_id', 'device_name', 'group_fingerprint', 'add_ports', 'kept_indices']];
    for (const e1 of entries) {
      rows.push([
        String(e1.serverId),
        String(e1.deviceName ?? ''),
        String(e1.groupId ?? ''),
        (e1.addedPortNames || []).join('|'),
        (e1.intendedAction?.selectedIndices || []).join('|')
      ]);
    }
    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    downloadBlob(`${store.batchId || 'plan'}-add.csv`, 'text/csv', csv);
  });
}

function metric(label, value, color = '') {
  return h('div', { class: 'metric' },
    h('div', { class: 'label' }, label),
    h('div', { class: `value ${color}` }, String(value))
  );
}

function describeGroup(decision) {
  if (!decision || decision.skipped || !decision.addPortNames?.length) return 'No changes for this group';
  const names = decision.addPortNames;
  if (names.length === 1) return `Add ${names[0]}`;
  return `Add ${names.join(', ')}`;
}

function populateGroupBody(el, group, decision, store, navigate, groupNumber) {
  if (el.dataset.populated) return;
  const ports = group.portsData?.ports ?? [];
  const added = new Set(decision?.addPortNames ?? []);
  const alreadyInScope = ports.filter((p) => p.isActive);
  const deviceNames = group.devices.map((d) => store.nameById[String(d.serverId)] ?? String(d.serverId));
  const sampleNames = deviceNames.slice(0, 20).join(' · ') + (deviceNames.length > 20 ? ` · … +${deviceNames.length - 20} more` : '');

  const kv = h('div', { class: 'kv' });
  if (added.size) {
    kv.appendChild(h('div', { class: 'k' }, 'Ports marked:'));
    kv.appendChild(h('div', { class: 'v' },
      ...[...added].flatMap((name) => [
        h('span', { class: 'removed-badge add-badge' }, 'ADD'),
        h('code', {}, name), ' '
      ])
    ));
  } else {
    kv.appendChild(h('div', { class: 'k' }, 'Ports marked:'));
    kv.appendChild(h('div', { class: 'v' }, '(skipped by operator)'));
  }
  kv.appendChild(h('div', { class: 'k' }, 'Already in scope:'));
  kv.appendChild(h('div', { class: 'v' },
    `${alreadyInScope.length} — `,
    ...interleave(alreadyInScope.map((p) => h('code', {}, p.name)), ', ')
  ));
  kv.appendChild(h('div', { class: 'k' }, 'Devices:'));
  kv.appendChild(h('div', { class: 'v' }, h('div', { class: 'device-sample' }, sampleNames || '(none)')));
  el.appendChild(kv);
  el.appendChild(h('a', {
    class: 'edit-link',
    onClick: (e) => {
      e.preventDefault();
      store.reviewIndex = groupNumber - 1;
      navigate('/review');
    }
  }, '← Edit this group'));

  el.dataset.populated = '1';
}

function interleave(arr, sep) {
  const out = [];
  arr.forEach((el, i) => {
    if (i > 0) out.push(sep);
    out.push(el);
  });
  return out;
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
