// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
import {
  isDevModeEnabled,
  setDevModeEnabled,
  isAskClaudeEnabled,
  setAskClaudeEnabled,
  getAskClaudeToolTier,
  setAskClaudeToolTier,
  getAskClaudeProvider,
  setAskClaudeProvider,
  getAskClaudeProviderConfig,
  setAskClaudeProviderConfig,
  ASK_CLAUDE_PROVIDERS,
  DEFAULT_OLLAMA_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_LMSTUDIO_URL,
  DEFAULT_LMSTUDIO_MODEL,
  isServerSearchEnabled,
  setServerSearchEnabled,
  isBpaBetaEnabled,
  setBpaBetaEnabled,
  isSidebarLauncherEnabled,
  setSidebarLauncherEnabled,
  isShowFeatureBadgesEnabled,
  setShowFeatureBadgesEnabled
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

// FMN-120: a local-provider install (Ollama / LM Studio) is "ready" when
// the operator has saved a base URL and model. The Anthropic API key is
// not required - Ask Claude only sends to api.anthropic.com when the
// active provider is 'anthropic'.
async function askClaudeProviderReady() {
  try {
    const provider = await getAskClaudeProvider();
    if (provider === 'anthropic') return await claudeKeyConfigured();
    const cfg = await getAskClaudeProviderConfig(provider);
    return Boolean(cfg.url && cfg.model);
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

function applyToolGuards({ sessionOk, apiKeyOk, claudeKeyOk, askClaudeProvider }) {
  const localProvider = askClaudeProvider && askClaudeProvider !== 'anthropic';
  const providerLabel = askClaudeProvider === 'ollama' ? 'Ollama'
    : askClaudeProvider === 'lmstudio' ? 'LM Studio'
    : 'Anthropic';
  const claudeBlockedDesc = localProvider
    ? `Configure your ${providerLabel} URL and model in Settings (⚙) to enable.`
    : 'Set an Anthropic API key in Settings (⚙) to enable.';
  const claudeBlockedTitle = localProvider
    ? `No ${providerLabel} URL/model configured. Click ⚙ in the popup header to set a base URL and model name.`
    : 'No Anthropic API key configured. Click ⚙ in the popup header to paste your Anthropic key.';
  const claudeReadyTitle = localProvider
    ? `Requires FortiMonitor v2 API key + ${providerLabel} URL/model - manage in popup → Settings (⚙).`
    : 'Requires FortiMonitor v2 API key + Anthropic API key - manage in popup → Settings (⚙).';
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
      desc.textContent = claudeBlockedDesc;
      card.title = claudeBlockedTitle;
    } else if (needsApiKey || needsClaudeKey) {
      desc.textContent = desc.dataset.defaultDesc ?? desc.textContent;
      card.title = needsClaudeKey ? claudeReadyTitle
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

// FMN-91: sort tool cards alphabetically as a single flat list at popup
// load. Group labels were removed in the same change - tools are now one
// list, no categorization. data-group attributes on cards are kept as
// metadata only (filterTools still references them but gracefully no-ops
// since no .tool-group-label nodes remain in the DOM).
function sortToolCardsAlphabetically() {
  const list = document.getElementById('tool-list');
  if (!list) return;
  const cards = Array.from(list.querySelectorAll(':scope > .tool-card'));
  cards.sort((a, b) => toolCardSortKey(a).localeCompare(toolCardSortKey(b)));
  // appendChild on an already-attached node MOVES it to the end; appending
  // in sorted order yields the desired order without recreating nodes, so
  // existing event listeners survive.
  for (const card of cards) list.appendChild(card);
}

function toolCardSortKey(card) {
  const nameEl = card.querySelector('.tool-name');
  if (!nameEl) return '';
  // Strip .badge children so status badges don't affect alphabetical order.
  const clone = nameEl.cloneNode(true);
  clone.querySelectorAll('.badge').forEach((b) => b.remove());
  return clone.textContent.trim().toLowerCase();
}

// FMN-91: sort experimental toggles alphabetically by their visible label.
// Each toggle in the Experimental tools section is preceded by a
// <p class="settings-help"> describing it; reorder the (description, toggle)
// pair as a unit so help text follows its toggle.
function sortExperimentalTogglesAlphabetically() {
  const askToggle = document.getElementById('ask-claude-toggle');
  const section = askToggle && askToggle.closest('.settings-section');
  if (!section) return;
  const toggles = Array.from(section.querySelectorAll('.toggle-row'));
  const pairs = toggles.map((toggle) => {
    const prev = toggle.previousElementSibling;
    const desc = prev && prev.classList.contains('settings-help') ? prev : null;
    const labelText = (toggle.querySelector('span')?.textContent || '').trim().toLowerCase();
    return { toggle, desc, labelText };
  });
  pairs.sort((a, b) => a.labelText.localeCompare(b.labelText));
  for (const pair of pairs) {
    if (pair.desc) section.appendChild(pair.desc);
    section.appendChild(pair.toggle);
  }
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

async function loadAskClaudeTierIntoRadio() {
  const tier = await getAskClaudeToolTier();
  const radios = document.querySelectorAll('input[name="ask-claude-tool-tier"]');
  for (const r of radios) r.checked = (r.value === tier);
}

async function loadServerSearchIntoToggle() {
  const toggle = document.getElementById('server-search-toggle');
  toggle.checked = await isServerSearchEnabled();
}

async function loadBpaBetaIntoToggle() {
  const toggle = document.getElementById('bpa-beta-toggle');
  toggle.checked = await isBpaBetaEnabled();
}

async function loadSidebarLauncherIntoToggle() {
  const toggle = document.getElementById('sidebar-launcher-toggle');
  toggle.checked = await isSidebarLauncherEnabled();
}

async function loadShowFeatureBadgesIntoToggle() {
  const toggle = document.getElementById('feature-badges-toggle');
  toggle.checked = await isShowFeatureBadgesEnabled();
}

async function applyExperimentalVisibility() {
  const askClaudeOn = await isAskClaudeEnabled();
  for (const el of document.querySelectorAll('[data-experimental="ask-claude"]')) {
    el.hidden = !askClaudeOn;
  }
  const tierSection = document.getElementById('ask-claude-tier-section');
  if (tierSection) tierSection.hidden = !askClaudeOn;
  // FMN-120: only one provider's settings section is visible at a time
  // when ask-claude is on. The provider radio itself lives in a section
  // without a data-ask-claude-provider attribute so it always shows.
  if (askClaudeOn) {
    const provider = await getAskClaudeProvider();
    for (const el of document.querySelectorAll('[data-ask-claude-provider]')) {
      el.hidden = el.dataset.askClaudeProvider !== provider;
    }
  }
  const serverSearchOn = await isServerSearchEnabled();
  for (const el of document.querySelectorAll('[data-experimental="server-search"]')) {
    el.hidden = !serverSearchOn;
  }
  const bpaBetaOn = await isBpaBetaEnabled();
  for (const el of document.querySelectorAll('[data-experimental="bpa-beta"]')) {
    el.hidden = !bpaBetaOn;
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

// FMN-120: provider radio (Anthropic / Ollama / LM Studio) and per-
// provider URL/model/key fields. Persisted in chrome.storage.local
// via settings.js helpers; the service worker reads the active
// provider on each chat turn.
async function loadAskClaudeProviderIntoRadio() {
  const provider = await getAskClaudeProvider();
  for (const r of document.querySelectorAll('input[name="ask-claude-provider"]')) {
    r.checked = (r.value === provider);
  }
}

function setProviderStatus(provider, kind, message) {
  const el = document.getElementById(`${provider}-status`);
  if (!el) return;
  el.hidden = false;
  el.className = `settings-status ${kind}`;
  el.textContent = message;
}

function clearProviderStatus(provider) {
  const el = document.getElementById(`${provider}-status`);
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
}

async function loadProviderConfigIntoInputs(provider) {
  const cfg = await getAskClaudeProviderConfig(provider);
  const urlInput = document.getElementById(`${provider}-url-input`);
  const modelInput = document.getElementById(`${provider}-model-input`);
  const keyInput = document.getElementById(`${provider}-key-input`);
  if (urlInput) urlInput.value = cfg.url || '';
  if (modelInput) modelInput.value = cfg.model || '';
  if (keyInput) {
    keyInput.value = '';
    if (cfg.apiKey) {
      keyInput.placeholder = `••••••••${cfg.apiKey.slice(-4)} (saved - paste a new key to replace)`;
    } else {
      keyInput.placeholder = '(usually blank for ' + (provider === 'ollama' ? 'Ollama' : 'LM Studio') + ')';
    }
  }
}

async function saveProviderConfig(provider) {
  const url = (document.getElementById(`${provider}-url-input`)?.value ?? '').trim();
  const model = (document.getElementById(`${provider}-model-input`)?.value ?? '').trim();
  const keyInput = document.getElementById(`${provider}-key-input`);
  const newKey = (keyInput?.value ?? '').trim();
  if (!url) {
    setProviderStatus(provider, 'warn', 'Base URL is required.');
    return;
  }
  if (!model) {
    setProviderStatus(provider, 'warn', 'Model is required.');
    return;
  }
  // Request permission FIRST, before any awaits, so Chrome's user-
  // gesture token is still valid. (chrome.permissions.request silently
  // rejects after the gesture context is gone.)
  const perm = await maybeRequestHostPermission(url);
  // Only overwrite the API key when the operator typed something - empty
  // input means "leave the saved key alone".
  const update = { url, model };
  if (newKey) update.apiKey = newKey;
  await setAskClaudeProviderConfig(provider, update);
  await loadProviderConfigIntoInputs(provider);
  if (!perm.granted) {
    const detail = perm.error ?? 'permission denied';
    setProviderStatus(provider, 'warn',
      `Saved. Note: access to ${perm.origin ?? 'that origin'} is not granted yet (${detail}). Click Test connection to re-prompt.`);
    return;
  }
  setProviderStatus(provider, 'ok', 'Saved.');
}

/**
 * Request host permission for the URL's origin if not already granted.
 * Returns the granted state. Must be called from a user-gesture context
 * (popup click handler) - chrome.permissions.request silently rejects
 * if the user-gesture token has expired (e.g. after multiple awaits).
 *
 * @param {string} url
 * @returns {Promise<{ granted: boolean, origin: string|null, error: string|null }>}
 */
async function maybeRequestHostPermission(url) {
  let origin = null;
  try {
    const u = new URL(url);
    origin = `${u.protocol}//${u.host}/*`;
  } catch (err) {
    return { granted: false, origin: null, error: `Invalid URL: ${err?.message ?? err}` };
  }
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return { granted: true, origin, error: null };
    const granted = await chrome.permissions.request({ origins: [origin] });
    return { granted: Boolean(granted), origin, error: granted ? null : 'User declined or browser dismissed the permission prompt.' };
  } catch (err) {
    return { granted: false, origin, error: err?.message ?? String(err) };
  }
}

async function testProviderConnection(provider) {
  // FMN-120 follow-up: Test = (request host permission) then Save then
  // Test. The permission request must be the FIRST async call after
  // the click handler so Chrome's user-gesture token is still valid -
  // chrome.permissions.request silently rejects if too many awaits run
  // first. Surfaces "permission not granted" explicitly so the operator
  // sees why the test couldn't run.
  try {
    const url = (document.getElementById(`${provider}-url-input`)?.value ?? '').trim();
    const model = (document.getElementById(`${provider}-model-input`)?.value ?? '').trim();
    const newKey = (document.getElementById(`${provider}-key-input`)?.value ?? '').trim();
    if (!url) {
      setProviderStatus(provider, 'warn', 'Base URL is required to test.');
      return;
    }
    if (!model) {
      setProviderStatus(provider, 'warn', 'Model is required to test.');
      return;
    }
    // 1. Request permission FIRST while we're still in the click's
    //    user-gesture context.
    setProviderStatus(provider, 'ok', 'Requesting permission…');
    const perm = await maybeRequestHostPermission(url);
    if (!perm.granted) {
      const detail = perm.error ?? 'permission denied';
      setProviderStatus(provider, 'error',
        `Cannot reach ${url} until you grant access to ${perm.origin ?? 'that origin'}. ${detail}. Click Test connection again to re-prompt.`);
      return;
    }
    // 2. Persist form values now that we know we can reach the URL.
    setProviderStatus(provider, 'ok', 'Saving + testing…');
    const update = { url, model };
    if (newKey) update.apiKey = newKey;
    await setAskClaudeProviderConfig(provider, update);
    await loadProviderConfigIntoInputs(provider);
    // 3. Probe.
    const cfg = await getAskClaudeProviderConfig(provider);
    const result = await chrome.runtime.sendMessage({
      type: 'chat:test-openai-compat',
      payload: { provider, url: cfg.url, model: cfg.model, apiKey: cfg.apiKey || '' }
    });
    if (!result) {
      setProviderStatus(provider, 'error', 'No response from service worker.');
      return;
    }
    if (!result.ok) {
      setProviderStatus(provider, 'error', `Failed: ${result.error || 'unknown error'}`);
      return;
    }
    const r = result.result;
    if (r.soft) {
      setProviderStatus(provider, 'ok', `Saved. Reachable, but server doesn't expose /models so model "${cfg.model}" wasn't verified.`);
      return;
    }
    if (r.modelFound === false) {
      const sample = (r.models ?? []).slice(0, 5).join(', ');
      setProviderStatus(provider, 'warn',
        `Saved. Reachable, but model "${cfg.model}" was not in /models. Available: ${sample || '(empty)'}`);
      return;
    }
    setProviderStatus(provider, 'ok', `Saved. Connection OK; model "${cfg.model}" found.`);
  } catch (err) {
    setProviderStatus(provider, 'error', `Failed: ${err?.message ?? err}`);
  }
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
  const [sessionOk, apiKeyOk, claudeKeyOk, askClaudeProvider] = await Promise.all([
    sessionActive(),
    apiKeyConfigured(),
    askClaudeProviderReady(),
    getAskClaudeProvider()
  ]);
  setSessionState(sessionOk);
  applyToolGuards({ sessionOk, apiKeyOk, claudeKeyOk, askClaudeProvider });
}

function init() {
  // FMN-91: sort first, before any visibility / guard logic operates on the
  // tool list. Experimental toggles section is also sorted at popup load,
  // independent of whether the operator opens Settings this session.
  sortToolCardsAlphabetically();
  sortExperimentalTogglesAlphabetically();

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
    clearProviderStatus('ollama');
    clearProviderStatus('lmstudio');
    await loadApiKeyIntoInput();
    await loadClaudeKeyIntoInput();
    await loadDevModeIntoToggle();
    await loadAskClaudeIntoToggle();
    await loadAskClaudeTierIntoRadio();
    await loadAskClaudeProviderIntoRadio();
    await loadProviderConfigIntoInputs('ollama');
    await loadProviderConfigIntoInputs('lmstudio');
    await loadServerSearchIntoToggle();
    await loadBpaBetaIntoToggle();
    await loadSidebarLauncherIntoToggle();
    await loadShowFeatureBadgesIntoToggle();
    await loadWebguiColumnsIntoSettings();
    await applyExperimentalVisibility();
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

  document.getElementById('sidebar-launcher-toggle').addEventListener('change', async (e) => {
    await setSidebarLauncherEnabled(e.target.checked);
  });

  document.getElementById('feature-badges-toggle').addEventListener('change', async (e) => {
    await setShowFeatureBadgesEnabled(e.target.checked);
  });

  document.getElementById('ask-claude-toggle').addEventListener('change', async (e) => {
    await setAskClaudeEnabled(e.target.checked);
    await applyExperimentalVisibility();
    await refreshGuards();
  });

  for (const radio of document.querySelectorAll('input[name="ask-claude-tool-tier"]')) {
    radio.addEventListener('change', async (e) => {
      if (e.target.checked) await setAskClaudeToolTier(e.target.value);
    });
  }

  // FMN-120: provider radio + provider-config save/test buttons.
  for (const radio of document.querySelectorAll('input[name="ask-claude-provider"]')) {
    radio.addEventListener('change', async (e) => {
      if (!e.target.checked) return;
      const provider = e.target.value;
      if (!ASK_CLAUDE_PROVIDERS.includes(provider)) return;
      await setAskClaudeProvider(provider);
      await applyExperimentalVisibility();
      await refreshGuards();
    });
  }
  document.getElementById('ollama-save').addEventListener('click', () => saveProviderConfig('ollama'));
  document.getElementById('ollama-test').addEventListener('click', () => testProviderConnection('ollama'));
  document.getElementById('lmstudio-save').addEventListener('click', () => saveProviderConfig('lmstudio'));
  document.getElementById('lmstudio-test').addEventListener('click', () => testProviderConnection('lmstudio'));

  document.getElementById('server-search-toggle').addEventListener('change', async (e) => {
    await setServerSearchEnabled(e.target.checked);
    await applyExperimentalVisibility();
    await refreshGuards();
  });

  document.getElementById('bpa-beta-toggle').addEventListener('change', async (e) => {
    await setBpaBetaEnabled(e.target.checked);
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
