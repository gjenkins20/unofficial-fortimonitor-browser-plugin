// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
import {
  isDevModeEnabled,
  setDevModeEnabled,
  isAskClaudeEnabled,
  setAskClaudeEnabled,
  isServerSearchEnabled,
  setServerSearchEnabled
} from '../lib/settings.js';
import {
  listAugmentations,
  getRegistry,
  getAllColumnOrders,
  setColumnOrder,
  resetColumnOrder
} from '../lib/column-order.js';
import { resolveFortimonitorOrigin, FEDERATION_ORIGIN } from '../lib/origin-resolver.js';

const FORTIMONITOR_URL = `${FEDERATION_ORIGIN}/`;
const XSRF_COOKIE = 'XSRF-TOKEN';
const API_KEY_STORAGE_KEY = 'panopta.apiKey';
const CLAUDE_KEY_STORAGE_KEY = 'claude.apiKey';

async function sessionActive() {
  try {
    const origin = await resolveFortimonitorOrigin({
      queryTabs: (q) => chrome.tabs.query(q),
      storage: chrome.storage.local
    });
    const cookie = await chrome.cookies.get({ url: `${origin}/`, name: XSRF_COOKIE });
    return Boolean(cookie && cookie.value);
  } catch {
    return false;
  }
}

async function apiKeyConfigured() {
  try {
    const data = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
    return Boolean(data?.[API_KEY_STORAGE_KEY]);
  } catch {
    return false;
  }
}

async function claudeKeyConfigured() {
  try {
    const data = await chrome.storage.local.get(CLAUDE_KEY_STORAGE_KEY);
    return Boolean(data?.[CLAUDE_KEY_STORAGE_KEY]);
  } catch {
    return false;
  }
}

function setSessionState(ok) {
  const strip = document.getElementById('session-strip');
  const text = document.getElementById('session-text');
  const link = document.getElementById('session-link');

  strip.hidden = false;
  strip.classList.toggle('ok', ok);
  strip.classList.toggle('warn', !ok);
  text.textContent = ok
    ? 'Signed in to FortiMonitor'
    : 'Not signed in - log in to FortiMonitor first';
  link.textContent = ok ? 'Open console ↗' : 'Open login ↗';
}

function applyToolGuards({ sessionOk, apiKeyOk, claudeKeyOk }) {
  for (const card of document.querySelectorAll('.tool-card')) {
    const needsSession = card.dataset.sessionRequired === 'true';
    const needsApiKey = card.dataset.apiKeyRequired === 'true';
    const needsClaudeKey = card.dataset.claudeKeyRequired === 'true';
    const blocked =
      (needsSession && !sessionOk) ||
      (needsApiKey && !apiKeyOk) ||
      (needsClaudeKey && !claudeKeyOk);
    card.classList.toggle('disabled', blocked);
    const desc = card.querySelector('.tool-desc');
    if (needsSession && !sessionOk) {
      desc.textContent = 'Sign in to FortiMonitor to enable.';
      card.title = 'Sign in to FortiMonitor (https://fortimonitor.forticloud.com/) to enable this tool.';
    } else if (needsApiKey && !apiKeyOk) {
      desc.textContent = 'Set a FortiMonitor v2 API key in Settings (⚙) to enable.';
      card.title = 'No API key configured. Click ⚙ in the popup header to paste your FortiMonitor v2 RW API key.';
    } else if (needsClaudeKey && !claudeKeyOk) {
      desc.textContent = 'Set an Anthropic (Claude) API key in Settings (⚙) to enable.';
      card.title = 'No Claude API key configured. Click ⚙ in the popup header to paste your Anthropic key.';
    } else if (needsApiKey || needsClaudeKey) {
      // Enabled but still benefits from a reminder of what auth surface it uses.
      desc.textContent = desc.dataset.defaultDesc ?? desc.textContent;
      card.title = needsClaudeKey
        ? 'Requires FortiMonitor v2 API key + Anthropic API key - manage in popup → Settings (⚙).'
        : 'Requires a FortiMonitor v2 API key - manage in popup → Settings (⚙).';
    } else {
      desc.textContent = desc.dataset.defaultDesc ?? desc.textContent;
      card.title = '';
    }
  }
}

function openExtensionPage(path) {
  chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
}

function openExternal(url) {
  chrome.tabs.create({ url });
  window.close();
}

function filterTools(query) {
  const q = query.trim().toLowerCase();
  const cards = document.querySelectorAll('.tool-card');
  const groupLabels = document.querySelectorAll('.tool-group-label');
  const empty = document.getElementById('no-matches');

  if (q === '') {
    cards.forEach((c) => (c.hidden = false));
    groupLabels.forEach((l) => (l.hidden = false));
    empty.hidden = true;
    return;
  }

  let anyVisible = false;
  const visibleGroups = new Set();
  for (const card of cards) {
    const text = card.textContent.toLowerCase();
    const match = text.includes(q);
    card.hidden = !match;
    if (match) {
      anyVisible = true;
      visibleGroups.add(card.dataset.group);
    }
  }
  for (const label of groupLabels) {
    label.hidden = !visibleGroups.has(label.dataset.group);
  }
  empty.hidden = anyVisible;
}

// -------- Settings panel --------

function showSettings() {
  document.getElementById('main-view').hidden = true;
  document.getElementById('settings-view').hidden = false;
  document.getElementById('api-key-input').focus();
}

function hideSettings() {
  document.getElementById('settings-view').hidden = true;
  document.getElementById('main-view').hidden = false;
  // Re-apply tool guards in case the API key state changed.
  refreshGuards();
}

function setStatus(kind, message) {
  const el = document.getElementById('api-key-status');
  el.hidden = false;
  el.className = `settings-status ${kind}`;
  el.textContent = message;
}

function clearStatus() {
  const el = document.getElementById('api-key-status');
  el.hidden = true;
  el.textContent = '';
}

async function loadDevModeIntoToggle() {
  const toggle = document.getElementById('dev-mode-toggle');
  toggle.checked = await isDevModeEnabled();
}

async function loadAskClaudeIntoToggle() {
  const toggle = document.getElementById('ask-claude-toggle');
  toggle.checked = await isAskClaudeEnabled();
}

async function loadServerSearchIntoToggle() {
  const toggle = document.getElementById('server-search-toggle');
  toggle.checked = await isServerSearchEnabled();
}

async function applyExperimentalVisibility() {
  const askClaudeOn = await isAskClaudeEnabled();
  for (const el of document.querySelectorAll('[data-experimental="ask-claude"]')) {
    el.hidden = !askClaudeOn;
  }
  const serverSearchOn = await isServerSearchEnabled();
  for (const el of document.querySelectorAll('[data-experimental="server-search"]')) {
    el.hidden = !serverSearchOn;
  }
}

async function loadApiKeyIntoInput() {
  const data = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  const key = data?.[API_KEY_STORAGE_KEY];
  const input = document.getElementById('api-key-input');
  if (key) {
    // Show a masked placeholder; never re-display the real key.
    input.value = '';
    input.placeholder = `••••••••${key.slice(-4)} (saved - paste a new key to replace)`;
  } else {
    input.value = '';
    input.placeholder = 'Paste API key';
  }
}

async function saveApiKey() {
  const input = document.getElementById('api-key-input');
  const key = input.value.trim();
  if (!key) {
    setStatus('warn', 'Paste a key before saving.');
    return;
  }
  await chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: key });
  setStatus('ok', 'API key saved.');
  await loadApiKeyIntoInput();
}

async function clearApiKey() {
  await chrome.storage.local.remove(API_KEY_STORAGE_KEY);
  setStatus('ok', 'API key cleared.');
  await loadApiKeyIntoInput();
}

function setClaudeStatus(kind, message) {
  const el = document.getElementById('claude-key-status');
  el.hidden = false;
  el.className = `settings-status ${kind}`;
  el.textContent = message;
}

function clearClaudeStatus() {
  const el = document.getElementById('claude-key-status');
  el.hidden = true;
  el.textContent = '';
}

async function loadClaudeKeyIntoInput() {
  const data = await chrome.storage.local.get(CLAUDE_KEY_STORAGE_KEY);
  const key = data?.[CLAUDE_KEY_STORAGE_KEY];
  const input = document.getElementById('claude-key-input');
  if (key) {
    input.value = '';
    input.placeholder = `••••••••${key.slice(-4)} (saved - paste a new key to replace)`;
  } else {
    input.value = '';
    input.placeholder = 'Paste Claude API key';
  }
}

async function saveClaudeKey() {
  const input = document.getElementById('claude-key-input');
  const key = input.value.trim();
  if (!key) {
    setClaudeStatus('warn', 'Paste a key before saving.');
    return;
  }
  await chrome.storage.local.set({ [CLAUDE_KEY_STORAGE_KEY]: key });
  setClaudeStatus('ok', 'Claude API key saved.');
  await loadClaudeKeyIntoInput();
}

async function clearClaudeKey() {
  await chrome.storage.local.remove(CLAUDE_KEY_STORAGE_KEY);
  setClaudeStatus('ok', 'Claude API key cleared.');
  await loadClaudeKeyIntoInput();
}

async function testClaudeKey() {
  setClaudeStatus('ok', 'Testing…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'chat:test-claude-key', payload: {} });
    if (!result) {
      setClaudeStatus('error', 'No response from service worker.');
      return;
    }
    if (!result.ok) {
      setClaudeStatus('error', `Failed: ${result.error || 'unknown error'}`);
      return;
    }
    setClaudeStatus('ok', `Key works (HTTP ${result.result?.status ?? 200}).`);
  } catch (err) {
    setClaudeStatus('error', `Failed: ${err?.message ?? err}`);
  }
}

async function testConnection() {
  setStatus('ok', 'Testing…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'panopta:test-connection', payload: {} });
    if (!result) {
      setStatus('error', 'No response from service worker.');
      return;
    }
    if (!result.ok) {
      setStatus('error', `Failed: ${result.error || 'unknown error'}`);
      return;
    }
    setStatus('ok', `Connection OK (HTTP ${result.result?.status ?? 200}).`);
  } catch (err) {
    setStatus('error', `Failed: ${err?.message ?? err}`);
  }
}

// -------- WebGUI columns (FMN-72 / FMN-73) --------

async function loadWebguiColumnsIntoSettings() {
  const container = document.getElementById('webgui-columns-list');
  if (!container) return;
  container.innerHTML = '';
  const all = await getAllColumnOrders();
  for (const aug of listAugmentations()) {
    const card = buildAugCard(aug, all[aug.id] || []);
    container.appendChild(card);
  }
}

function buildAugCard(aug, columns) {
  const card = document.createElement('div');
  card.className = 'aug-card';

  const header = document.createElement('div');
  header.className = 'aug-card-header';
  const label = document.createElement('span');
  label.textContent = aug.label;
  const ctx = document.createElement('span');
  ctx.className = 'ctx';
  ctx.textContent = aug.context;
  header.appendChild(label);
  header.appendChild(ctx);
  card.appendChild(header);

  const list = document.createElement('div');
  list.dataset.augId = aug.id;
  card.appendChild(list);

  const reset = document.createElement('div');
  reset.className = 'reset-row';
  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn';
  resetBtn.type = 'button';
  resetBtn.textContent = 'Reset to default';
  resetBtn.addEventListener('click', async () => {
    await resetColumnOrder(aug.id);
    await loadWebguiColumnsIntoSettings();
  });
  reset.appendChild(resetBtn);
  card.appendChild(reset);

  renderColumnRows(list, aug.id, columns);
  return card;
}

function renderColumnRows(listEl, augId, columns) {
  listEl.innerHTML = '';
  const reg = getRegistry(augId);
  if (!reg) return;
  const metaById = new Map(reg.columns.map((c) => [c.id, c]));

  columns.forEach((col, idx) => {
    const meta = metaById.get(col.id);
    if (!meta) return;
    const row = document.createElement('div');
    row.className = 'col-row';
    row.setAttribute('draggable', 'true');
    row.dataset.idx = String(idx);
    if (col.hidden) row.classList.add('is-hidden');
    if (meta.lockedVisible) row.classList.add('is-locked');

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '⋮⋮';
    handle.title = 'Drag to reorder';

    const upBtn = document.createElement('button');
    upBtn.className = 'icon-btn';
    upBtn.type = 'button';
    upBtn.textContent = '↑';
    upBtn.title = 'Move up';
    upBtn.disabled = idx === 0;
    upBtn.addEventListener('click', () => moveColumn(augId, idx, idx - 1));

    const downBtn = document.createElement('button');
    downBtn.className = 'icon-btn';
    downBtn.type = 'button';
    downBtn.textContent = '↓';
    downBtn.title = 'Move down';
    downBtn.disabled = idx === columns.length - 1;
    downBtn.addEventListener('click', () => moveColumn(augId, idx, idx + 1));

    const name = document.createElement('div');
    name.className = 'col-name';
    name.textContent = meta.label;

    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'icon-btn eye' + (col.hidden ? '' : ' is-on');
    eyeBtn.type = 'button';
    eyeBtn.textContent = col.hidden ? '⌀' : '◉';
    eyeBtn.title = meta.lockedVisible
      ? 'Always visible'
      : (col.hidden ? 'Show column' : 'Hide column');
    eyeBtn.disabled = !!meta.lockedVisible;
    eyeBtn.addEventListener('click', () => toggleColumnVisibility(augId, idx));

    row.appendChild(handle);
    row.appendChild(upBtn);
    row.appendChild(downBtn);
    row.appendChild(name);
    row.appendChild(eyeBtn);

    attachRowDrag(row, augId);
    listEl.appendChild(row);
  });
}

async function readCurrentColumns(augId) {
  const all = await getAllColumnOrders();
  return all[augId] || [];
}

async function moveColumn(augId, fromIdx, toIdx) {
  const cols = await readCurrentColumns(augId);
  if (toIdx < 0 || toIdx >= cols.length) return;
  const next = cols.slice();
  const [item] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, item);
  await setColumnOrder(augId, next);
  await loadWebguiColumnsIntoSettings();
}

async function toggleColumnVisibility(augId, idx) {
  const cols = await readCurrentColumns(augId);
  const reg = getRegistry(augId);
  if (!reg) return;
  const meta = reg.columns.find((c) => c.id === cols[idx].id);
  if (!meta || meta.lockedVisible) return;
  const next = cols.slice();
  next[idx] = { id: cols[idx].id, hidden: !cols[idx].hidden };
  await setColumnOrder(augId, next);
  await loadWebguiColumnsIntoSettings();
}

function attachRowDrag(row, augId) {
  row.addEventListener('dragstart', (e) => {
    row.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.idx);
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('is-dragging');
    document.querySelectorAll('.col-row.drop-above, .col-row.drop-below')
      .forEach((r) => r.classList.remove('drop-above', 'drop-below'));
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    row.classList.toggle('drop-above', above);
    row.classList.toggle('drop-below', !above);
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-above', 'drop-below');
  });
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    const fromIdx = Number(e.dataTransfer.getData('text/plain'));
    const rect = row.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    let toIdx = Number(row.dataset.idx);
    if (!above) toIdx += 1;
    if (fromIdx < toIdx) toIdx -= 1;
    row.classList.remove('drop-above', 'drop-below');
    if (Number.isNaN(fromIdx) || fromIdx === toIdx) return;
    const cols = await readCurrentColumns(augId);
    const next = cols.slice();
    const [item] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, item);
    await setColumnOrder(augId, next);
    await loadWebguiColumnsIntoSettings();
  });
}

// -------- Init --------

async function refreshGuards() {
  const [sessionOk, apiKeyOk, claudeKeyOk] = await Promise.all([
    sessionActive(),
    apiKeyConfigured(),
    claudeKeyConfigured()
  ]);
  setSessionState(sessionOk);
  applyToolGuards({ sessionOk, apiKeyOk, claudeKeyOk });
}

function init() {
  applyExperimentalVisibility();
  refreshGuards();

  document.getElementById('session-link').addEventListener('click', (e) => {
    e.preventDefault();
    openExternal(FORTIMONITOR_URL);
  });

  for (const card of document.querySelectorAll('.tool-card')) {
    card.addEventListener('click', () => {
      if (card.classList.contains('disabled')) return;
      const path = card.dataset.url;
      if (path) openExtensionPage(path);
    });
  }

  const searchInput = document.getElementById('search');
  searchInput.addEventListener('input', (e) => {
    filterTools(e.target.value);
  });
  // Autofocus only when the popup is the top-level document (toolbar popup).
  // In a cross-origin iframe (FMN-69 sidebar overlay), Chrome blocks autofocus
  // on cross-origin subframes and logs a warning, so skip it there.
  if (window.top === window) {
    searchInput.focus();
  }

  document.getElementById('settings-toggle').addEventListener('click', async () => {
    clearStatus();
    clearClaudeStatus();
    await loadApiKeyIntoInput();
    await loadClaudeKeyIntoInput();
    await loadDevModeIntoToggle();
    await loadAskClaudeIntoToggle();
    await loadServerSearchIntoToggle();
    await loadWebguiColumnsIntoSettings();
    showSettings();
  });
  document.getElementById('settings-back').addEventListener('click', hideSettings);
  document.getElementById('api-key-save').addEventListener('click', saveApiKey);
  document.getElementById('api-key-clear').addEventListener('click', clearApiKey);
  document.getElementById('api-key-test').addEventListener('click', testConnection);
  document.getElementById('claude-key-save').addEventListener('click', saveClaudeKey);
  document.getElementById('claude-key-clear').addEventListener('click', clearClaudeKey);
  document.getElementById('claude-key-test').addEventListener('click', testClaudeKey);

  document.getElementById('dev-mode-toggle').addEventListener('change', async (e) => {
    await setDevModeEnabled(e.target.checked);
  });

  document.getElementById('ask-claude-toggle').addEventListener('change', async (e) => {
    await setAskClaudeEnabled(e.target.checked);
    await applyExperimentalVisibility();
    await refreshGuards();
  });

  document.getElementById('server-search-toggle').addEventListener('change', async (e) => {
    await setServerSearchEnabled(e.target.checked);
    await applyExperimentalVisibility();
    await refreshGuards();
  });

  const authorLink = document.getElementById('author-link');
  if (authorLink) {
    authorLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: authorLink.href });
      window.close();
    });
  }
}

init();
