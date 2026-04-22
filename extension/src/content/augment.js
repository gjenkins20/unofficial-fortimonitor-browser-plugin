// FMN-69: FortiMonitor WebGUI augmentation framework + FM Toolkit sidebar
// entry. Runs as a content script on FortiMonitor domains. Survives SPA
// re-renders via MutationObserver and route changes via pushState/replaceState
// /popstate hooks. Clicking the FM Toolkit entry toggles an iframe overlay
// that embeds the existing popup.html, so the sidebar menu IS the popup with
// identical styling, search, settings, tool cards, and behavior.

(() => {
  const LAUNCHER_ID = 'toolkit-launcher';
  const OVERLAY_ID = 'fmn-toolkit-overlay';
  const ENTRY_ATTR = 'data-fmn-entry';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const POPUP_URL = chrome.runtime.getURL('src/popup/popup.html');

  const augmentations = [];
  const overlayState = { el: null, outsideHandler: null, keyHandler: null };

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
    li.title = 'Open the Unofficial FortiMonitor Toolkit';
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
      userSelect: 'none',
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
      if (overlayState.el) {
        hideOverlay();
      } else {
        showOverlay(li);
      }
    });

    li.appendChild(buildGridIcon());
    const label = document.createElement('span');
    label.textContent = 'FM Toolkit';
    label.style.flex = '1';
    li.appendChild(label);
    return li;
  }

  function showOverlay(anchor) {
    if (overlayState.el) return;

    const anchorRect = anchor.getBoundingClientRect();
    const MARGIN = 8;
    const height = 540;
    const anchorMidY = (anchorRect.top + anchorRect.bottom) / 2;
    const top = anchorMidY - height / 2;

    const wrap = document.createElement('div');
    wrap.id = OVERLAY_ID;
    Object.assign(wrap.style, {
      position: 'fixed',
      left: (anchorRect.right + MARGIN) + 'px',
      top: top + 'px',
      width: '360px',
      height: height + 'px',
      background: '#fff',
      border: '1px solid #c5cbd3',
      borderRadius: '8px',
      boxShadow: '0 8px 28px rgba(0, 0, 0, 0.22)',
      overflow: 'hidden',
      zIndex: '2147483647',
      display: 'flex',
      flexDirection: 'column',
    });

    const iframe = document.createElement('iframe');
    iframe.src = POPUP_URL;
    iframe.setAttribute('title', 'Unofficial FortiMonitor Toolkit');
    Object.assign(iframe.style, {
      width: '100%',
      height: '100%',
      border: 'none',
      background: '#fff',
      display: 'block',
    });
    wrap.appendChild(iframe);

    document.body.appendChild(wrap);
    overlayState.el = wrap;

    const outsideHandler = (e) => {
      const target = e.target;
      if (wrap.contains(target) || anchor.contains(target) || target === anchor) return;
      hideOverlay();
    };
    document.addEventListener('mousedown', outsideHandler, true);
    overlayState.outsideHandler = outsideHandler;

    const keyHandler = (e) => {
      if (e.key === 'Escape') hideOverlay();
    };
    document.addEventListener('keydown', keyHandler);
    overlayState.keyHandler = keyHandler;
  }

  function hideOverlay() {
    if (overlayState.el) {
      overlayState.el.remove();
      overlayState.el = null;
    }
    if (overlayState.outsideHandler) {
      document.removeEventListener('mousedown', overlayState.outsideHandler, true);
      overlayState.outsideHandler = null;
    }
    if (overlayState.keyHandler) {
      document.removeEventListener('keydown', overlayState.keyHandler);
      overlayState.keyHandler = null;
    }
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
