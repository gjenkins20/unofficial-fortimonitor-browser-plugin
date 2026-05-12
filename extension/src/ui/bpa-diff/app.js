// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-154: Deployment Snapshot & Diff tool UI (phase 1).
// FMN-161: per-slot Download + Import baseline affordances.
//
// Reads the current + previous snapshot via chrome.runtime.sendMessage
// and renders the inventory.servers diff. Two-slot model; multi-tab
// + N-rotation deferred to phase 2.

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

function renderPicker({ prevTakenAt, currTakenAt, hasCurrent, hasPrevious }) {
  const row = document.getElementById('picker-row');
  row.innerHTML = '';
  const prevActions = el('div', { class: 'slot-actions' });
  const prevBtn = el('button', { type: 'button', class: 'slot-btn', id: 'download-previous' }, 'Download');
  prevBtn.disabled = !hasPrevious;
  prevActions.appendChild(prevBtn);

  const currActions = el('div', { class: 'slot-actions' });
  const currBtn = el('button', { type: 'button', class: 'slot-btn', id: 'download-current' }, 'Download');
  currBtn.disabled = !hasCurrent;
  currActions.appendChild(currBtn);

  row.appendChild(el('div', { class: 'panel' },
    el('div', { class: 'picker' },
      el('div', { class: 'pick' },
        el('div', { class: 'label', text: 'Baseline (previous)' }),
        el('div', { class: 'val', text: formatTs(prevTakenAt) }),
        prevActions,
      ),
      el('div', { class: 'arrow', text: '→' }),
      el('div', { class: 'pick' },
        el('div', { class: 'label', text: 'Compare to (current)' }),
        el('div', { class: 'val', text: formatTs(currTakenAt) }),
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

function renderDiffTable(diff) {
  const tbl = el('table', { class: 'diff' });
  const thead = el('thead');
  thead.appendChild(el('tr', {},
    el('th', { text: 'Change' }),
    el('th', { text: 'Server' }),
    el('th', { text: 'ID' }),
    el('th', { text: 'Details' }),
  ));
  tbl.appendChild(thead);
  const tbody = el('tbody');

  for (const r of diff.added) {
    tbody.appendChild(el('tr', {},
      el('td', {}, el('span', { class: 'change-badge added', text: 'added' })),
      el('td', { text: r.current.name || '(unnamed)' }),
      el('td', { text: String(r.id) }),
      el('td', { text: r.current.fqdn || '' }),
    ));
  }
  for (const r of diff.removed) {
    tbody.appendChild(el('tr', {},
      el('td', {}, el('span', { class: 'change-badge removed', text: 'removed' })),
      el('td', { text: r.previous.name || '(unnamed)' }),
      el('td', { text: String(r.id) }),
      el('td', { text: r.previous.fqdn || '' }),
    ));
  }
  for (const r of diff.modified) {
    tbody.appendChild(el('tr', {},
      el('td', {}, el('span', { class: 'change-badge modified', text: 'modified' })),
      el('td', { text: r.current.name || r.previous.name || '(unnamed)' }),
      el('td', { text: String(r.id) }),
      el('td', {}, renderFieldList(r.fields)),
    ));
  }

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
    tbody.appendChild(el('tr', {},
      el('td', { colSpan: 4, style: 'text-align:center;color:#7c8896;font-style:italic;padding:18px;' },
        'No server changes between the two snapshots.'),
    ));
  }
  tbl.appendChild(tbody);
  return el('div', { class: 'panel' }, tbl);
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
  for (const slot of ['current', 'previous']) {
    const btn = document.getElementById(`download-${slot}`);
    if (!btn || btn.dataset.wired === '1') continue;
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
  }
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

async function render() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  ensureIoPanel();
  let status = null;
  try {
    status = await sendMessage('bpa-snapshots:status');
  } catch (err) {
    renderPicker({ prevTakenAt: null, currTakenAt: null, hasCurrent: false, hasPrevious: false });
    wireSlotDownloads();
    content.appendChild(renderEmpty(`Failed to load snapshot status: ${err?.message || err}`, true));
    return;
  }
  renderPicker({
    prevTakenAt: status?.previousTakenAt ?? null,
    currTakenAt: status?.currentTakenAt ?? null,
    hasCurrent: Boolean(status?.hasCurrent),
    hasPrevious: Boolean(status?.hasPrevious),
  });
  wireSlotDownloads();
  try {
    const diff = await sendMessage('bpa-snapshots:diff');
    if (!diff || diff.ok === false) {
      content.appendChild(renderEmpty(diff?.message || 'No diff available.'));
      return;
    }
    content.appendChild(renderCounts(diff.counts));
    content.appendChild(renderDiffTable(diff.servers));
  } catch (err) {
    content.appendChild(renderEmpty(`Failed to load diff: ${err?.message || err}`, true));
  }
}

function setVersion() {
  const versionEl = document.getElementById('version');
  if (versionEl) versionEl.textContent = 'v' + chrome.runtime.getManifest().version;
}

document.addEventListener('DOMContentLoaded', () => {
  setVersion();
  render();
});
