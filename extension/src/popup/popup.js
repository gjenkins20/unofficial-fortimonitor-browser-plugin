// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
import { isDevModeEnabled, setDevModeEnabled } from '../lib/settings.js';
import { resolveFortimonitorOrigin, FEDERATION_ORIGIN } from '../lib/origin-resolver.js';

const FORTICLOUD_URL = `${FEDERATION_ORIGIN}/`;
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
    ? 'Signed in to FortiCloud'
    : 'Not signed in — log in to FortiCloud first';
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
      desc.textContent = 'Sign in to FortiCloud to enable.';
      card.title = 'Sign in to FortiCloud (https://fortimonitor.forticloud.com/) to enable this tool.';
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
        ? 'Requires FortiMonitor v2 API key + Anthropic API key — manage in popup → Settings (⚙).'
        : 'Requires a FortiMonitor v2 API key — manage in popup → Settings (⚙).';
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

async function loadApiKeyIntoInput() {
  const data = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  const key = data?.[API_KEY_STORAGE_KEY];
  const input = document.getElementById('api-key-input');
  if (key) {
    // Show a masked placeholder; never re-display the real key.
    input.value = '';
    input.placeholder = `••••••••${key.slice(-4)} (saved — paste a new key to replace)`;
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
    input.placeholder = `••••••••${key.slice(-4)} (saved — paste a new key to replace)`;
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
  refreshGuards();

  document.getElementById('session-link').addEventListener('click', (e) => {
    e.preventDefault();
    openExternal(FORTICLOUD_URL);
  });

  for (const card of document.querySelectorAll('.tool-card')) {
    card.addEventListener('click', () => {
      if (card.classList.contains('disabled')) return;
      const path = card.dataset.url;
      if (path) openExtensionPage(path);
    });
  }

  document.getElementById('search').addEventListener('input', (e) => {
    filterTools(e.target.value);
  });

  document.getElementById('settings-toggle').addEventListener('click', async () => {
    clearStatus();
    clearClaudeStatus();
    await loadApiKeyIntoInput();
    await loadClaudeKeyIntoInput();
    await loadDevModeIntoToggle();
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
