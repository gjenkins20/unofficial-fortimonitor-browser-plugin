// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-154: Deployment Snapshot & Diff tool UI.
// FMN-161: per-slot Download + Import baseline affordances.
// Phase 2.3: snapshot picker dropdowns for arbitrary baseline/current
// pairings out of the N-deep history.

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('data-')) node.setAttribute(k, v);
    else node[k] = v;
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

function formatTs(iso) {
  if (!iso) return 'never';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch { return iso; }
}

function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (r) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!r) return reject(new Error('No response'));
      if (r.ok) return resolve(r.result);
      reject(new Error(r.error || 'Unknown error'));
    });
  });
}

// FMN-161: ask the SW for an export envelope, then trigger a browser
// download. We deliberately keep blob creation in the page (not the SW)
// because Blob + URL.createObjectURL aren't available in MV3 SWs and
// chrome.downloads requires a permission we'd otherwise have no use for.
async function downloadSlot(slot) {
  const result = await sendMessage('bpa-snapshots:export', { slot });
  if (!result?.filename || !result?.contents) {
    throw new Error('Service worker returned no export payload.');
  }
  const blob = new Blob([result.contents], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Free the object URL on the next tick so the click had time to start
    // the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return result.filename;
}

// Module state. Selections are sticky across re-renders so an Import or a
// "Take Snapshot Now" elsewhere doesn't wipe the operator's pick. The
// activeTab persists too so switching pairs doesn't kick the operator
// back to the Instances tab.
const state = {
  items: [],
  baselineId: null,
  currentId: null,
  activeTab: 'servers',
};

// Tab definitions for the multi-tab diff viewer (Phase 2.4). Each entry
// declares which diff section it renders and how to pull a row label /
// entity-id from a section's added/removed/modified row shape.
const TABS = [
  {
    key: 'servers',
    label: 'Instances',
    entityHeader: 'Server',
    label_of: (row) => row.current?.name || row.previous?.name || '(unnamed)',
    detail_of: (row) => row.current?.fqdn || row.previous?.fqdn || '',
  },
  {
    key: 'server_templates',
    label: 'Templates',
    entityHeader: 'Template',
    label_of: (row) => row.current?.name || row.previous?.name || '(unnamed)',
    detail_of: (row) => row.current?.template_type || row.previous?.template_type || '',
  },
  {
    key: 'users',
    label: 'Users',
    entityHeader: 'User',
    label_of: (row) => {
      const u = row.current || row.previous || {};
      const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
      return fullName || u.username || '(unknown)';
    },
    detail_of: (row) => row.current?.username || row.previous?.username || '',
  },
  {
    key: 'server_groups',
    label: 'Server Groups',
    entityHeader: 'Group',
    label_of: (row) => row.current?.name || row.previous?.name || '(unnamed)',
    detail_of: () => '',
  },
];

function summaryLabel(item) {
  const ts = formatTs(item.takenAt);
  const customer = item.customer?.name || item.customer?.subdomain;
  return customer ? `${ts}  -  ${customer}` : ts;
}

function pickInitialSelections(items) {
  // Prefer the slots the SW exposed: current = newest, previous = second.
  const current = items.find((s) => s.slot === 'current') ?? items[0] ?? null;
  let baseline = items.find((s) => s.slot === 'previous');
  if (!baseline) baseline = items.find((s) => s !== current) ?? null;
  return {
    currentId: current?.id ?? null,
    baselineId: baseline?.id ?? null,
  };
}

function renderSelect({ id, items, selectedId, disabled }) {
  const select = el('select', { class: 'snapshot-select', id });
  if (disabled) select.disabled = true;
  if (items.length === 0) {
    select.appendChild(el('option', { value: '', text: '(no snapshots yet)' }));
    return select;
  }
  for (const item of items) {
    const opt = el('option', { value: item.id, text: summaryLabel(item) });
    if (item.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  }
  return select;
}

function renderPicker() {
  const row = document.getElementById('picker-row');
  row.innerHTML = '';

  const items = state.items;
  const hasItems = items.length > 0;
  const baselineItem = items.find((s) => s.id === state.baselineId) || null;
  const currentItem = items.find((s) => s.id === state.currentId) || null;

  const baselineSelect = renderSelect({
    id: 'baseline-select',
    items,
    selectedId: state.baselineId,
    disabled: !hasItems,
  });
  const currentSelect = renderSelect({
    id: 'current-select',
    items,
    selectedId: state.currentId,
    disabled: !hasItems,
  });

  baselineSelect.addEventListener('change', () => {
    state.baselineId = baselineSelect.value || null;
    void renderDiff();
  });
  currentSelect.addEventListener('change', () => {
    state.currentId = currentSelect.value || null;
    void renderDiff();
  });

  const prevActions = el('div', { class: 'slot-actions' });
  const prevBtn = el('button', { type: 'button', class: 'slot-btn', id: 'download-previous' }, 'Download');
  prevBtn.disabled = !baselineItem;
  prevActions.appendChild(prevBtn);

  const currActions = el('div', { class: 'slot-actions' });
  const currBtn = el('button', { type: 'button', class: 'slot-btn', id: 'download-current' }, 'Download');
  currBtn.disabled = !currentItem;
  currActions.appendChild(currBtn);

  row.appendChild(el('div', { class: 'panel' },
    el('div', { class: 'picker' },
      el('div', { class: 'pick' },
        el('div', { class: 'label', text: 'Baseline' }),
        baselineSelect,
        prevActions,
      ),
      el('div', { class: 'arrow', text: '→' }),
      el('div', { class: 'pick' },
        el('div', { class: 'label', text: 'Compare to' }),
        currentSelect,
        currActions,
      ),
    )
  ));
}

function renderIoPanel() {
  const row = document.getElementById('io-row');
  row.innerHTML = '';
  const fileInput = el('input', { type: 'file', id: 'import-file', accept: 'application/json,.json' });
  const importBtn = el('button', { type: 'button', class: 'primary', id: 'import-baseline' }, 'Import baseline...');
  const status = el('span', { class: 'status', id: 'import-status' });
  const panel = el('div', { class: 'panel' },
    el('div', { class: 'io-panel' },
      el('span', { class: 'label', text: 'Import baseline' }),
      importBtn,
      status,
      fileInput,
      el('p', { class: 'hint' },
        'Loads a previously-downloaded snapshot file into the baseline (previous) slot ',
        'so you can diff it against the live current snapshot.'
      ),
    ),
  );
  row.appendChild(panel);
}

function renderCounts(counts) {
  return el('div', { class: 'panel' },
    el('div', { class: 'counts' },
      el('span', { class: 'count-chip added' },
        el('strong', { text: String(counts.added) }), ' added'),
      el('span', { class: 'count-chip removed' },
        el('strong', { text: String(counts.removed) }), ' removed'),
      el('span', { class: 'count-chip modified' },
        el('strong', { text: String(counts.modified) }), ' modified'),
    )
  );
}

function renderFieldList(fields) {
  const ul = el('ul', { class: 'field-list' });
  for (const f of fields) {
    const li = el('li');
    li.appendChild(el('code', { text: f.name }));
    li.appendChild(document.createTextNode(' '));
    li.appendChild(el('span', { class: 'prev', text: JSON.stringify(f.prev ?? '') }));
    li.appendChild(document.createTextNode(' '));
    li.appendChild(el('span', { class: 'arr', text: '→' }));
    li.appendChild(document.createTextNode(' '));
    li.appendChild(el('span', { class: 'next', text: JSON.stringify(f.next ?? '') }));
    ul.appendChild(li);
  }
  return ul;
}

function renderDiffTable(diff, tab) {
  const tbl = el('table', { class: 'diff' });
  const thead = el('thead');
  thead.appendChild(el('tr', {},
    el('th', { text: 'Change' }),
    el('th', { text: tab.entityHeader }),
    el('th', { text: 'ID' }),
    el('th', { text: 'Details' }),
  ));
  tbl.appendChild(thead);
  const tbody = el('tbody');

  for (const r of diff.added) {
    tbody.appendChild(el('tr', {},
      el('td', {}, el('span', { class: 'change-badge added', text: 'added' })),
      el('td', { text: tab.label_of(r) }),
      el('td', { text: String(r.id) }),
      el('td', { text: tab.detail_of(r) }),
    ));
  }
  for (const r of diff.removed) {
    tbody.appendChild(el('tr', {},
      el('td', {}, el('span', { class: 'change-badge removed', text: 'removed' })),
      el('td', { text: tab.label_of(r) }),
      el('td', { text: String(r.id) }),
      el('td', { text: tab.detail_of(r) }),
    ));
  }
  for (const r of diff.modified) {
    tbody.appendChild(el('tr', {},
      el('td', {}, el('span', { class: 'change-badge modified', text: 'modified' })),
      el('td', { text: tab.label_of(r) }),
      el('td', { text: String(r.id) }),
      el('td', {}, renderFieldList(r.fields)),
    ));
  }

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
    tbody.appendChild(el('tr', {},
      el('td', { colSpan: 4, style: 'text-align:center;color:#7c8896;font-style:italic;padding:18px;' },
        `No ${tab.label.toLowerCase()} changes between the two snapshots.`),
    ));
  }
  tbl.appendChild(tbody);
  return el('div', { class: 'panel' }, tbl);
}

function sectionTotal(diff) {
  return (diff?.added?.length ?? 0) + (diff?.removed?.length ?? 0) + (diff?.modified?.length ?? 0);
}

function renderTabStrip(sections, onSelect) {
  const strip = el('div', { class: 'tab-strip' });
  for (const tab of TABS) {
    const total = sectionTotal(sections[tab.key]);
    const btn = el('button', { type: 'button', class: 'tab' + (tab.key === state.activeTab ? ' active' : '') },
      tab.label,
      el('span', { class: 'tab-count' + (total > 0 ? ' nonzero' : ''), text: String(total) }),
    );
    btn.addEventListener('click', () => onSelect(tab.key));
    strip.appendChild(btn);
  }
  return strip;
}

function renderEmpty(message, isError = false) {
  return el('div', { class: 'panel' },
    el('div', { class: isError ? 'empty-state error' : 'empty-state', text: message }),
  );
}

function setImportStatus(text, kind = '') {
  const status = document.getElementById('import-status');
  if (!status) return;
  status.textContent = text;
  status.className = `status${kind ? ' ' + kind : ''}`;
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('FileReader error'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
}

async function sendImport(envelope, { force }) {
  return sendMessage('bpa-snapshots:import', { envelope, force: Boolean(force) });
}

// FMN-161: returns true on success, false on user-cancelled overwrite,
// throws on any other failure. The caller is responsible for refreshing
// the page render and surfacing exceptions in the status line.
async function handleImportFile(file) {
  setImportStatus(`Reading ${file.name}...`, '');
  const text = await readFileAsText(file);
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (err) {
    throw new Error(`File is not valid JSON: ${err?.message || 'parse failed'}.`);
  }
  let result = await sendImport(envelope, { force: false });
  if (result?.ok) {
    setImportStatus(`Imported baseline from ${file.name} (taken ${formatTs(result.previousTakenAt)}).`, 'ok');
    return true;
  }
  // ok:false branch - either previous-exists (needs confirmation) or a
  // schema-validation error from the snapshot-io layer.
  if (result?.reason === 'previous-exists') {
    const dialog = document.getElementById('confirm-import');
    const body = document.getElementById('confirm-import-body');
    body.textContent =
      `Existing baseline: ${formatTs(result.existingPreviousTakenAt)}. ` +
      `Incoming: ${formatTs(result.incomingTakenAt)}.`;
    const okBtn = document.getElementById('confirm-import-ok');
    const cancelBtn = document.getElementById('confirm-import-cancel');
    const confirmed = await new Promise((resolve) => {
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      const cleanup = () => {
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
      };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      dialog.showModal();
    });
    dialog.close();
    if (!confirmed) {
      setImportStatus('Import cancelled. The existing baseline is unchanged.', '');
      return false;
    }
    result = await sendImport(envelope, { force: true });
    if (result?.ok) {
      setImportStatus(
        `Replaced baseline with ${file.name} (taken ${formatTs(result.previousTakenAt)}).`,
        'ok'
      );
      return true;
    }
  }
  throw new Error(result?.message || result?.reason || 'Import rejected by the service worker.');
}

function wireSlotDownloads() {
  // Download buttons still address the underlying current/previous slot.
  // Until the SW grows a download-by-id surface, the dropdown is for
  // diff-pair selection and the Download button always exports the slot
  // attached to that picker side.
  const wire = (btnId, slot) => {
    const btn = document.getElementById(btnId);
    if (!btn || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = 'Preparing...';
      try {
        await downloadSlot(slot);
        btn.textContent = 'Downloaded';
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
      } catch (err) {
        btn.textContent = orig;
        btn.disabled = false;
        setImportStatus(`Download failed: ${err?.message || err}`, 'err');
      }
    });
  };
  wire('download-previous', 'previous');
  wire('download-current', 'current');
}

function wireImport() {
  const btn = document.getElementById('import-baseline');
  const fileInput = document.getElementById('import-file');
  if (!btn || !fileInput || btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    btn.disabled = true;
    try {
      const refreshed = await handleImportFile(file);
      if (refreshed) await render();
    } catch (err) {
      setImportStatus(`Import failed: ${err?.message || err}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

function ensureIoPanel() {
  // Render the import / status panel exactly once. render() can be called
  // multiple times (e.g. after a successful import refresh), but we want
  // the status line set by a prior action to survive a re-render so the
  // operator can still see "Imported baseline ..." after the picker
  // refreshes. Re-wiring is a no-op because the button handlers gate on
  // dataset.wired.
  if (document.getElementById('import-baseline')) return;
  renderIoPanel();
  wireImport();
}

async function renderDiff() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  if (state.items.length === 0) {
    content.appendChild(renderEmpty('No snapshots stored yet. Take one from the FortiMonitor Reports page.'));
    return;
  }
  if (state.items.length === 1) {
    content.appendChild(renderEmpty('Only one snapshot stored. Take another snapshot after time has passed to compare.'));
    return;
  }
  if (!state.baselineId || !state.currentId) {
    content.appendChild(renderEmpty('Pick a baseline and a current snapshot to diff.'));
    return;
  }
  if (state.baselineId === state.currentId) {
    content.appendChild(renderEmpty('Baseline and current are the same snapshot.'));
    return;
  }
  try {
    const diff = await sendMessage('bpa-snapshots:diff', {
      baselineId: state.baselineId,
      currentId: state.currentId,
    });
    if (!diff || diff.ok === false) {
      content.appendChild(renderEmpty(diff?.message || 'No diff available.'));
      return;
    }
    const sections = diff.sections || { servers: diff.servers };
    // Tab strip with per-section change counts.
    content.appendChild(renderTabStrip(sections, (key) => {
      state.activeTab = key;
      void renderDiff();
    }));
    // Active section: counts chips + diff table.
    const activeSection = sections[state.activeTab] || sections.servers;
    const activeTab = TABS.find((t) => t.key === state.activeTab) || TABS[0];
    if (activeSection) {
      content.appendChild(renderCounts({
        added: activeSection.added.length,
        removed: activeSection.removed.length,
        modified: activeSection.modified.length,
      }));
      content.appendChild(renderDiffTable(activeSection, activeTab));
    }
  } catch (err) {
    content.appendChild(renderEmpty(`Failed to load diff: ${err?.message || err}`, true));
  }
}

async function render() {
  ensureIoPanel();
  // Refresh the snapshot list; selections persist if the picked IDs are
  // still present.
  let list = null;
  try {
    list = await sendMessage('bpa-snapshots:list');
  } catch (err) {
    state.items = [];
    state.baselineId = null;
    state.currentId = null;
    renderPicker();
    wireSlotDownloads();
    const content = document.getElementById('content');
    content.innerHTML = '';
    content.appendChild(renderEmpty(`Failed to load snapshot list: ${err?.message || err}`, true));
    return;
  }
  state.items = Array.isArray(list?.items) ? list.items : [];
  const ids = new Set(state.items.map((s) => s.id));
  if (!ids.has(state.baselineId) || !ids.has(state.currentId)) {
    const seeds = pickInitialSelections(state.items);
    if (!ids.has(state.baselineId)) state.baselineId = seeds.baselineId;
    if (!ids.has(state.currentId)) state.currentId = seeds.currentId;
  }
  renderPicker();
  wireSlotDownloads();
  await renderDiff();
}

function setVersion() {
  const versionEl = document.getElementById('version');
  if (versionEl) versionEl.textContent = 'v' + chrome.runtime.getManifest().version;
}

document.addEventListener('DOMContentLoaded', () => {
  setVersion();
  render();
});
