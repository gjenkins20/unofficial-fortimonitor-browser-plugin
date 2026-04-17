// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
const FORTICLOUD_URL = 'https://fortimonitor.forticloud.com/';
const XSRF_COOKIE = 'XSRF-TOKEN';

async function sessionActive() {
  try {
    const cookie = await chrome.cookies.get({ url: FORTICLOUD_URL, name: XSRF_COOKIE });
    return Boolean(cookie && cookie.value);
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

  for (const card of document.querySelectorAll('.tool-card')) {
    const needsSession = card.dataset.sessionRequired === 'true';
    card.classList.toggle('disabled', needsSession && !ok);
    const desc = card.querySelector('.tool-desc');
    if (!ok && needsSession) {
      desc.textContent = 'Sign in to FortiCloud to enable.';
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

function init() {
  sessionActive().then(setSessionState);

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
