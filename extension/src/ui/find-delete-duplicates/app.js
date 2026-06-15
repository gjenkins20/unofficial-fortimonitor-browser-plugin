// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-269: Find & Delete Duplicates - top-level tool controller.
//
// Three steps, unifying the two primitives:
//   find    - run analyzeDuplicates over the live /v2/server list (FMN-268)
//   choose  - pick which instance to KEEP in each duplicate set (default: oldest)
//   confirm - delete the redundant instances through the SAME confirmed delete
//             path as the Bulk Action Composer (FMN-267): bulk-composer:commit
//             with actionId 'delete-instance' + the type-to-confirm gate.
//
// Terminology: a "duplicate set" is instances that match each other (shared
// name or address), NOT a FortiMonitor instance group.

import { h, titleBar, downloadBlob } from '../../lib/dom.js';
import { call, onEvent } from '../../lib/messaging.js';
import { buildDeleteSet, defaultKeepMap, buildDuplicatesCsv, KEEP_ALL } from '../../lib/find-delete-duplicates/delete-set.js';
import { CONFIRM_PHRASE } from '../../lib/bulk-actions/delete-instance.js';

const TOOL_NAME = 'Find & Delete Duplicates';

// Exported for the live e2e spec, which drives renderChoose/renderConfirm
// with injected duplicate sets so the populated render + confirm gate are
// covered deterministically (the live tenant may have zero duplicates).
export const store = {
  result: null,      // analyzeDuplicates() result + { scanned }
  keepMap: {},       // setKey -> keptId
  plan: null,        // buildDeleteSet() output
  runResult: null
};

// Commit row events and find-progress events fan out to whatever the active
// step registered.
let rowListener = null;
let progressListener = null;
onEvent((event, payload) => {
  if (rowListener) rowListener(event, payload);
  if (progressListener) progressListener(event, payload);
});

const root = () => document.getElementById('app-root');

function frame(title) {
  const f = h('div', { class: 'mockup-frame' });
  f.appendChild(titleBar(title, { toolName: TOOL_NAME }));
  return f;
}

function mount(node) {
  const r = root();
  r.innerHTML = '';
  r.appendChild(node);
}

// --------------------------------------------------------------------------
// Step 1: Find
// --------------------------------------------------------------------------
export function renderFind() {
  const f = frame('Find duplicates');
  const body = h('div', { class: 'body-section' });
  f.appendChild(h('div', { class: 'step-header' },
    h('h2', {}, 'Find duplicate instances'),
    h('p', {}, 'Scans every monitored instance and flags those that share a name or an IP address - likely the same device onboarded or monitored more than once.')
  ));
  f.appendChild(body);

  // Progress area (hidden until Find runs): a live count, an elapsed timer, and
  // a determinate bar (driven by find-delete-duplicates:find-progress; the
  // total comes from the v2 list meta). This is the visual proof that the scan
  // is working (FMN-271).
  const countEl = h('span', { 'data-test': 'find-progress-count' }, '');
  const elapsedEl = h('span', { 'data-test': 'find-elapsed', style: 'font-variant-numeric:tabular-nums;' }, '');
  const bar = h('div', { 'data-test': 'find-progress-bar', style: 'height:8px;width:0%;background:var(--accent,#d9534f);border-radius:4px;transition:width 0.15s ease-out;' });
  const progressWrap = h('div', { 'data-test': 'find-progress', hidden: true, style: 'margin:0.6rem 0;' },
    h('div', { style: 'display:flex;justify-content:space-between;font-size:0.8rem;color:var(--text-muted);margin-bottom:0.3rem;' }, countEl, elapsedEl),
    h('div', { style: 'background:#eee;border-radius:4px;overflow:hidden;' }, bar)
  );
  body.appendChild(progressWrap);

  const state = h('span', { class: 'execute-state muted', 'data-test': 'find-state' }, '');
  const findBtn = h('button', { class: 'btn btn-primary', 'data-test': 'find-btn', type: 'button' }, 'Find duplicates');
  f.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, state),
    h('div', { class: 'right' }, findBtn)
  ));
  mount(f);

  findBtn.addEventListener('click', async () => {
    findBtn.disabled = true;
    state.textContent = '';
    state.className = 'execute-state';
    progressWrap.hidden = false;
    countEl.textContent = 'Starting scan...';
    bar.style.width = '0%';
    const t0 = Date.now();
    const tick = () => { elapsedEl.textContent = `Elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`; };
    tick();
    const timer = setInterval(tick, 100);
    progressListener = (event, payload) => {
      if (event !== 'find-delete-duplicates:find-progress') return;
      const scanned = Number(payload?.scanned ?? 0);
      const total = Number(payload?.total);
      if (Number.isFinite(total) && total > 0) {
        const pct = Math.min(100, Math.round((scanned / total) * 100));
        bar.style.width = `${pct}%`;
        bar.style.opacity = '1';
        countEl.textContent = `Scanned ${scanned} of ${total} instances (${pct}%)`;
      } else {
        // No total from the API: indeterminate - show the running count and a
        // faint full bar so it still reads as "working".
        bar.style.width = '100%';
        bar.style.opacity = '0.35';
        countEl.textContent = `Scanned ${scanned} instances...`;
      }
    };
    try {
      const result = await call('find-delete-duplicates:find', {});
      store.result = result;
      store.findElapsedMs = Date.now() - t0;
      store.keepMap = defaultKeepMap(result?.groups || []);
      renderChoose();
    } catch (err) {
      state.textContent = `Error: ${err?.message ?? err}`;
      state.className = 'execute-state error';
      findBtn.disabled = false;
      progressWrap.hidden = true;
    } finally {
      clearInterval(timer);
      progressListener = null;
    }
  });
}

// --------------------------------------------------------------------------
// Step 2: Choose what to keep
// --------------------------------------------------------------------------
export function renderChoose() {
  const result = store.result || {};
  const sets = Array.isArray(result.groups) ? result.groups : [];
  const f = frame('Choose what to keep');
  const elapsedNote = Number.isFinite(store.findElapsedMs) ? ` in ${(store.findElapsedMs / 1000).toFixed(1)}s` : '';
  f.appendChild(h('div', { class: 'step-header' },
    h('h2', {}, `Duplicate sets: ${sets.length}`),
    h('p', {}, `Scanned ${result.scanned ?? 0} instance${result.scanned === 1 ? '' : 's'}${elapsedNote}. In each duplicate set, pick the one instance to KEEP; the rest are marked for deletion. You can never delete every instance in a set.`)
  ));
  const body = h('div', { class: 'body-section' });
  f.appendChild(body);

  if (sets.length === 0) {
    body.appendChild(h('p', { class: 'muted', 'data-test': 'choose-empty', style: 'font-size:0.9rem;' },
      'No duplicate instances detected (no shared names or addresses across instances).'));
    const backBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, '← Start over');
    f.appendChild(h('div', { class: 'action-bar' }, h('div', { class: 'left' }), h('div', { class: 'right' }, backBtn)));
    mount(f);
    backBtn.addEventListener('click', renderFind);
    return;
  }

  const footer = h('span', { class: 'execute-state', 'data-test': 'choose-summary' }, '');
  function refreshSummary() {
    const plan = buildDeleteSet(sets, store.keepMap);
    footer.textContent = `Will delete ${plan.deleteIds.length} instance${plan.deleteIds.length === 1 ? '' : 's'} · keeping ${plan.keptIds.length}`;
    return plan;
  }

  // One card per duplicate set. `key` is the set's index in the FULL groups
  // array (so it matches buildDeleteSet / keepMap), NOT its position within a
  // section.
  function renderSetCard(set, key) {
    const card = h('div', {
      'data-test': 'dup-set',
      'data-set-key': key,
      'data-axis': set.axis,
      'data-intentional': set.likely_intentional ? 'true' : 'false',
      style: `border:1px solid ${set.likely_intentional ? '#cdb86a' : 'var(--border)'};border-radius:6px;padding:0.7rem 0.85rem;margin-bottom:0.7rem;${set.likely_intentional ? 'background:#fcf9ee;' : ''}`
    });
    card.appendChild(h('div', { style: 'font-weight:600;font-size:0.9rem;margin-bottom:0.2rem;' },
      h('code', {}, set.value),
      h('span', { class: 'muted', style: 'font-weight:400;color:var(--text-muted);' }, ` · ${set.members.length} instances`)
    ));
    if (set.likely_intentional) {
      card.appendChild(h('div', { 'data-test': 'intentional-flag', style: 'font-size:0.78rem;color:#8a6d1a;margin-bottom:0.4rem;' },
        '⚑ Likely intentional - members are monitored from different locations (kept by default).'));
    }

    // Repaint every member row's KEEP/delete badge from the current selection.
    function paint() {
      const sel = store.keepMap[key];
      card.querySelectorAll('[data-test="member-row"]').forEach((rowEl) => {
        const isKeep = sel === KEEP_ALL || rowEl.dataset.id === sel;
        const badge = rowEl.querySelector('[data-test="disposition"]');
        badge.textContent = isKeep ? 'KEEP' : 'delete';
        badge.style.color = isKeep ? '#0e5a2b' : '#a02216';
      });
    }

    // "Keep all (do not delete)" option - default for likely-intentional sets.
    const keepAllChecked = String(store.keepMap[key]) === KEEP_ALL;
    const keepAllRadio = h('input', {
      type: 'radio', name: `keep-${key}`, value: KEEP_ALL, 'data-test': 'keep-all-radio',
      ...(keepAllChecked ? { checked: 'checked' } : {})
    });
    keepAllRadio.addEventListener('change', () => { store.keepMap[key] = KEEP_ALL; refreshSummary(); paint(); });
    card.appendChild(h('label', { style: 'display:flex;align-items:center;gap:0.5rem;padding:0.2rem 0;font-size:0.82rem;cursor:pointer;color:var(--text-muted);' },
      keepAllRadio, h('span', {}, 'Keep all (do not delete any in this set)')));

    for (const member of set.members) {
      const id = String(member.id);
      const checked = String(store.keepMap[key]) === id;
      const isKeep = keepAllChecked || checked;
      const radio = h('input', {
        type: 'radio', name: `keep-${key}`, value: id, 'data-test': 'keep-radio',
        ...(checked ? { checked: 'checked' } : {})
      });
      radio.addEventListener('change', () => { store.keepMap[key] = id; refreshSummary(); paint(); });
      card.appendChild(h('label', {
        'data-test': 'member-row', 'data-id': id,
        style: 'display:flex;align-items:center;gap:0.5rem;padding:0.2rem 0;font-size:0.85rem;cursor:pointer;'
      },
        radio,
        h('span', { style: 'font-family:"SF Mono",Menlo,monospace;color:var(--text-muted);min-width:90px;' }, `#${id}`),
        h('span', { style: 'flex:1;' }, member.name || '(no name)'),
        h('span', { class: 'muted', style: 'color:var(--text-muted);min-width:120px;' }, member.address || ''),
        h('span', { 'data-test': 'member-location', class: 'muted', title: 'Monitoring location', style: 'color:var(--text-muted);min-width:130px;' }, member.location || '—'),
        h('span', { 'data-test': 'member-created', class: 'muted', title: 'Created', style: 'color:var(--text-muted);min-width:90px;font-variant-numeric:tabular-nums;' }, member.created || '—'),
        h('span', { 'data-test': 'disposition', style: `min-width:54px;text-align:right;font-weight:600;color:${isKeep ? '#0e5a2b' : '#a02216'};` }, isKeep ? 'KEEP' : 'delete')
      ));
    }
    return card;
  }

  // FMN-272: name-based and IP-based duplicates go in separate, clearly
  // labelled sections (combining them read as unhelpful). Keys are the
  // original full-array indices.
  const entries = sets.map((set, i) => ({ set, key: String(i) }));
  function renderAxisSection(axis, label) {
    const section = h('div', { 'data-test': 'dup-section', 'data-axis': axis, style: 'margin-bottom:1.1rem;' });
    const items = entries.filter((e) => e.set.axis === axis);
    section.appendChild(h('h3', { class: 'subhead', style: 'margin:0 0 0.5rem;font-size:0.95rem;' },
      `${label} `, h('span', { class: 'muted', style: 'font-weight:400;color:var(--text-muted);' }, `(${items.length})`)));
    if (items.length === 0) {
      section.appendChild(h('p', { class: 'muted', 'data-test': 'dup-section-empty', style: 'font-size:0.85rem;color:var(--text-muted);' }, 'None found.'));
    } else {
      for (const e of items) section.appendChild(renderSetCard(e.set, e.key));
    }
    return section;
  }
  body.appendChild(renderAxisSection('name', 'Duplicates by name'));
  body.appendChild(renderAxisSection('address', 'Duplicates by IP address'));

  const backBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, '← Start over');
  const csvBtn = h('button', { class: 'btn btn-secondary', 'data-test': 'export-duplicates-csv', type: 'button' }, 'Export CSV');
  const nextBtn = h('button', { class: 'btn btn-primary', 'data-test': 'choose-next', type: 'button' }, 'Review deletions →');
  f.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, footer),
    h('div', { class: 'right' }, backBtn, csvBtn, nextBtn)
  ));
  mount(f);
  refreshSummary();

  backBtn.addEventListener('click', renderFind);
  csvBtn.addEventListener('click', () => {
    downloadBlob(
      `duplicate-instances-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`,
      'text/csv',
      buildDuplicatesCsv(sets, store.keepMap)
    );
  });
  nextBtn.addEventListener('click', () => {
    store.plan = buildDeleteSet(sets, store.keepMap);
    if (store.plan.deleteIds.length === 0) {
      footer.textContent = 'Nothing selected for deletion - every duplicate is currently kept.';
      footer.className = 'execute-state';
      return;
    }
    renderConfirm();
  });
}

// --------------------------------------------------------------------------
// Step 3: Confirm + delete
// --------------------------------------------------------------------------
export function renderConfirm() {
  const plan = store.plan;
  const targets = plan.deleteTargets;
  const f = frame('Confirm deletion');
  f.appendChild(h('div', { class: 'step-header' },
    h('h2', {}, `Delete ${targets.length} redundant instance${targets.length === 1 ? '' : 's'}`),
    h('p', {}, `Keeping ${plan.keptIds.length} instance${plan.keptIds.length === 1 ? '' : 's'} (one per duplicate set). The instances below will be permanently deleted.`)
  ));
  const body = h('div', { class: 'body-section' });
  f.appendChild(body);

  const tableWrap = h('div', { style: 'max-height:360px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;' });
  const table = h('table', { 'data-test': 'delete-table', style: 'width:100%;border-collapse:collapse;font-size:0.85rem;' });
  table.appendChild(h('thead', { style: 'background:#fafbfc;position:sticky;top:0;' },
    h('tr', {},
      h('th', { style: thStyle() }, 'Instance ID'),
      h('th', { style: thStyle() }, 'Name'),
      h('th', { style: thStyle() }, 'Status'))
  ));
  const tbody = h('tbody');
  const rowById = new Map();
  for (const t of targets) {
    const statusEl = h('span', {
      class: 'status pending', 'data-test': 'delete-status',
      style: 'font-size:0.75rem;padding:0.1rem 0.45rem;border-radius:10px;background:#fde0dc;color:#a02216;'
    }, 'will delete');
    const tr = h('tr', { 'data-test': 'delete-row', 'data-id': String(t.id), style: 'border-bottom:1px solid var(--border);' },
      h('td', { style: tdStyle() + 'font-family:\"SF Mono\",Menlo,monospace;' }, `#${t.id}`),
      h('td', { style: tdStyle() }, t.name || '(no name)'),
      h('td', { style: tdStyle() }, statusEl)
    );
    tbody.appendChild(tr);
    rowById.set(String(t.id), statusEl);
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  body.appendChild(tableWrap);

  if (plan.sparedByKeepElsewhere.length > 0) {
    body.appendChild(h('p', { class: 'muted', 'data-test': 'spared-note', style: 'font-size:0.8rem;color:var(--text-muted);margin-top:0.5rem;' },
      `${plan.sparedByKeepElsewhere.length} instance(s) appeared in more than one duplicate set and are kept (a "keep" choice always wins over a delete elsewhere).`));
  }

  // Irreversibility + type-to-confirm gate (same phrase + contract as FMN-267).
  const applyBtn = h('button', { class: 'btn btn-primary', 'data-test': 'apply-btn', type: 'button', disabled: true }, `Delete ${targets.length} instance${targets.length === 1 ? '' : 's'}`);
  const confirmInput = h('input', {
    type: 'text', 'data-test': 'delete-confirm-input', autocomplete: 'off', spellcheck: 'false', placeholder: CONFIRM_PHRASE,
    style: 'margin-top:0.4rem;padding:0.4rem 0.55rem;border:1px solid #e0a9a0;border-radius:4px;font-family:"SF Mono",Menlo,monospace;font-size:0.9rem;width:220px;'
  });
  body.appendChild(h('div', {
    'data-test': 'delete-confirm-gate',
    style: 'margin-top:0.8rem;border:1px solid #e0a9a0;background:#fdf3f1;border-radius:6px;padding:0.8rem 1rem;'
  },
    h('div', { style: 'font-weight:600;color:#a02216;font-size:0.92rem;' }, 'Permanent deletion'),
    h('div', { style: 'font-size:0.84rem;color:var(--text);margin-top:0.25rem;' },
      'This cannot be undone. Agent resources and metric history are destroyed, not suspended. Type ',
      h('code', { style: 'font-weight:700;' }, CONFIRM_PHRASE), ' below to enable the delete button.'),
    confirmInput
  ));

  const runSummary = h('span', { class: 'execute-state muted', 'data-test': 'run-summary' }, '');
  const backBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, '← Back');
  const exportBtn = h('button', { class: 'btn btn-secondary', 'data-test': 'export-csv', type: 'button', disabled: true }, 'Export CSV');
  f.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, runSummary),
    h('div', { class: 'right' }, backBtn, exportBtn, applyBtn)
  ));
  mount(f);

  confirmInput.addEventListener('input', () => {
    applyBtn.disabled = confirmInput.value !== CONFIRM_PHRASE;
  });
  backBtn.addEventListener('click', () => { rowListener = null; renderChoose(); });

  let done = 0, succeeded = 0, failed = 0, skipped = 0;
  rowListener = (event, payload) => {
    if (event === 'bulk-composer:row-start') {
      const el = rowById.get(String(payload?.id));
      if (el) { el.textContent = 'deleting'; el.style.background = '#fff7cc'; el.style.color = '#7a5b00'; }
    } else if (event === 'bulk-composer:row-done') {
      const el = rowById.get(String(payload?.id));
      if (el) {
        if (payload.status === 'succeeded' && payload.noop) { el.textContent = 'already gone'; el.style.background = '#e6f4ea'; el.style.color = '#1b6033'; }
        else if (payload.status === 'succeeded') { el.textContent = 'deleted'; el.style.background = '#d4f0dc'; el.style.color = '#0e5a2b'; }
        else { el.textContent = 'failed'; el.style.background = '#fde0dc'; el.style.color = '#a02216'; el.title = payload.error || ''; }
      }
      done++;
      if (payload.status === 'succeeded' && payload.noop) skipped++;
      else if (payload.status === 'succeeded') succeeded++;
      else failed++;
      runSummary.textContent = `${done}/${targets.length} · ${succeeded} deleted · ${failed} failed · ${skipped} already gone`;
    }
  };

  applyBtn.addEventListener('click', async () => {
    if (applyBtn.disabled) return;
    if (applyBtn.dataset.mode === 'done') { rowListener = null; store.plan = null; store.runResult = null; renderFind(); return; }
    applyBtn.disabled = true; backBtn.disabled = true; confirmInput.disabled = true;
    runSummary.textContent = 'Deleting...'; runSummary.className = 'execute-state';
    try {
      const result = await call('bulk-composer:commit', {
        actionId: 'delete-instance',
        params: { confirm: confirmInput.value },
        targets: targets.map((t) => ({ id: t.id, name: t.name })),
        concurrency: 3
      });
      store.runResult = result;
      runSummary.textContent = `Done · ${result.succeeded} deleted · ${result.failed} failed · ${result.noops} already gone`;
      exportBtn.disabled = false;
      applyBtn.disabled = false; applyBtn.dataset.mode = 'done'; applyBtn.textContent = 'Find duplicates again';
      applyBtn.classList.remove('btn-primary'); applyBtn.classList.add('btn-secondary');
      backBtn.disabled = false;
    } catch (err) {
      runSummary.textContent = `Error: ${err?.message ?? err}`; runSummary.className = 'execute-state error';
      applyBtn.disabled = false; backBtn.disabled = false; confirmInput.disabled = false;
    }
  });

  exportBtn.addEventListener('click', () => {
    if (!store.runResult) return;
    downloadBlob(`find-delete-duplicates-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, 'text/csv', buildCsv(store.runResult));
  });
}

function buildCsv(result) {
  const lines = ['id,name,status,error'];
  for (const r of (result?.rows ?? [])) {
    const status = r.status === 'failed' ? 'failed' : (r.noop ? 'already-gone' : 'deleted');
    lines.push([csv(r.id), csv(r.name), csv(status), csv(r.error ?? '')].join(','));
  }
  return lines.join('\n');
}
function csv(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function thStyle() { return 'padding:0.45rem 0.6rem;text-align:left;font-weight:600;font-size:0.78rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;border-bottom:1px solid var(--border);'; }
function tdStyle() { return 'padding:0.4rem 0.6rem;vertical-align:top;'; }

document.addEventListener('DOMContentLoaded', renderFind);
