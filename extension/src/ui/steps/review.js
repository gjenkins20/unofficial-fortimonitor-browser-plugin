// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Step 2 - Review groups. Present one prompt per unique fingerprint
// group. Operator checks WAN port row(s) to remove for everyone in the
// group; "Queue for N devices" advances to the next group (or to the
// queue overview when all groups are reviewed).

import { h, titleBar, breadcrumbs, downloadBlob } from '../../lib/dom.js';
import { buildQueueEntries } from '../plan.js';
import { isDevModeEnabled } from '../../lib/settings.js';
import { call } from '../../lib/messaging.js';
import { buildAuditCsv, auditCsvFilename } from './audit-csv.js';

const FORTILINK = 'fortilink';

export function render({ container, store, navigate }) {
  const groups = store.scanResult?.groups ?? [];
  if (groups.length === 0) {
    renderEmpty(container, navigate, store);
    return;
  }

  let index = Math.min(store.reviewIndex ?? 0, groups.length - 1);
  if (index < 0) index = 0;

  // Initialize decision for current group if not yet set.
  ensureDecision(store, groups[index].fingerprint);

  renderGroup(container, { store, navigate, groups, index, setIndex });

  function setIndex(next) {
    store.reviewIndex = next;
    if (next >= groups.length) {
      // All groups reviewed - compute queue entries and advance.
      const entries = buildQueueEntries({
        groups,
        decisions: store.decisions,
        nameById: store.nameById,
        batchId: store.batchId
      });
      store.queueEntries = entries;
      navigate('/queue');
      return;
    }
    ensureDecision(store, groups[next].fingerprint);
    container.innerHTML = '';
    renderGroup(container, { store, navigate, groups, index: next, setIndex });
  }
}

function ensureDecision(store, fingerprint) {
  if (!store.decisions.has(fingerprint)) {
    store.decisions.set(fingerprint, { skipped: false, removePortNames: [] });
  }
}

function renderEmpty(container, navigate, store) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Review Groups'));
  frame.appendChild(h('div', { class: 'step-header' },
    breadcrumbs('review'),
    h('h2', {}, 'No groups to review'),
    h('p', {}, 'No devices could be read in your active session. Return to Load devices and try again.')
  ));
  const errored = store.scanResult?.errored ?? [];
  const errorListHost = h('div', { class: 'warn-list' });
  if (errored.length) {
    const body = h('div', { class: 'body-section' },
      h('h3', {}, `${errored.length} device(s) failed to read`),
      errorListHost
    );
    frame.appendChild(body);
  }

  // Developer-mode diagnostics live in their own section below the error
  // list. Gated behind isDevModeEnabled so normal operators don't see raw
  // URLs or body previews.
  const devSection = h('div', { class: 'body-section dev-diagnostics', hidden: true },
    h('h3', {}, 'Developer diagnostics'),
    h('p', { class: 'dev-help' }, 'Shown because Developer mode is enabled in Settings. Use Check session to probe FortiMonitor directly.')
  );
  const probeBtn = h('button', { class: 'btn btn-secondary' }, 'Check session');
  const probeResult = h('div', { class: 'dev-probe', hidden: true });
  devSection.append(
    h('div', { style: { margin: '8px 0' } }, probeBtn),
    probeResult
  );
  frame.appendChild(devSection);

  frame.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, ''),
    h('div', { class: 'right' }, h('button', {
      class: 'btn btn-primary', onClick: () => navigate('/start')
    }, '← Back to start'))
  ));
  container.appendChild(frame);

  // Async: render error list (with or without diagnostic expansion) and
  // reveal the dev section once we know the flag.
  (async () => {
    const dev = await isDevModeEnabled();
    errorListHost.replaceChildren(
      h('ul', {},
        ...errored.map((e) => renderErrorItem(e, dev))
      )
    );
    if (dev) devSection.hidden = false;
  })();

  probeBtn.addEventListener('click', async () => {
    probeBtn.disabled = true;
    probeBtn.textContent = 'Probing…';
    probeResult.hidden = false;
    probeResult.replaceChildren('Calling /onboarding/getDevicePorts?server_id=0 …');
    try {
      const result = await call('session:probe');
      probeResult.replaceChildren(renderProbe(result));
    } catch (err) {
      probeResult.replaceChildren(
        h('div', { class: 'probe-error' }, `Probe failed: ${err?.message ?? String(err)}`)
      );
    } finally {
      probeBtn.disabled = false;
      probeBtn.textContent = 'Check session';
    }
  });
}

function renderErrorItem(e, devMode) {
  const primary = `${e.serverId}: ${e.error?.message ?? String(e.error)}`;
  if (!devMode) return h('li', {}, primary);
  const { status, phase, responseUrl, contentType, bodyPreview } = e.error ?? {};
  const detail = h('div', { class: 'dev-error-detail' });
  const fields = [];
  if (phase) fields.push(['phase', phase]);
  if (status != null) fields.push(['status', String(status)]);
  if (contentType) fields.push(['content-type', contentType]);
  if (responseUrl) fields.push(['final url', responseUrl]);
  if (fields.length) {
    detail.appendChild(h('dl', { class: 'dev-kv' },
      ...fields.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])
    ));
  }
  if (bodyPreview) {
    detail.appendChild(h('pre', { class: 'dev-body-preview' }, bodyPreview));
  }
  return h('li', {}, primary, detail);
}

function renderProbe(result) {
  const wrap = h('div', { class: 'probe-result' });
  const kv = [
    ['tenant origin', result.origin ?? '(unresolved)'],
    ['XSRF cookie present', result.hasXsrfCookie ? 'yes' : 'no'],
    ['XSRF cookie prefix', result.xsrfCookiePrefix ?? '(none)']
  ];
  if (result.probe) {
    if (result.probe.error) {
      kv.push(['probe error', result.probe.error]);
    } else {
      kv.push(['HTTP status', String(result.probe.status)]);
      kv.push(['content-type', result.probe.contentType || '(empty)']);
      kv.push(['final url', result.probe.responseUrl ?? '(unknown)']);
    }
  }
  wrap.appendChild(h('dl', { class: 'dev-kv' },
    ...kv.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])
  ));
  const interpretation = interpretProbe(result);
  if (interpretation) {
    wrap.appendChild(h('div', { class: 'probe-interpretation' }, interpretation));
  }
  return wrap;
}

function interpretProbe(result) {
  if (!result.hasXsrfCookie) {
    return 'No XSRF-TOKEN cookie visible to the extension. You are not logged in to fortimonitor.forticloud.com in this Chrome profile, or the extension is installed in a different profile than the one where you logged in.';
  }
  const ct = (result.probe?.contentType ?? '').toLowerCase();
  if (ct && !ct.includes('json')) {
    return 'XSRF cookie is present but FortiMonitor returned a non-JSON response - likely a login-page redirect. Session may be expired, or the extension is running in a profile whose cookies do not match the tenant being queried.';
  }
  if (result.probe?.ok) {
    return 'Session looks healthy. The earlier failures are likely tenant-scoped - the server IDs you entered may not belong to this tenant.';
  }
  return null;
}

function renderGroup(container, { store, navigate, groups, index, setIndex }) {
  const group = groups[index];
  const ports = group.portsData?.ports ?? [];
  const decision = store.decisions.get(group.fingerprint);
  const deviceCount = group.devices.length;

  const upCount = ports.filter((p) => String(p.oper_status).toLowerCase() === 'up').length;
  const downCount = ports.filter((p) => String(p.oper_status).toLowerCase() === 'down').length;
  const fingerprintShort = group.fingerprint ? `${group.fingerprint.slice(0, 4)}…${group.fingerprint.slice(-4)}` : '-';

  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Mark WAN Interfaces for Removal'));

  // breadcrumbs live in their own step-header per the mockup
  const downloadAuditBtn = h('a', {
    class: 'download-link audit-download',
    href: '#',
    onClick: (e) => {
      e.preventDefault();
      const csv = buildAuditCsv({
        groups, decisions: store.decisions, nameById: store.nameById,
        toolMode: 'remove', batchId: store.batchId
      });
      downloadBlob(auditCsvFilename(store.batchId, 'remove'), 'text/csv', csv);
    }
  }, '↓ Download audit (CSV)');

  const crumbHeader = h('div', { class: 'step-header' },
    breadcrumbs('review'),
    h('h2', {}, `Group ${index + 1} of ${groups.length}`),
    h('p', {}, `${deviceCount} device${deviceCount === 1 ? '' : 's'} share this interface state. One decision applies to every device in this group.`),
    renderDevicePreview(group.devices, store.nameById),
    h('div', { class: 'audit-download-row' }, downloadAuditBtn)
  );
  frame.appendChild(crumbHeader);

  // device-header / summary row
  const summaryPill = h('span', { class: 'stat-pill selected' }, 'Queue: ',
    h('strong', {}, String(computeQueuedCount(store, groups))),
    ' devices');
  const selectedPillWrap = h('span', { class: 'stat-pill selected', style: { display: 'none' } });

  const devicesSummary = h('details', { style: { marginTop: '10px', fontSize: '12px', color: 'var(--text-muted)' } },
    h('summary', { style: { cursor: 'pointer' } }, `Devices in this group (${deviceCount})`),
    h('div', {
      style: {
        marginTop: '6px', padding: '8px 10px', background: 'white',
        border: '1px solid var(--border)', borderRadius: '4px',
        fontFamily: 'SF Mono, Menlo, monospace', fontSize: '11px',
        lineHeight: '1.6', maxHeight: '80px', overflowY: 'auto',
        wordBreak: 'break-all'
      }
    }, group.devices.map((d) => store.nameById[String(d.serverId)] ?? String(d.serverId)).join(' · '))
  );

  frame.appendChild(h('div', { class: 'device-header' },
    h('div', { class: 'device-meta' },
      `${ports.length} port${ports.length === 1 ? '' : 's'} per device · fingerprint `,
      h('code', { class: 'fingerprint' }, fingerprintShort)
    ),
    h('div', { class: 'summary-row' },
      h('span', { class: 'stat-pill up' }, h('span', { class: 'dot' }), `${upCount} operationally up`),
      h('span', { class: 'stat-pill down' }, h('span', { class: 'dot' }), `${downCount} operationally down`),
      selectedPillWrap,
      summaryPill
    ),
    devicesSummary
  ));

  // Destructive banner
  frame.appendChild(h('div', { class: 'destructive-banner' },
    h('span', { class: 'bang' }, '!'),
    h('div', {},
      h('strong', {}, `One decision applies to all ${deviceCount} device${deviceCount === 1 ? '' : 's'} in this group.`),
      ' Scope is WAN interfaces only - identify the WAN row(s) this template uses and mark any that are operationally down. Your selection will be queued for every device in the group. Removing a port deletes its agent resources and metric history - irreversible. Nothing writes to FortiMonitor until you execute the queue in step 4. (You\'re in step 2.)'
    )
  ));

  // Instruction row
  frame.appendChild(h('div', { class: 'instruction-row' },
    h('strong', {}, 'What to do:'),
    ' check any WAN interface(s) you want to remove from monitoring - typically the ones showing ',
    h('code', {}, 'oper_status = down'),
    '. WAN naming varies per site: it may be ',
    h('code', {}, 'wan2'), ', ',
    h('code', {}, 'x1'), '/', h('code', {}, 'x2'), ', ',
    h('code', {}, '(ISP Name)'),
    ', or similar. Leave non-WAN interfaces alone even if they\'re down - the plugin will not touch anything you don\'t check.'
  ));

  // Toolbar
  const searchInput = h('input', { class: 'search', type: 'text', placeholder: 'Filter by name...' });
  const clearBtn = h('button', { class: 'quick-btn' }, 'Clear selection');
  frame.appendChild(h('div', { class: 'toolbar' },
    h('div', { class: 'quick-actions' }, clearBtn),
    searchInput
  ));

  // Table
  const tbody = h('tbody', {});
  const rowByPort = new Map(); // portName -> { tr, checkbox }

  for (const port of [...ports].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const isFortilink = String(port.name).toLowerCase() === FORTILINK;
    const admin = normStatus(port.admin_status);
    const oper = normStatus(port.oper_status);
    const checkbox = h('input', { type: 'checkbox' });
    const tr = h('tr', { class: isFortilink ? 'fortilink-warn' : '' },
      h('td', { class: 'col-check' }, checkbox),
      h('td', { class: 'col-name' },
        port.name,
        isFortilink ? h('span', { class: 'special-tag' }, 'fabric link - keep') : null
      ),
      h('td', {}, port.descr ?? ''),
      h('td', { class: 'col-status' }, statusBadge(admin)),
      h('td', { class: 'col-status' }, statusBadge(oper))
    );

    if (decision.removePortNames.includes(port.name)) {
      checkbox.checked = true;
      tr.classList.add('row-checked');
    }

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (!decision.removePortNames.includes(port.name)) decision.removePortNames.push(port.name);
        tr.classList.add('row-checked');
      } else {
        decision.removePortNames = decision.removePortNames.filter((n) => n !== port.name);
        tr.classList.remove('row-checked');
      }
      updateActionSummary();
    });

    rowByPort.set(port.name, { tr, checkbox });
    tbody.appendChild(tr);
  }

  frame.appendChild(h('div', { class: 'table-wrap' },
    h('table', { class: 'ports-table' },
      h('thead', {},
        h('tr', {},
          h('th', { class: 'col-check' }),
          h('th', { class: 'col-name' }, 'Port Name'),
          h('th', {}, 'Description'),
          h('th', { class: 'col-status' }, 'Admin'),
          h('th', { class: 'col-status' }, 'Operational')
        )
      ),
      tbody
    )
  ));

  // Action bar
  const queueBtn = h('button', { class: 'btn btn-primary' }, queueButtonLabel());
  const skipBtn = h('button', { class: 'btn btn-secondary' }, 'Skip this group');
  const leftSummary = h('span', {});
  frame.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, leftSummary),
    h('div', { class: 'right' }, skipBtn, queueBtn)
  ));

  container.appendChild(frame);

  // Filter logic
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    for (const [name, { tr }] of rowByPort) {
      tr.classList.toggle('hidden', q.length > 0 && !String(name).toLowerCase().includes(q));
    }
  });

  clearBtn.addEventListener('click', () => {
    decision.removePortNames = [];
    for (const { checkbox, tr } of rowByPort.values()) {
      checkbox.checked = false;
      tr.classList.remove('row-checked');
    }
    updateActionSummary();
  });

  skipBtn.addEventListener('click', () => {
    decision.skipped = true;
    decision.removePortNames = [];
    setIndex(index + 1);
  });

  queueBtn.addEventListener('click', () => {
    decision.skipped = decision.removePortNames.length === 0;
    setIndex(index + 1);
  });

  updateActionSummary();

  function queueButtonLabel() {
    const n = decision.removePortNames.length;
    if (n === 0) return `Skip group →`;
    const lastLabel = groups.length - 1 === index ? 'to queue' : 'next group';
    return `Queue for ${deviceCount} device${deviceCount === 1 ? '' : 's'} · ${lastLabel} →`;
  }

  function updateActionSummary() {
    queueBtn.textContent = queueButtonLabel();
    if (decision.removePortNames.length === 0) {
      leftSummary.textContent = 'Nothing marked for removal - this group will be skipped.';
      selectedPillWrap.style.display = 'none';
    } else {
      leftSummary.replaceChildren(
        'Marked for removal: ',
        h('strong', { style: { color: 'var(--accent)', fontFamily: 'SF Mono, Menlo, monospace' } },
          decision.removePortNames.join(', ')),
        ` - applies to all ${deviceCount} device${deviceCount === 1 ? '' : 's'} in this group`
      );
      selectedPillWrap.style.display = '';
      selectedPillWrap.replaceChildren(
        `${decision.removePortNames.length} marked for removal (× ${deviceCount} device${deviceCount === 1 ? '' : 's'})`
      );
    }
  }
}

function normStatus(v) {
  const s = String(v ?? '').toLowerCase();
  if (s === 'up' || s === 'down') return s;
  return 'unknown';
}

function statusBadge(status) {
  return h('span', { class: `status-badge ${status}` }, status);
}

// Compact device-name preview for the step-header. Operators track devices by
// name, not server ID - this surfaces names up-front instead of hiding them
// inside the collapsed `<details>` below.
function renderDevicePreview(devices, nameById) {
  const PREVIEW_LIMIT = 3;
  const labels = devices.map((d) => nameById[String(d.serverId)] ?? String(d.serverId));
  const head = labels.slice(0, PREVIEW_LIMIT);
  const overflow = labels.length - head.length;
  const children = [h('strong', {}, 'Devices: ')];
  head.forEach((label, i) => {
    if (i > 0) children.push(', ');
    children.push(h('span', { class: 'device-chip' }, label));
  });
  if (overflow > 0) children.push(`, +${overflow} more`);
  return h('p', { class: 'devices-preview' }, ...children);
}

function computeQueuedCount(store, groups) {
  let n = 0;
  for (const g of groups) {
    const dec = store.decisions.get(g.fingerprint);
    if (dec && !dec.skipped && dec.removePortNames.length > 0) n += g.devices.length;
  }
  return n;
}
