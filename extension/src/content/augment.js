// FMN-69: FortiMonitor WebGUI augmentation framework + toolkit-launcher sidebar entry.
// Runs as a content script on FortiMonitor domains. Survives SPA re-renders via
// MutationObserver and route changes via pushState/replaceState/popstate hooks.

(() => {
  const LAUNCHER_ID = 'toolkit-launcher';
  const ENTRY_ATTR = 'data-fmn-entry';
  const LAUNCHER_URL = chrome.runtime.getURL('src/popup/popup.html') + '?mode=tab';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const augmentations = [];

  function register(aug) {
    augmentations.push(aug);
  }

  function ensureAll() {
    for (const aug of augmentations) {
      try {
        aug.mount();
      } catch (err) {
        console.error('[FMN augment]', aug.id, err);
      }
    }
  }

  // --- Toolkit launcher: sidebar entry below Teams & Activity -----------------

  register({
    id: LAUNCHER_ID,
    mount() {
      if (document.querySelector(`[${ENTRY_ATTR}="${LAUNCHER_ID}"]`)) return;
      const anyTopLevel = document.querySelector('li.pa-side-nav__top-level-item');
      if (!anyTopLevel || !anyTopLevel.parentElement) return;
      anyTopLevel.parentElement.appendChild(buildLauncherEntry());
    },
  });

  function buildLauncherEntry() {
    const li = document.createElement('li');
    li.setAttribute(ENTRY_ATTR, LAUNCHER_ID);
    li.className = 'pa-side-nav__top-level-item pa-py-8';
    li.title = 'Open the Unofficial FortiMonitor Toolkit launcher';
    Object.assign(li.style, {
      background: '#1f6feb',
      color: '#fff',
      fontWeight: '600',
      margin: '6px 10px',
      padding: '9px 14px',
      borderRadius: '5px',
      border: '1px solid #1a5fcf',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      cursor: 'pointer',
      listStyle: 'none',
      fontSize: '14px',
      lineHeight: '1',
      transition: 'background 120ms ease',
    });
    li.addEventListener('mouseenter', () => {
      li.style.background = '#1a5fcf';
    });
    li.addEventListener('mouseleave', () => {
      li.style.background = '#1f6feb';
    });
    li.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.open(LAUNCHER_URL, '_blank', 'noopener');
    });

    li.appendChild(buildGridIcon());
    const label = document.createElement('span');
    label.textContent = 'FM Toolkit';
    li.appendChild(label);
    return li;
  }

  function buildGridIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.style.flexShrink = '0';
    for (const [x, y] of [[3, 3], [14, 3], [3, 14], [14, 14]]) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', '7');
      rect.setAttribute('height', '7');
      rect.setAttribute('rx', '1');
      svg.appendChild(rect);
    }
    return svg;
  }

  // --- Survival loop ----------------------------------------------------------

  function start() {
    ensureAll();
    const observer = new MutationObserver(() => ensureAll());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
      const r = origPush.apply(this, arguments);
      queueMicrotask(ensureAll);
      return r;
    };
    history.replaceState = function () {
      const r = origReplace.apply(this, arguments);
      queueMicrotask(ensureAll);
      return r;
    };
    window.addEventListener('popstate', ensureAll);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
