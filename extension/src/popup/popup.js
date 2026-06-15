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
  isSdwanReportEnabled,
  setSdwanReportEnabled,
  isFindDeleteDuplicatesEnabled,
  setFindDeleteDuplicatesEnabled,
  isTenantObservationsEnabled,
  setTenantObservationsEnabled,
  isSsoConfigEnabled,
  setSsoConfigEnabled,
  isSidebarLauncherEnabled,
  setSidebarLauncherEnabled,
  isShowFeatureBadgesEnabled,
  setShowFeatureBadgesEnabled,
  isOmniSearchEnabled,
  setOmniSearchEnabled,
  isSnapshotDiffEnabled,
  setSnapshotDiffEnabled,
  isReportNotificationsEnabled,
  setReportNotificationsEnabled,
  isUpdateCheckEnabled,
  setUpdateCheckEnabled,
  isNoiseAnalyzerEnabled,
  setNoiseAnalyzerEnabled,
  isShowInfoBubblesEnabled,
  setShowInfoBubblesEnabled,
  isCustomMetricsTourEnabled,
  setCustomMetricsTourEnabled
} from '../lib/settings.js';
import { mountInfoBubbles } from '../lib/info-bubble.js';
import {
  UPDATE_CHECK_RESULT_KEY,
  UPDATE_CHECK_SNOOZE_KEY
} from '../background/update-check.js';
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
  // FMN-246: scope the filter to the main-view tile area. The training
  // drill-in's tiles are managed independently by loadIntroTourState() /
  // loadCustomMetricsTourState() against their per-tile flags; including
  // them here would let a search query override the flag-disabled hidden
  // state and leak the tile on Back-to-main.
  const cards = document.querySelectorAll('#main-view .tool-card');
  const groupLabels = document.querySelectorAll('#main-view .tool-group-label');
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

// -------- Training drill-in (FMN-246) --------

// Mirror of showSettings/hideSettings. The main view stays in the DOM so
// the search input value and scroll position are preserved verbatim
// across drill-in/back navigation.
function showTraining() {
  document.getElementById('main-view').hidden = true;
  document.getElementById('training-view').hidden = false;
}

function hideTraining() {
  document.getElementById('training-view').hidden = true;
  document.getElementById('main-view').hidden = false;
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

async function loadSdwanReportIntoToggle() {
  const toggle = document.getElementById('sdwan-report-toggle');
  toggle.checked = await isSdwanReportEnabled();
}

async function loadFindDeleteDuplicatesIntoToggle() {
  const toggle = document.getElementById('find-delete-duplicates-toggle');
  toggle.checked = await isFindDeleteDuplicatesEnabled();
}

async function loadTenantObservationsIntoToggle() {
  const toggle = document.getElementById('tenant-observations-toggle');
  toggle.checked = await isTenantObservationsEnabled();
}

async function loadSsoConfigIntoToggle() {
  const toggle = document.getElementById('sso-config-toggle');
  toggle.checked = await isSsoConfigEnabled();
}

async function loadSidebarLauncherIntoToggle() {
  const toggle = document.getElementById('sidebar-launcher-toggle');
  toggle.checked = await isSidebarLauncherEnabled();
}

async function loadShowFeatureBadgesIntoToggle() {
  const toggle = document.getElementById('feature-badges-toggle');
  toggle.checked = await isShowFeatureBadgesEnabled();
}

async function loadShowInfoBubblesIntoToggle() {
  const toggle = document.getElementById('info-bubbles-toggle');
  if (!toggle) return;
  toggle.checked = await isShowInfoBubblesEnabled();
}

// FMN-244: Custom Metrics training tile state. Independent (Beta) flag.
// FMN-250 retired the Intro-tour toggle, so the launcher tile is always
// visible (Intro is always inside the drill-in); only the Custom Metrics
// tile inside the drill-in is conditionally hidden.
async function loadCustomMetricsTourState() {
  const enabled = await isCustomMetricsTourEnabled();
  const settingsToggle = document.getElementById('custom-metrics-tour-toggle');
  if (settingsToggle) settingsToggle.checked = enabled;
  const tile = document.getElementById('training-custom-metrics-tile');
  if (tile) tile.hidden = !enabled;
}

async function loadOmniSearchIntoToggle() {
  const toggle = document.getElementById('omni-search-toggle');
  if (!toggle) return;
  toggle.checked = await isOmniSearchEnabled();
}

async function loadSnapshotDiffIntoToggle() {
  const toggle = document.getElementById('snapshot-diff-toggle');
  if (!toggle) return;
  toggle.checked = await isSnapshotDiffEnabled();
}

async function loadReportNotificationsIntoToggle() {
  const toggle = document.getElementById('report-notifications-toggle');
  if (!toggle) return;
  toggle.checked = await isReportNotificationsEnabled();
}

async function applyReportNotificationsControlsVisibility() {
  const on = await isReportNotificationsEnabled();
  for (const el of document.querySelectorAll('[data-report-notifications-controls]')) {
    el.hidden = !on;
  }
}

function formatReportTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return `${h}:${m}`;
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mo}/${dd} ${h}:${m}`;
  } catch { return ''; }
}

async function renderReportNotificationsCard() {
  const card = document.getElementById('report-notifications-card');
  if (!card) return;
  const enabled = await isReportNotificationsEnabled();
  if (!enabled) { card.hidden = true; return; }
  let items = [];
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'report-notifications:history',
      payload: {},
    });
    if (response?.ok && response.result?.ok) items = response.result.items || [];
  } catch { /* SW unreachable; render empty */ }
  if (items.length === 0) { card.hidden = true; return; }
  const list = document.getElementById('report-notifications-history-list');
  if (!list) { card.hidden = true; return; }
  list.innerHTML = '';
  const HISTORY_URL = 'https://fortimonitor.forticloud.com/report/ListReports#report-history';
  for (const item of items) {
    const li = document.createElement('li');
    const left = document.createElement('button');
    left.type = 'button';
    left.className = 'row-action';
    left.textContent = item.reportName || item.reportTypeName ||
      (item.delta === 1 ? '1 report finished' : `${item.delta || '?'} reports finished`);
    left.addEventListener('click', async () => {
      try {
        const tabs = await chrome.tabs.query({ url: 'https://fortimonitor.forticloud.com/*' });
        if (tabs.length > 0) {
          await chrome.tabs.update(tabs[0].id, { active: true, url: HISTORY_URL });
          if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true });
        } else {
          await chrome.tabs.create({ url: HISTORY_URL });
        }
        window.close();
      } catch { /* silent */ }
    });
    const right = document.createElement('span');
    right.className = 'row-time';
    right.textContent = formatReportTime(item.takenAt);
    li.appendChild(left);
    li.appendChild(right);
    // Inline download link when the entry carries one (parsed from the
    // FortiMonitor history endpoint by the SW pollOnce path).
    if (item.downloadLink) {
      const dl = document.createElement('a');
      dl.className = 'row-download';
      dl.href = item.downloadLink.startsWith('http')
        ? item.downloadLink
        : 'https://fortimonitor.forticloud.com' + item.downloadLink;
      dl.target = '_blank';
      dl.rel = 'noopener';
      dl.title = 'Download report';
      dl.textContent = 'Download';
      li.appendChild(dl);
    }
    list.appendChild(li);
  }
  card.hidden = false;
}

async function clearReportNotificationsBadgeOnOpen() {
  try {
    await chrome.runtime.sendMessage({ type: 'report-notifications:clear-badge', payload: {} });
  } catch { /* silent */ }
}

function setSnapshotInlineStatus(elId, text, kind = '') {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text;
  el.className = 'settings-inline-status' + (kind ? ' ' + kind : '');
}

async function applySnapshotDiffControlsVisibility() {
  const on = await isSnapshotDiffEnabled();
  for (const el of document.querySelectorAll('[data-snapshot-diff-controls]')) {
    el.hidden = !on;
  }
}

// Phase 2.5: pull the current rotation cap from the SW into the input.
// Silently no-ops if the SW is unreachable (e.g., service worker idled),
// since the input is hidden when the feature is off anyway.
async function loadSnapshotRotationIntoInput() {
  const input = document.getElementById('snapshot-rotation-input');
  if (!input) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'observations-snapshots:get-config',
      payload: {},
    });
    if (response?.ok && response.result?.ok && Number.isFinite(response.result.maxSnapshots)) {
      input.value = String(response.result.maxSnapshots);
    }
  } catch { /* feature toggle is off or SW unavailable */ }
}

async function loadNoiseAnalyzerIntoToggle() {
  const toggle = document.getElementById('noise-analyzer-toggle');
  if (!toggle) return;
  toggle.checked = await isNoiseAnalyzerEnabled();
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
  const sdwanReportOn = await isSdwanReportEnabled();
  for (const el of document.querySelectorAll('[data-experimental="sdwan-report"]')) {
    el.hidden = !sdwanReportOn;
  }
  const findDeleteDuplicatesOn = await isFindDeleteDuplicatesEnabled();
  for (const el of document.querySelectorAll('[data-experimental="find-delete-duplicates"]')) {
    el.hidden = !findDeleteDuplicatesOn;
  }
  const tenantObservationsOn = await isTenantObservationsEnabled();
  for (const el of document.querySelectorAll('[data-experimental="tenant-observations"]')) {
    el.hidden = !tenantObservationsOn;
  }
  const ssoConfigOn = await isSsoConfigEnabled();
  for (const el of document.querySelectorAll('[data-experimental="sso-config"]')) {
    el.hidden = !ssoConfigOn;
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

  renderColumnRows(list, aug.id, columns, aug.reorderable !== false);
  return card;
}

function renderColumnRows(listEl, augId, columns, reorderable) {
  listEl.innerHTML = '';
  const reg = getRegistry(augId);
  if (!reg) return;
  const metaById = new Map(reg.columns.map((c) => [c.id, c]));

  columns.forEach((col, idx) => {
    const meta = metaById.get(col.id);
    if (!meta) return;
    const row = document.createElement('div');
    row.className = 'col-row';
    if (reorderable) row.setAttribute('draggable', 'true');
    row.dataset.idx = String(idx);
    if (col.hidden) row.classList.add('is-hidden');
    if (meta.lockedVisible) row.classList.add('is-locked');
    if (!reorderable) row.classList.add('is-fixed-order');

    if (reorderable) {
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

      row.appendChild(handle);
      row.appendChild(upBtn);
      row.appendChild(downBtn);
    }

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

    row.appendChild(name);
    row.appendChild(eyeBtn);

    if (reorderable) attachRowDrag(row, augId);
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

// -------- FMN-157: update-available banner --------

const SNOOZE_7_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SNOOZE_24_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Render the update-available banner if:
 *   1. The update-check flag is on.
 *   2. The stored fm:updateCheck result has isNewer === true.
 *   3. fm:updateSnoozeUntil is absent or in the past.
 *
 * Failing any of those leaves the banner hidden. All errors are
 * swallowed; the banner is best-effort.
 */
async function renderUpdateBanner() {
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  try {
    const enabled = await isUpdateCheckEnabled();
    if (!enabled) {
      banner.hidden = true;
      return;
    }
    const data = await chrome.storage.local.get([UPDATE_CHECK_RESULT_KEY, UPDATE_CHECK_SNOOZE_KEY]);
    const result = data?.[UPDATE_CHECK_RESULT_KEY];
    const snoozeUntil = Number(data?.[UPDATE_CHECK_SNOOZE_KEY] || 0);
    if (!result || result.isNewer !== true) {
      banner.hidden = true;
      return;
    }
    if (snoozeUntil > Date.now()) {
      banner.hidden = true;
      return;
    }
    const remoteEl = document.getElementById('update-banner-remote');
    const localEl = document.getElementById('update-banner-local');
    if (remoteEl) remoteEl.textContent = String(result.remoteVersion || '?');
    if (localEl) localEl.textContent = String(result.localVersion || chrome.runtime.getManifest().version || '?');
    banner.hidden = false;
  } catch {
    banner.hidden = true;
  }
}

/**
 * Trigger a background update check. The service worker enforces the
 * once-per-hour rate limit; calling this on every popup open is safe.
 * If sendMessage fails (SW idle / API unavailable) we ignore it - the
 * banner still renders based on prior stored state.
 */
async function triggerBackgroundUpdateCheck() {
  try {
    await chrome.runtime.sendMessage({ type: 'fm:update-check:run' });
  } catch { /* ignored */ }
}

async function snoozeUpdateBanner(ms) {
  try {
    const until = Date.now() + ms;
    await chrome.storage.local.set({ [UPDATE_CHECK_SNOOZE_KEY]: until });
  } catch { /* ignored */ }
  const banner = document.getElementById('update-banner');
  if (banner) banner.hidden = true;
}

async function loadUpdateCheckIntoToggle() {
  const toggle = document.getElementById('update-check-toggle');
  if (!toggle) return;
  toggle.checked = await isUpdateCheckEnabled();
  // FMN-165: when the toggle is off, the manual "Check now" button must
  // also disable. The button respects the same flag - manual triggers
  // never override an explicit opt-out.
  syncManualCheckButtonEnabled(toggle.checked);
}

// -------- FMN-165: manual "Check for updates now" button --------

const MANUAL_CHECK_IDLE_LABEL = 'Check for updates now';
const MANUAL_CHECK_INFLIGHT_LABEL = 'Checking GitHub…';
// Up-to-date / failure result lines fade after this delay.
const MANUAL_CHECK_RESULT_OK_MS = 4_000;
const MANUAL_CHECK_RESULT_ERR_MS = 5_000;

let manualCheckResultTimer = null;

function syncManualCheckButtonEnabled(enabled) {
  const btn = document.getElementById('update-check-now');
  if (!btn) return;
  if (enabled) {
    btn.disabled = false;
    btn.removeAttribute('title');
  } else {
    btn.disabled = true;
    btn.title = 'Re-enable update checks above to run manually.';
  }
}

function clearManualCheckResultTimer() {
  if (manualCheckResultTimer !== null) {
    clearTimeout(manualCheckResultTimer);
    manualCheckResultTimer = null;
  }
}

function setManualCheckResult({ kind, text, autoHideMs }) {
  const line = document.getElementById('update-check-now-result');
  if (!line) return;
  clearManualCheckResultTimer();
  if (!kind) {
    line.hidden = true;
    line.textContent = '';
    line.className = 'update-check-result';
    return;
  }
  line.className = 'update-check-result ' + kind;
  line.textContent = text;
  line.hidden = false;
  if (autoHideMs && autoHideMs > 0) {
    manualCheckResultTimer = setTimeout(() => {
      // Re-fetch the element each time; the popup DOM is stable but the
      // closure is long-lived and defensive cheaper than reasoning about it.
      const el = document.getElementById('update-check-now-result');
      if (el) {
        el.hidden = true;
        el.textContent = '';
        el.className = 'update-check-result';
      }
      manualCheckResultTimer = null;
    }, autoHideMs);
  }
}

function setManualCheckButtonState(state) {
  const btn = document.getElementById('update-check-now');
  if (!btn) return;
  switch (state) {
    case 'in-flight':
      btn.disabled = true;
      btn.removeAttribute('title');
      btn.innerHTML = '';
      {
        const sp = document.createElement('span');
        sp.className = 'update-check-spinner';
        sp.setAttribute('aria-hidden', 'true');
        btn.appendChild(sp);
        btn.appendChild(document.createTextNode(MANUAL_CHECK_INFLIGHT_LABEL));
      }
      break;
    case 'hidden':
      btn.hidden = true;
      break;
    case 'idle':
    default:
      btn.hidden = false;
      btn.disabled = false;
      btn.removeAttribute('title');
      btn.textContent = MANUAL_CHECK_IDLE_LABEL;
      break;
  }
}

/**
 * Operator-initiated update check (FMN-165). Bypasses the 1h
 * rate-limit; still no-op if fm:updateCheckEnabled is false (which
 * already disables the button, but we double-check via the SW handler).
 *
 * SW handler returns { ok, result?: { ran, reason?, result? }, error? }.
 * Four UI outcomes:
 *   - newer-version: hide the button, re-render the banner above the tool grid.
 *   - up-to-date: green "Up to date (v{local})" line fades after a few seconds.
 *   - disabled / network / parse failure: red "Check failed: {reason}" line.
 *   - SW unreachable: red "Check failed: extension not ready" line.
 */
async function runManualUpdateCheck() {
  const btn = document.getElementById('update-check-now');
  if (!btn || btn.disabled) return;
  clearManualCheckResultTimer();
  setManualCheckResult({ kind: null });
  setManualCheckButtonState('in-flight');

  let envelope = null;
  let sendError = null;
  try {
    envelope = await chrome.runtime.sendMessage({
      type: 'fm:update-check:run',
      payload: { force: true }
    });
  } catch (err) {
    sendError = err?.message ?? String(err);
  }

  // SW handler is best-effort; treat any envelope.ok !== true as failure.
  if (sendError || !envelope || envelope.ok !== true) {
    setManualCheckButtonState('idle');
    setManualCheckResult({
      kind: 'error',
      text: 'Check failed: ' + (sendError || envelope?.error || 'extension not ready'),
      autoHideMs: MANUAL_CHECK_RESULT_ERR_MS
    });
    return;
  }

  const result = envelope.result;
  // checkForUpdate did not run (disabled / rate-limited / bad local / etc.).
  if (!result?.ran) {
    setManualCheckButtonState('idle');
    setManualCheckResult({
      kind: 'error',
      text: 'Check failed: ' + (result?.reason || 'unknown reason'),
      autoHideMs: MANUAL_CHECK_RESULT_ERR_MS
    });
    return;
  }

  // Successful fetch. Two sub-cases:
  if (result.result?.isNewer === true) {
    // Hide the button and re-render the banner; the banner reads
    // storage and renderUpdateBanner already handles the rest.
    setManualCheckResult({ kind: null });
    setManualCheckButtonState('hidden');
    await renderUpdateBanner();
    return;
  }

  // Up to date.
  setManualCheckButtonState('idle');
  const local = result.result?.localVersion ?? chrome.runtime.getManifest().version ?? '?';
  setManualCheckResult({
    kind: 'ok',
    text: 'Up to date (v' + local + ')',
    autoHideMs: MANUAL_CHECK_RESULT_OK_MS
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
  // FMN-157: read version from manifest so the footer never drifts. Prior
  // to this, popup.html hardcoded a stale v0.7.0 while the manifest moved
  // through 1.0.0 - reading at runtime closes the drift permanently.
  const versionEl = document.getElementById('version');
  if (versionEl) versionEl.textContent = 'v' + chrome.runtime.getManifest().version;

  // FMN-91: sort first, before any visibility / guard logic operates on the
  // tool list. Experimental toggles section is also sorted at popup load,
  // independent of whether the operator opens Settings this session.
  sortToolCardsAlphabetically();
  sortExperimentalTogglesAlphabetically();

  applyExperimentalVisibility();
  refreshGuards();

  // FMN-244/250: reveal the Custom Metrics tile on initial popup paint
  // when its flag is on. The Intro tile and the Training launcher tile
  // are always visible and need no async hydration.
  loadCustomMetricsTourState().catch(() => { /* failure means tile stays hidden */ });

  // FMN-191: render the recent-completions card + clear the toolbar
  // badge (the popup being open is the read-receipt). History stays.
  renderReportNotificationsCard().catch(() => { /* card stays hidden */ });
  clearReportNotificationsBadgeOnOpen();

  const reportNotifClearBtn = document.getElementById('report-notifications-clear-history');
  if (reportNotifClearBtn) {
    reportNotifClearBtn.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'report-notifications:clear-history', payload: {} });
      } catch { /* silent */ }
      await renderReportNotificationsCard();
    });
  }

  // FMN-157: render any prior update-check result immediately, then
  // ask the SW to refresh in the background (subject to the hour
  // rate limit inside checkForUpdate). The next popup open picks up
  // any new result.
  renderUpdateBanner();
  triggerBackgroundUpdateCheck();

  // FMN-169: mount per-feature info bubbles. Best-effort - failure
  // here must not block popup init. The mount itself is idempotent so
  // it is safe to call once at init even though the visibility of the
  // Bulk Composer tile and the update banner can change mid-session;
  // the bubble's anchors live on stable parents.
  mountInfoBubbles(document, { surface: 'popup' }).catch(() => { /* swallow */ });

  const snoozeBtn = document.getElementById('update-snooze');
  if (snoozeBtn) snoozeBtn.addEventListener('click', () => snoozeUpdateBanner(SNOOZE_7_DAYS_MS));
  const dismissBtn = document.getElementById('update-dismiss');
  if (dismissBtn) dismissBtn.addEventListener('click', () => snoozeUpdateBanner(SNOOZE_24_HOURS_MS));

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
    await loadSdwanReportIntoToggle();
    await loadFindDeleteDuplicatesIntoToggle();
    await loadTenantObservationsIntoToggle();
    await loadSsoConfigIntoToggle();
    await loadSidebarLauncherIntoToggle();
    await loadShowFeatureBadgesIntoToggle();
    await loadShowInfoBubblesIntoToggle();
    await loadCustomMetricsTourState();
    await loadOmniSearchIntoToggle();
    await loadSnapshotDiffIntoToggle();
    await applySnapshotDiffControlsVisibility();
    await loadSnapshotRotationIntoInput();
    await loadReportNotificationsIntoToggle();
    await applyReportNotificationsControlsVisibility();
    await loadUpdateCheckIntoToggle();
    await loadNoiseAnalyzerIntoToggle();
    await loadWebguiColumnsIntoSettings();
    await applyExperimentalVisibility();
    showSettings();
  });
  document.getElementById('settings-back').addEventListener('click', hideSettings);

  // FMN-246: Training drill-in. Launcher tile in the main popup list
  // enters the subview; Back returns. The .tool-card generic click
  // handler above ignores cards with no data-url, so the launcher
  // tile only fires this listener.
  const trainingLauncher = document.getElementById('training-launcher-tile');
  if (trainingLauncher) trainingLauncher.addEventListener('click', showTraining);
  const trainingBack = document.getElementById('training-back');
  if (trainingBack) trainingBack.addEventListener('click', hideTraining);
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

  document.getElementById('omni-search-toggle').addEventListener('change', async (e) => {
    await setOmniSearchEnabled(e.target.checked);
  });

  document.getElementById('snapshot-diff-toggle').addEventListener('change', async (e) => {
    await setSnapshotDiffEnabled(e.target.checked);
    // Phase 2.5: reveal/hide the rotation + clear-all controls when the
    // parent feature flag flips. Refresh the rotation input value when
    // revealing so it reflects current SW state.
    await applySnapshotDiffControlsVisibility();
    if (e.target.checked) await loadSnapshotRotationIntoInput();
  });

  // Phase 2.5: rotation input wiring. Persists on change/blur; the SW
  // clamps to [2, 50] so we don't redo client-side validation here.
  const rotationInput = document.getElementById('snapshot-rotation-input');
  if (rotationInput) {
    rotationInput.addEventListener('change', async (e) => {
      const raw = Number(e.target.value);
      if (!Number.isFinite(raw)) {
        setSnapshotInlineStatus('snapshot-rotation-status', 'Enter a number.', 'err');
        return;
      }
      setSnapshotInlineStatus('snapshot-rotation-status', 'Saving...', '');
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'observations-snapshots:set-max',
          payload: { maxSnapshots: raw },
        });
        if (response?.ok && response.result?.ok) {
          const applied = response.result.maxSnapshots;
          if (applied !== raw) {
            e.target.value = String(applied);
            setSnapshotInlineStatus('snapshot-rotation-status', `Clamped to ${applied}.`, 'ok');
          } else {
            setSnapshotInlineStatus('snapshot-rotation-status', 'Saved.', 'ok');
          }
        } else {
          const msg = response?.result?.message || response?.error || 'Save failed.';
          setSnapshotInlineStatus('snapshot-rotation-status', msg, 'err');
        }
      } catch (err) {
        setSnapshotInlineStatus('snapshot-rotation-status', `Save failed: ${err?.message || err}`, 'err');
      }
    });
  }

  // Phase 2.5: "Clear all snapshots" wiring. Uses a native confirm()
  // rather than a custom modal because the popup chrome is tight and a
  // modal would risk clipping inside the popup-mode viewport.
  const clearBtn = document.getElementById('snapshot-clear-all');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!window.confirm('Wipe every stored snapshot on this Chrome profile? This cannot be undone.')) {
        return;
      }
      clearBtn.disabled = true;
      setSnapshotInlineStatus('snapshot-clear-status', 'Clearing...', '');
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'observations-snapshots:clear-all',
          payload: {},
        });
        if (response?.ok && response.result?.ok) {
          setSnapshotInlineStatus('snapshot-clear-status', 'All snapshots cleared.', 'ok');
        } else {
          setSnapshotInlineStatus('snapshot-clear-status', response?.error || 'Clear failed.', 'err');
        }
      } catch (err) {
        setSnapshotInlineStatus('snapshot-clear-status', `Clear failed: ${err?.message || err}`, 'err');
      } finally {
        clearBtn.disabled = false;
      }
    });
  }

  // FMN-191: report-notifications toggle. Persists the flag; the SW
  // listens to chrome.storage.onChanged and re-arms/clears its polling
  // alarm accordingly.
  const reportNotifToggle = document.getElementById('report-notifications-toggle');
  if (reportNotifToggle) {
    reportNotifToggle.addEventListener('change', async (e) => {
      await setReportNotificationsEnabled(e.target.checked);
      await applyReportNotificationsControlsVisibility();
      if (e.target.checked) {
        // FMN-191: calibrate the detector baseline synchronously at
        // toggle-flip so reports generated in the first ~60s after enabling
        // don't get absorbed into the baseline by a deferred first poll.
        try {
          await chrome.runtime.sendMessage({ type: 'report-notifications:poll-now', payload: {} });
        } catch { /* swallow; SW may be momentarily idle */ }
      }
    });
  }

  const reportNotifTestBtn = document.getElementById('report-notifications-test');
  if (reportNotifTestBtn) {
    reportNotifTestBtn.addEventListener('click', async () => {
      reportNotifTestBtn.disabled = true;
      setSnapshotInlineStatus('report-notifications-test-status', 'Sending...', '');
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'report-notifications:test',
          payload: {},
        });
        if (response?.ok && response.result?.ok) {
          setSnapshotInlineStatus('report-notifications-test-status', 'Sent. Check your desktop.', 'ok');
        } else {
          setSnapshotInlineStatus('report-notifications-test-status', response?.error || 'Test failed.', 'err');
        }
      } catch (err) {
        setSnapshotInlineStatus('report-notifications-test-status', `Test failed: ${err?.message || err}`, 'err');
      } finally {
        reportNotifTestBtn.disabled = false;
      }
    });
  }

  // FMN-157: update-check toggle. Persists the flag; we don't try to
  // re-render the banner here since the operator is in Settings -
  // renderUpdateBanner runs again the next time the popup is opened
  // (and on Back, since hideSettings doesn't reset the main view).
  // FMN-165: keep the manual "Check now" button enabled-state in sync
  // with the toggle. Operator-initiated manual triggers still respect
  // the flag - the button never overrides an opt-out.
  const updateCheckToggle = document.getElementById('update-check-toggle');
  if (updateCheckToggle) {
    updateCheckToggle.addEventListener('change', async (e) => {
      await setUpdateCheckEnabled(e.target.checked);
      syncManualCheckButtonEnabled(e.target.checked);
      await renderUpdateBanner();
    });
  }

  // FMN-165: manual "Check for updates now" button. Wired once at
  // popup init; subsequent state transitions are driven by
  // runManualUpdateCheck.
  const updateCheckNow = document.getElementById('update-check-now');
  if (updateCheckNow) {
    updateCheckNow.addEventListener('click', () => {
      runManualUpdateCheck();
    });
  }

  // FMN-156 post-rework: noise-analyzer toggle removed from the popup.
  // The Noise Analysis content is folded into Incident Summary and runs
  // unconditionally. setNoiseAnalyzerEnabled / isNoiseAnalyzerEnabled
  // imports remain dormant for any operator who already toggled the
  // flag on; the value is no longer read anywhere in the runtime.

  document.getElementById('feature-badges-toggle').addEventListener('change', async (e) => {
    await setShowFeatureBadgesEnabled(e.target.checked);
  });

  // FMN-169: feature info bubbles master toggle. Flipping off hides
  // bubbles immediately (the bubble module's storage subscription
  // closes any open bubble and short-circuits future hovers). Flipping
  // back on preserves per-feature dismissals - they live under a
  // separate storage key and are not touched here.
  const infoBubblesToggle = document.getElementById('info-bubbles-toggle');
  if (infoBubblesToggle) {
    infoBubblesToggle.addEventListener('change', async (e) => {
      await setShowInfoBubblesEnabled(e.target.checked);
    });
  }

  // FMN-167/250: Intro to FortiMonitor tile click -> send
  // fm:intro-tour:start to the SW. The SW fans the message out to every
  // FortiMonitor tab; if none are open it opens one to /dashboards
  // first. Close the popup after dispatching so the operator's focus
  // snaps to the tour. The Settings toggle was retired in FMN-250 (the
  // tile is now always available inside the Training drill-in).
  const introTourTile = document.getElementById('training-intro-tour-tile');
  if (introTourTile) {
    introTourTile.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'fm:intro-tour:start' });
      } catch { /* SW unreachable - dispatch is best-effort */ }
      window.close();
    });
  }

  // FMN-244: Custom Metrics training tile. Independent (Beta) flag; same
  // dispatch shape as intro-tour but its own message type.
  const customMetricsToggle = document.getElementById('custom-metrics-tour-toggle');
  if (customMetricsToggle) {
    customMetricsToggle.addEventListener('change', async (e) => {
      await setCustomMetricsTourEnabled(e.target.checked);
      const tile = document.getElementById('training-custom-metrics-tile');
      if (tile) tile.hidden = !e.target.checked;
    });
  }
  const customMetricsTile = document.getElementById('training-custom-metrics-tile');
  if (customMetricsTile) {
    customMetricsTile.addEventListener('click', async () => {
      if (!(await isCustomMetricsTourEnabled())) return;
      try {
        await chrome.runtime.sendMessage({ type: 'fm:custom-metrics-tour:start' });
      } catch { /* SW unreachable - dispatch is best-effort */ }
      window.close();
    });
  }

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

  document.getElementById('sdwan-report-toggle').addEventListener('change', async (e) => {
    await setSdwanReportEnabled(e.target.checked);
    await applyExperimentalVisibility();
    await refreshGuards();
  });

  document.getElementById('find-delete-duplicates-toggle').addEventListener('change', async (e) => {
    await setFindDeleteDuplicatesEnabled(e.target.checked);
    await applyExperimentalVisibility();
    await refreshGuards();
  });

  document.getElementById('tenant-observations-toggle').addEventListener('change', async (e) => {
    await setTenantObservationsEnabled(e.target.checked);
    await applyExperimentalVisibility();
    await refreshGuards();
  });

  document.getElementById('sso-config-toggle').addEventListener('change', async (e) => {
    await setSsoConfigEnabled(e.target.checked);
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
