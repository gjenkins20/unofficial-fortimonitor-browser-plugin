// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-154: Deployment Snapshot & Diff tool UI (phase 1).
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

function renderPicker(prevTakenAt, currTakenAt) {
  const row = document.getElementById('picker-row');
  row.innerHTML = '';
  row.appendChild(el('div', { class: 'panel' },
    el('div', { class: 'picker' },
      el('div', { class: 'pick' },
        el('div', { class: 'label', text: 'Baseline (previous)' }),
        el('div', { class: 'val', text: formatTs(prevTakenAt) }),
      ),
      el('div', { class: 'arrow', text: '→' }),
      el('div', { class: 'pick' },
        el('div', { class: 'label', text: 'Compare to (current)' }),
        el('div', { class: 'val', text: formatTs(currTakenAt) }),
      ),
    )
  ));
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

async function render() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  try {
    const diff = await sendMessage('bpa-snapshots:diff');
    if (!diff || diff.ok === false) {
      renderPicker(null, diff?.currentTakenAt ?? null);
      content.appendChild(renderEmpty(diff?.message || 'No diff available.'));
      return;
    }
    renderPicker(diff.prevTakenAt, diff.currTakenAt);
    content.appendChild(renderCounts(diff.counts));
    content.appendChild(renderDiffTable(diff.servers));
  } catch (err) {
    renderPicker(null, null);
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
