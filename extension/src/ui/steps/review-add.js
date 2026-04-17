// Step 2 (Add tool) — Review groups. Inverse of review.js: operator
// marks ports to ADD to port scope (ports that are currently out of
// scope — isActive=false). Non-destructive; no typed-confirmation gate
// downstream. Defaults to hiding in-scope ports since they typically
// dominate the list.

import { h, titleBar, breadcrumbs } from '../../lib/dom.js';
import { buildAddQueueEntries } from '../plan.js';

const FORTILINK = 'fortilink';
const TOOL_NAME = 'Add to Port Scope (Fabric)';

export function render({ container, store, navigate }) {
  const groups = store.scanResult?.groups ?? [];
  if (groups.length === 0) {
    renderEmpty(container, navigate, store);
    return;
  }

  let index = Math.min(store.reviewIndex ?? 0, groups.length - 1);
  if (index < 0) index = 0;

  ensureDecision(store, groups[index].fingerprint);

  renderGroup(container, { store, navigate, groups, index, setIndex });

  function setIndex(next) {
    store.reviewIndex = next;
    if (next >= groups.length) {
      const entries = buildAddQueueEntries({
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
    store.decisions.set(fingerprint, { skipped: false, addPortNames: [] });
  }
}

function renderEmpty(container, navigate, store) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Review Groups', { toolName: TOOL_NAME }));
  frame.appendChild(h('div', { class: 'step-header' },
    breadcrumbs('review'),
    h('h2', {}, 'No groups to review'),
    h('p', {}, 'No devices could be read in your active session. Return to Load devices and try again.')
  ));
  const errored = store.scanResult?.errored ?? [];
  if (errored.length) {
    const body = h('div', { class: 'body-section' },
      h('h3', {}, `${errored.length} device(s) failed to read`),
      h('div', { class: 'warn-list' },
        h('ul', {},
          ...errored.map((e) => h('li', {}, `${e.serverId}: ${e.error?.message ?? String(e.error)}`))
        )
      )
    );
    frame.appendChild(body);
  }
  frame.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, ''),
    h('div', { class: 'right' }, h('button', {
      class: 'btn btn-primary', onClick: () => navigate('/start')
    }, '← Back to start'))
  ));
  container.appendChild(frame);
}

function renderGroup(container, { store, navigate, groups, index, setIndex }) {
  const group = groups[index];
  const ports = group.portsData?.ports ?? [];
  const decision = store.decisions.get(group.fingerprint);
  const deviceCount = group.devices.length;

  const inScopeCount = ports.filter((p) => p.isActive).length;
  const outOfScopeCount = ports.length - inScopeCount;
  const fingerprintShort = group.fingerprint ? `${group.fingerprint.slice(0, 4)}…${group.fingerprint.slice(-4)}` : '—';

  // UI-local state: show in-scope ports toggle (default off)
  const viewState = { showInScope: false };

  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Select interfaces to add', { toolName: TOOL_NAME }));

  const crumbHeader = h('div', { class: 'step-header' },
    breadcrumbs('review'),
    h('h2', {}, `Group ${index + 1} of ${groups.length}`),
    h('p', {}, `${deviceCount} device${deviceCount === 1 ? '' : 's'} share this interface state. One decision applies to every device in this group.`)
  );
  frame.appendChild(crumbHeader);

  const summaryPill = h('span', { class: 'stat-pill selected' }, 'Queue: ',
    h('strong', {}, String(computeQueuedCount(store, groups))),
    ' devices');
  const selectedPillWrap = h('span', { class: 'stat-pill selected add', style: { display: 'none' } });
  const outOfScopePill = h('span', { class: 'stat-pill out-of-scope' }, h('span', { class: 'dot' }), `${outOfScopeCount} out of scope`);
  const inScopePill = h('span', { class: 'stat-pill in-scope' }, `${inScopeCount} in scope (hidden)`);

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
      outOfScopePill,
      inScopePill,
      selectedPillWrap,
      summaryPill
    ),
    devicesSummary
  ));

  // Informational banner (non-destructive)
  frame.appendChild(h('div', { class: 'info-banner' },
    h('span', { class: 'info-i' }, 'i'),
    h('div', {},
      h('strong', {}, `One decision applies to all ${deviceCount} device${deviceCount === 1 ? '' : 's'} in this group.`),
      ' Check each interface you want to start monitoring. Adding a port provisions new agent resources and begins collecting metrics — non-destructive, reversible by re-running the Remove tool. Nothing writes to FortiMonitor until you execute the queue in step 4. (You\'re in step 2.)'
    )
  ));

  frame.appendChild(h('div', { class: 'instruction-row' },
    h('strong', {}, 'What to do:'),
    ' check any interface(s) currently ',
    h('code', {}, 'out of scope'),
    ' that you want to add to monitoring. In-scope ports are hidden by default — toggle ',
    h('em', {}, 'Show in-scope'),
    ' below if you need to see the full list. ',
    h('code', {}, 'fortilink'),
    ' (fabric link) is highlighted if present; verify before adding.'
  ));

  // Toolbar
  const searchInput = h('input', { class: 'search', type: 'text', placeholder: 'Filter by name...' });
  const selectAllOutOfScopeBtn = h('button', { class: 'quick-btn' }, 'Select all out-of-scope');
  const clearBtn = h('button', { class: 'quick-btn' }, 'Clear selection');
  const showInScopeToggle = h('input', { type: 'checkbox' });
  frame.appendChild(h('div', { class: 'toolbar' },
    h('div', { class: 'quick-actions' },
      selectAllOutOfScopeBtn,
      clearBtn,
      h('label', { style: { fontSize: '12px', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '5px', marginLeft: '4px' } },
        showInScopeToggle,
        ' Show in-scope'
      )
    ),
    searchInput
  ));

  // Table
  const tbody = h('tbody', {});
  const rowByPort = new Map();
  const outOfScopePortNames = [];

  for (const port of [...ports].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const isFortilink = String(port.name).toLowerCase() === FORTILINK;
    const admin = normStatus(port.admin_status);
    const oper = normStatus(port.oper_status);
    const inScope = Boolean(port.isActive);
    if (!inScope) outOfScopePortNames.push(port.name);

    const checkbox = h('input', { type: 'checkbox' });
    if (inScope) {
      checkbox.disabled = true;
    }
    const rowClasses = [];
    if (isFortilink) rowClasses.push('fortilink-warn');
    if (inScope) rowClasses.push('in-scope-muted');
    const tr = h('tr', { class: rowClasses.join(' ') },
      h('td', { class: 'col-check' }, checkbox),
      h('td', { class: 'col-name' },
        port.name,
        isFortilink ? h('span', { class: 'special-tag' }, 'fabric link') : null
      ),
      h('td', {}, port.descr ?? ''),
      h('td', { class: 'col-status' },
        h('span', { class: `scope-badge ${inScope ? 'in' : 'out'}` }, inScope ? 'Yes' : 'No')
      ),
      h('td', { class: 'col-status' }, statusBadge(admin)),
      h('td', { class: 'col-status' }, statusBadge(oper))
    );

    if (!inScope && decision.addPortNames.includes(port.name)) {
      checkbox.checked = true;
      tr.classList.add('row-checked');
    }

    checkbox.addEventListener('change', () => {
      if (inScope) return; // shouldn't fire; disabled
      if (checkbox.checked) {
        if (!decision.addPortNames.includes(port.name)) decision.addPortNames.push(port.name);
        tr.classList.add('row-checked');
      } else {
        decision.addPortNames = decision.addPortNames.filter((n) => n !== port.name);
        tr.classList.remove('row-checked');
      }
      updateActionSummary();
    });

    rowByPort.set(port.name, { tr, checkbox, inScope });
    tbody.appendChild(tr);
  }

  frame.appendChild(h('div', { class: 'table-wrap' },
    h('table', { class: 'ports-table' },
      h('thead', {},
        h('tr', {},
          h('th', { class: 'col-check' }),
          h('th', { class: 'col-name' }, 'Port Name'),
          h('th', {}, 'Description'),
          h('th', { class: 'col-status' }, 'In Scope'),
          h('th', { class: 'col-status' }, 'Admin'),
          h('th', { class: 'col-status' }, 'Operational')
        )
      ),
      tbody
    )
  ));

  // Action bar
  const queueBtn = h('button', { class: 'btn btn-primary btn-add' }, queueButtonLabel());
  const skipBtn = h('button', { class: 'btn btn-secondary' }, 'Skip this group');
  const leftSummary = h('span', {});
  frame.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, leftSummary),
    h('div', { class: 'right' }, skipBtn, queueBtn)
  ));

  container.appendChild(frame);

  // Default filter: hide in-scope rows
  applyInScopeFilter();

  // Filter logic
  searchInput.addEventListener('input', () => {
    applySearchFilter();
  });

  showInScopeToggle.addEventListener('change', () => {
    viewState.showInScope = showInScopeToggle.checked;
    applyInScopeFilter();
    applySearchFilter();
    // Update the "in scope" pill copy
    inScopePill.textContent = `${inScopeCount} in scope${viewState.showInScope ? '' : ' (hidden)'}`;
  });

  selectAllOutOfScopeBtn.addEventListener('click', () => {
    for (const [name, { tr, checkbox, inScope }] of rowByPort) {
      if (inScope) continue;
      if (!checkbox.checked) {
        checkbox.checked = true;
        if (!decision.addPortNames.includes(name)) decision.addPortNames.push(name);
        tr.classList.add('row-checked');
      }
    }
    updateActionSummary();
  });

  clearBtn.addEventListener('click', () => {
    decision.addPortNames = [];
    for (const { checkbox, tr, inScope } of rowByPort.values()) {
      if (inScope) continue;
      checkbox.checked = false;
      tr.classList.remove('row-checked');
    }
    updateActionSummary();
  });

  skipBtn.addEventListener('click', () => {
    decision.skipped = true;
    decision.addPortNames = [];
    setIndex(index + 1);
  });

  queueBtn.addEventListener('click', () => {
    decision.skipped = decision.addPortNames.length === 0;
    setIndex(index + 1);
  });

  updateActionSummary();

  function applyInScopeFilter() {
    for (const { tr, inScope } of rowByPort.values()) {
      tr.classList.toggle('hidden-scope', inScope && !viewState.showInScope);
    }
  }

  function applySearchFilter() {
    const q = searchInput.value.trim().toLowerCase();
    for (const [name, { tr }] of rowByPort) {
      const searchHide = q.length > 0 && !String(name).toLowerCase().includes(q);
      tr.classList.toggle('hidden', searchHide);
    }
  }

  function queueButtonLabel() {
    const n = decision.addPortNames.length;
    if (n === 0) return `Skip group →`;
    const lastLabel = groups.length - 1 === index ? 'to queue' : 'next group';
    return `Queue for ${deviceCount} device${deviceCount === 1 ? '' : 's'} · ${lastLabel} →`;
  }

  function updateActionSummary() {
    queueBtn.textContent = queueButtonLabel();
    if (decision.addPortNames.length === 0) {
      leftSummary.textContent = 'Nothing marked to add — this group will be skipped.';
      selectedPillWrap.style.display = 'none';
    } else {
      leftSummary.replaceChildren(
        'Marked to add: ',
        h('strong', { style: { color: 'var(--ok)', fontFamily: 'SF Mono, Menlo, monospace' } },
          decision.addPortNames.join(', ')),
        ` — applies to all ${deviceCount} device${deviceCount === 1 ? '' : 's'} in this group`
      );
      selectedPillWrap.style.display = '';
      selectedPillWrap.replaceChildren(
        `${decision.addPortNames.length} marked to add (× ${deviceCount} device${deviceCount === 1 ? '' : 's'})`
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

function computeQueuedCount(store, groups) {
  let n = 0;
  for (const g of groups) {
    const dec = store.decisions.get(g.fingerprint);
    if (dec && !dec.skipped && (dec.addPortNames?.length ?? 0) > 0) n += g.devices.length;
  }
  return n;
}
