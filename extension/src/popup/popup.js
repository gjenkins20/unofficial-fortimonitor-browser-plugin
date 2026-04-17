// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
const FORTICLOUD_URL = 'https://fortimonitor.forticloud.com/';
const XSRF_COOKIE = 'XSRF-TOKEN';
const API_KEY_STORAGE_KEY = 'panopta.apiKey';

async function sessionActive() {
  try {
    const cookie = await chrome.cookies.get({ url: FORTICLOUD_URL, name: XSRF_COOKIE });
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

function applyToolGuards({ sessionOk, apiKeyOk }) {
  for (const card of document.querySelectorAll('.tool-card')) {
    const needsSession = card.dataset.sessionRequired === 'true';
    const needsApiKey = card.dataset.apiKeyRequired === 'true';
    const blocked = (needsSession && !sessionOk) || (needsApiKey && !apiKeyOk);
    card.classList.toggle('disabled', blocked);
    const desc = card.querySelector('.tool-desc');
    if (needsSession && !sessionOk) {
      desc.textContent = 'Sign in to FortiCloud to enable.';
    } else if (needsApiKey && !apiKeyOk) {
      desc.textContent = 'Set a FortiMonitor v2 API key in Settings (⚙) to enable.';
    } else {
      desc.textContent = desc.dataset.defaultDesc ?? desc.textContent;
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
  const [sessionOk, apiKeyOk] = await Promise.all([sessionActive(), apiKeyConfigured()]);
  setSessionState(sessionOk);
  applyToolGuards({ sessionOk, apiKeyOk });
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
    await loadApiKeyIntoInput();
    showSettings();
  });
  document.getElementById('settings-back').addEventListener('click', hideSettings);
  document.getElementById('api-key-save').addEventListener('click', saveApiKey);
  document.getElementById('api-key-clear').addEventListener('click', clearApiKey);
  document.getElementById('api-key-test').addEventListener('click', testConnection);

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
