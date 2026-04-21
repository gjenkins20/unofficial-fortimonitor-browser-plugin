// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Step 3 - Queue overview. Operator reviews every staged change across
// all reviewed groups, exports the plan for audit, toggles dry-run / verbose,
// types the confirmation phrase, and kicks execution.

import { h, titleBar, breadcrumbs, downloadBlob } from '../../lib/dom.js';
import { summarizePlan } from '../plan.js';
import { call } from '../../lib/messaging.js';

export function render({ container, store, navigate }) {
  const entries = store.queueEntries ?? [];
  const summary = summarizePlan(entries);
  const groups = store.scanResult?.groups ?? [];

  // Determine skipped groups and their device counts for the strip totals.
  let skippedDevices = 0;
  let skippedGroups = 0;
  for (const g of groups) {
    const dec = store.decisions.get(g.fingerprint);
    const wasReviewed = !!dec;
    const noop = !dec || dec.skipped || !dec.removePortNames?.length;
    if (wasReviewed && noop) {
      skippedDevices += g.devices.length;
      skippedGroups++;
    }
  }
  const totalDevices = groups.reduce((n, g) => n + g.devices.length, 0);

  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Queue Overview'));
  frame.appendChild(h('div', { class: 'step-header' },
    breadcrumbs('queue'),
    h('h2', {}, 'Audit the queue before executing'),
    h('p', {}, 'Every staged change across all reviewed groups is listed below. Destructive actions are irreversible - FortiMonitor deletes agent resources and metric history for each deselected port. Dry-run is on by default; you must turn it off and type a confirmation phrase to write changes.')
  ));

  // Overview strip
  frame.appendChild(h('div', { class: 'overview-strip' },
    metric('Devices in batch', totalDevices),
    metric('Unique groups', groups.length),
    metric('Devices affected', summary.totalDevices, 'accent'),
    metric('Ports to remove', summary.totalPortsToRemove, 'danger'),
    metric('Groups skipped', skippedGroups, 'muted')
  ));

  // Pending-changes body
  const body = h('div', { class: 'body-section' });
  body.appendChild(h('h3', {}, 'Pending changes by group'));
  if (summary.groups.length === 0) {
    body.appendChild(h('div', { class: 'skipped-summary' },
      h('span', { class: 'dash-icon' }),
      h('div', {}, 'No groups have staged removals. Return to review to mark at least one port.')
    ));
  }
  for (const [idx, g] of groups.entries()) {
    const dec = store.decisions.get(g.fingerprint);
    const groupNumber = idx + 1;
    const fpShort = g.fingerprint ? `${g.fingerprint.slice(0, 4)}…${g.fingerprint.slice(-4)}` : '-';
    const isSkipped = !dec || dec.skipped || !dec.removePortNames?.length;
    const removed = dec?.removePortNames ?? [];

    const card = h('div', { class: `group-card ${isSkipped ? 'skipped' : ''}` });
    const head = h('div', { class: 'group-head' },
      h('div', { class: 'group-badge' }, `Group ${groupNumber}`),
      h('div', { class: 'group-title' },
        h('div', { class: 'name' }, describeGroup(g, store.nameById)),
        h('div', { class: 'meta' },
          `${g.devices.length} device${g.devices.length === 1 ? '' : 's'} · fingerprint `,
          h('code', { class: 'fingerprint' }, fpShort),
          ` · ${g.portsData?.ports?.length ?? 0} ports per device`
        )
      ),
      h('div', { class: 'action-summary' },
        isSkipped ? 'No changes' : `Remove ${removed.join(', ')} × ${g.devices.length}`),
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

  // Destructive gate
  const dryRunInput = h('input', { type: 'checkbox', id: 'dryrun' });
  dryRunInput.checked = store.executeConfig.dryRun !== false;
  const verboseInput = h('input', { type: 'checkbox', id: 'verbose' });
  verboseInput.checked = store.executeConfig.verbose === true;

  const confirmPhrase = `EXECUTE ${summary.totalPortsToRemove} PORT${summary.totalPortsToRemove === 1 ? '' : 'S'}`;
  const confirmInput = h('input', { class: 'confirm-input', type: 'text', placeholder: 'Type the confirmation phrase...' });
  confirmInput.disabled = true;

  const confirmRow = h('div', { class: 'confirm-row' },
    'To execute for real, first turn off dry run, then type ',
    h('code', {}, confirmPhrase),
    ' below:'
  );

  const gate = h('div', { class: 'gate-section' },
    h('h3', { class: 'gate-title' },
      h('span', { class: 'bang' }, '!'),
      'Destructive confirmation required'
    ),
    h('div', { class: 'gate-body' },
      'Executing this queue will deselect ',
      h('strong', {}, `${summary.totalPortsToRemove} port entries across ${summary.totalDevices} devices`),
      '. FortiMonitor will delete each port\'s agent resources and all associated metric history. This operation cannot be undone.'
    ),
    h('div', { class: 'toggle-box warn' },
      dryRunInput,
      h('label', { for: 'dryrun' },
        h('strong', {}, 'Dry run'),
        ' - simulate every save without modifying FortiMonitor'
      )
    ),
    h('div', { class: 'toggle-box' },
      verboseInput,
      h('label', { for: 'verbose' },
        h('strong', {}, 'Verbose mode'),
        ' - ignored in dry-run. In a live run, forces serial execution (concurrency 1) so you can watch each save in the network tab. Slower; off by default.'
      )
    ),
    confirmRow,
    confirmInput
  );
  frame.appendChild(gate);

  // Action bar
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
    confirmInput.disabled = dry;
    if (dry) confirmInput.value = '';
    const phraseOk = !dry && confirmInput.value.trim() === confirmPhrase;
    if (dry) {
      runBtn.textContent = 'Run dry run →';
      runBtn.className = 'btn btn-primary';
      runBtn.disabled = summary.totalDevices === 0;
    } else {
      runBtn.textContent = `Execute and remove ${summary.totalPortsToRemove} port${summary.totalPortsToRemove === 1 ? '' : 's'}`;
      runBtn.className = 'btn btn-danger';
      runBtn.disabled = summary.totalDevices === 0 || !phraseOk;
    }
  }

  dryRunInput.addEventListener('change', updateGateState);
  verboseInput.addEventListener('change', updateGateState);
  confirmInput.addEventListener('input', updateGateState);
  updateGateState();

  backBtn.addEventListener('click', () => {
    // Return to last reviewed group.
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
        totalPortsToRemove: summary.totalPortsToRemove,
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
      _generator: GENERATOR,
      batchId: store.batchId,
      tool: 'remove',
      generatedAt: new Date().toISOString(),
      totalDevices: summary.totalDevices,
      totalPortsToRemove: summary.totalPortsToRemove,
      entries
    };
    downloadBlob(`${store.batchId || 'plan'}.json`, 'application/json', JSON.stringify(plan, null, 2));
  });
  dlCsv.addEventListener('click', (e) => {
    e.preventDefault();
    const header = csvAttributionHeader('remove');
    const rows = [['server_id', 'device_name', 'group_fingerprint', 'remove_ports', 'kept_port_names']];
    for (const e1 of entries) {
      rows.push([
        String(e1.serverId),
        String(e1.deviceName ?? ''),
        String(e1.groupId ?? ''),
        (e1.removedPortNames || []).join('|'),
        (e1.keptPortNames || []).join('|')
      ]);
    }
    const csv = header + rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    downloadBlob(`${store.batchId || 'plan'}.csv`, 'text/csv', csv);
  });
}

const GENERATOR = Object.freeze({
  tool: 'Unofficial FortiMonitor Toolkit',
  author: 'Gregori Jenkins',
  url: 'https://www.linkedin.com/in/gregorijenkins'
});

function csvAttributionHeader(tool) {
  const now = new Date().toISOString();
  return `# Generated by ${GENERATOR.tool} (${tool}) on ${now}\n# Author: ${GENERATOR.author} - ${GENERATOR.url}\n`;
}

function metric(label, value, color = '') {
  return h('div', { class: 'metric' },
    h('div', { class: 'label' }, label),
    h('div', { class: `value ${color}` }, String(value))
  );
}

// Name-led group title: shows the first few device names (operators track
// devices by name, not ID). Falls back to the server ID if a device has no
// resolved name. The queue's action-summary pill still carries the
// Remove-ports-× count, so we don't duplicate that here.
function describeGroup(group, nameById) {
  const PREVIEW_LIMIT = 3;
  const labels = group.devices.map((d) => nameById[String(d.serverId)] ?? String(d.serverId));
  if (labels.length === 0) return '(no devices)';
  if (labels.length <= PREVIEW_LIMIT) return labels.join(', ');
  return `${labels.slice(0, PREVIEW_LIMIT).join(', ')}, +${labels.length - PREVIEW_LIMIT} more`;
}

function populateGroupBody(el, group, decision, store, navigate, groupNumber) {
  if (el.dataset.populated) return;
  const ports = group.portsData?.ports ?? [];
  const removed = new Set(decision?.removePortNames ?? []);
  const kept = ports.filter((p) => !removed.has(p.name));
  const deviceNames = group.devices.map((d) => store.nameById[String(d.serverId)] ?? String(d.serverId));
  const sampleNames = deviceNames.slice(0, 20).join(' · ') + (deviceNames.length > 20 ? ` · … +${deviceNames.length - 20} more` : '');

  const kv = h('div', { class: 'kv' });
  if (removed.size) {
    kv.appendChild(h('div', { class: 'k' }, 'Ports marked:'));
    kv.appendChild(h('div', { class: 'v' },
      ...[...removed].flatMap((name) => [
        h('span', { class: 'removed-badge' }, 'REMOVE'),
        h('code', {}, name), ' '
      ])
    ));
  } else {
    kv.appendChild(h('div', { class: 'k' }, 'Ports marked:'));
    kv.appendChild(h('div', { class: 'v' }, '(skipped by operator)'));
  }
  kv.appendChild(h('div', { class: 'k' }, 'Ports kept:'));
  kv.appendChild(h('div', { class: 'v' },
    `${kept.length} - `,
    ...interleave(kept.map((p) => h('code', {}, p.name)), ', ')
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
