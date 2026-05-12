// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-169: hover-triggered info bubbles for toolkit features.
//
// Vanilla DOM, no libraries (matches the project's no-dep pattern).
// Mounted by augment.js (content surface) and popup.js (popup surface)
// via mountInfoBubbles(rootEl, { surface }). Subsequent calls are
// idempotent - anchors that already carry the data-fmn-info-bubble-ready
// attribute are skipped, so MutationObserver-driven re-runs never
// stack handlers or icons.
//
// Per memory raf_throttled_on_fortimonitor.md: avoid requestAnimationFrame
// for any UI scheduling on FortiMonitor pages; setTimeout is the reliable
// path for the 500 ms hover delay.
//
// Per memory html_hidden_vs_class_display.md: the bubble's [hidden]
// state must coexist with the `display: block` rule we apply when
// visible. The injected stylesheet ships an explicit
// `.fmn-info-bubble[hidden] { display: none; }` so the attribute wins.
//
// Per CLAUDE.md augment.js section + FMN-72 lesson: every DOM write in
// this module is gated by a marker attribute on the anchor. The mount
// loop is therefore a no-op on the second pass - no MutationObserver
// feedback loop is possible from this module.

import {
  getInfoBubblesForSurface,
  getInfoBubbleEntry,
} from './info-bubble-registry.js';
import {
  isShowInfoBubblesEnabled,
  getDismissedInfoBubbles,
  addDismissedInfoBubble,
  SHOW_INFO_BUBBLES_KEY,
  DISMISSED_INFO_BUBBLES_KEY,
} from './settings.js';

const STYLE_ID = 'fmn-info-bubble-styles';
const READY_ATTR = 'data-fmn-info-bubble-ready';
const ICON_ATTR = 'data-fmn-info-bubble-icon';
const BUBBLE_ATTR = 'data-fmn-info-bubble';
const FEATURE_ATTR = 'data-fmn-info-bubble-feature';
const HOVER_DELAY_MS = 500;

// Single live module-state object. Holds the currently-open bubble (one
// at a time across the document) and the global flag value. The flag
// is read once at mountInfoBubbles() time and refreshed by the
// chrome.storage.onChanged subscription so toggling the popup setting
// suppresses bubbles immediately on the next hover.
const state = {
  showEnabled: true,
  dismissed: new Set(),
  openBubble: null,
  openAnchor: null,
  hoverTimer: null,
  storageSubscribed: false,
  // Test hook: in headless / JSDOM tests we want to bypass the 500 ms
  // delay so assertions don't have to await wall-clock time. Reset to
  // HOVER_DELAY_MS on each fresh mount; tests can stomp it via the
  // exported setter below.
  hoverDelayMs: HOVER_DELAY_MS,
};

function ensureStyles(root) {
  // Stylesheet lives in the document head so it covers the whole
  // surface. Idempotent.
  const doc = root.ownerDocument || root;
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .fmn-info-bubble-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #1f6feb;
      color: #fff;
      font: 600 9px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      cursor: help;
      margin: 0 4px;
      vertical-align: middle;
      user-select: none;
      flex: 0 0 auto;
    }
    .fmn-info-bubble-icon::before {
      content: "i";
      font-style: italic;
    }
    .fmn-info-bubble-icon:hover {
      background: #1858c4;
    }
    .fmn-info-bubble {
      position: fixed;
      z-index: 2147483647;
      max-width: 320px;
      min-width: 200px;
      padding: 10px 12px;
      background: #fffef5;
      color: #2a3142;
      border: 1px solid #e0d9b8;
      border-radius: 6px;
      box-shadow: 0 6px 22px rgba(16, 22, 26, 0.18);
      font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      pointer-events: auto;
    }
    /* Scoped [hidden] override so any class rule that sets display
       (e.g. inherited inline-flex from FortiMonitor) cannot defeat
       the attribute. */
    .fmn-info-bubble[hidden] {
      display: none !important;
    }
    .fmn-info-bubble-title {
      font-size: 12px;
      font-weight: 600;
      margin: 0 0 4px;
      color: #1f2535;
    }
    .fmn-info-bubble-body {
      font-size: 11.5px;
      line-height: 1.45;
      margin: 0 0 8px;
      color: #4a5160;
      word-wrap: break-word;
    }
    .fmn-info-bubble-footer {
      display: flex;
      gap: 10px;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
    }
    .fmn-info-bubble-learn {
      color: #1f6feb;
      text-decoration: none;
      font-weight: 500;
    }
    .fmn-info-bubble-learn:hover {
      text-decoration: underline;
    }
    .fmn-info-bubble-dismiss {
      background: none;
      border: none;
      padding: 0;
      color: #8b8678;
      font: inherit;
      cursor: pointer;
      text-decoration: underline;
    }
    .fmn-info-bubble-dismiss:hover {
      color: #2a3142;
    }
  `;
  doc.head.appendChild(style);
}

/**
 * Read the current global flag + dismissal set into state. Called at
 * mount and on storage-change events. Wrapped in try/catch so a single
 * storage blip cannot crash the whole bubble subsystem.
 */
async function refreshSettings() {
  try {
    state.showEnabled = await isShowInfoBubblesEnabled();
  } catch { state.showEnabled = true; }
  try {
    const dismissed = await getDismissedInfoBubbles();
    state.dismissed = new Set(dismissed);
  } catch { state.dismissed = new Set(); }
}

function subscribeStorage() {
  if (state.storageSubscribed) return;
  // chrome may not exist in JSDOM-style harnesses; bail quietly.
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName && areaName !== 'local') return;
    const flagChange = changes && changes[SHOW_INFO_BUBBLES_KEY];
    if (flagChange) {
      const nextFlag = flagChange.newValue;
      state.showEnabled = nextFlag === undefined ? true : Boolean(nextFlag);
      // If the flag flipped off mid-session, hide any open bubble. The
      // per-feature dismissal set is intentionally preserved so toggling
      // back on does not reset prior dismissals.
      if (!state.showEnabled) hideBubble();
    }
    const dismissChange = changes && changes[DISMISSED_INFO_BUBBLES_KEY];
    if (dismissChange) {
      const next = dismissChange.newValue;
      state.dismissed = new Set(Array.isArray(next) ? next : []);
    }
  });
  state.storageSubscribed = true;
}

function classifyAnchorForFeature(entry, el) {
  // anchorMode 'self' attaches handlers directly to the matched element.
  // anchorMode 'icon' inserts a small "i" anchor sibling whose hover
  // shows the bubble. Self mode covers existing toolkit elements (the
  // FMN-86 ribbon, sub-headers); icon mode covers everything else.
  return entry.anchorMode === 'icon' ? 'icon' : 'self';
}

function buildIcon(featureId) {
  const span = document.createElement('span');
  span.className = 'fmn-info-bubble-icon';
  span.setAttribute(ICON_ATTR, '1');
  span.setAttribute(FEATURE_ATTR, featureId);
  span.setAttribute('role', 'button');
  span.setAttribute('tabindex', '0');
  span.setAttribute('aria-label', 'About this toolkit feature');
  return span;
}

function placeIcon(anchorEl, iconEl, mountTarget) {
  switch (mountTarget) {
    case 'before':
      if (anchorEl.parentNode) anchorEl.parentNode.insertBefore(iconEl, anchorEl);
      break;
    case 'after':
      if (anchorEl.parentNode) anchorEl.parentNode.insertBefore(iconEl, anchorEl.nextSibling);
      break;
    case 'prepend':
      anchorEl.insertBefore(iconEl, anchorEl.firstChild);
      break;
    case 'append':
    default:
      anchorEl.appendChild(iconEl);
      break;
  }
}

/**
 * Position the open bubble next to its trigger. Uses fixed positioning
 * + getBoundingClientRect so the bubble stays anchored even on a
 * scrolling parent. Flips above the trigger if there is not enough room
 * below; flips left if it would overflow the viewport on the right.
 */
function positionBubble(triggerEl, bubble) {
  const rect = triggerEl.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const margin = 8;
  // Measure bubble after it's been inserted so we have real dimensions.
  bubble.style.left = '0px';
  bubble.style.top = '0px';
  const bw = bubble.offsetWidth || 280;
  const bh = bubble.offsetHeight || 100;

  let top = rect.bottom + margin;
  if (top + bh > vh - 4 && rect.top - margin - bh > 4) {
    top = rect.top - margin - bh;
  }
  let left = rect.left;
  if (left + bw > vw - 4) left = Math.max(4, vw - bw - 4);
  bubble.style.top = `${Math.max(4, top)}px`;
  bubble.style.left = `${Math.max(4, left)}px`;
}

function hideBubble() {
  if (state.hoverTimer) {
    clearTimeout(state.hoverTimer);
    state.hoverTimer = null;
  }
  if (state.openBubble) {
    if (state.openBubble.parentNode) state.openBubble.parentNode.removeChild(state.openBubble);
    state.openBubble = null;
    state.openAnchor = null;
  }
}

function showBubbleFor(entry, triggerEl) {
  // Global flag off or this feature dismissed: nothing to show.
  if (!state.showEnabled) return;
  if (state.dismissed.has(entry.featureId)) return;
  hideBubble();

  const doc = triggerEl.ownerDocument || document;
  const bubble = doc.createElement('div');
  bubble.className = 'fmn-info-bubble';
  bubble.setAttribute(BUBBLE_ATTR, '1');
  bubble.setAttribute(FEATURE_ATTR, entry.featureId);
  bubble.setAttribute('role', 'tooltip');

  const title = doc.createElement('div');
  title.className = 'fmn-info-bubble-title';
  title.textContent = entry.title;
  bubble.appendChild(title);

  const body = doc.createElement('p');
  body.className = 'fmn-info-bubble-body';
  body.textContent = entry.body;
  bubble.appendChild(body);

  const footer = doc.createElement('div');
  footer.className = 'fmn-info-bubble-footer';

  const learn = doc.createElement('a');
  learn.className = 'fmn-info-bubble-learn';
  learn.href = entry.learnMoreUrl;
  learn.target = '_blank';
  learn.rel = 'noopener noreferrer';
  learn.textContent = 'Learn more →';
  footer.appendChild(learn);

  const dismiss = doc.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'fmn-info-bubble-dismiss';
  dismiss.textContent = "× don't show me this again";
  dismiss.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.dismissed.add(entry.featureId);
    hideBubble();
    await addDismissedInfoBubble(entry.featureId);
  });
  footer.appendChild(dismiss);

  bubble.appendChild(footer);
  doc.body.appendChild(bubble);

  state.openBubble = bubble;
  state.openAnchor = triggerEl;
  positionBubble(triggerEl, bubble);
}

function attachHandlersToTrigger(entry, triggerEl) {
  if (triggerEl.hasAttribute(READY_ATTR)) return;
  triggerEl.setAttribute(READY_ATTR, '1');

  const onEnter = () => {
    if (state.hoverTimer) clearTimeout(state.hoverTimer);
    state.hoverTimer = setTimeout(() => {
      showBubbleFor(entry, triggerEl);
    }, state.hoverDelayMs);
  };
  const onLeave = (e) => {
    if (state.hoverTimer) {
      clearTimeout(state.hoverTimer);
      state.hoverTimer = null;
    }
    // Allow the mouse to travel onto the bubble itself (so the Learn
    // more link and dismiss button are reachable). The bubble has its
    // own mouseleave handler that hides on exit.
    const next = e.relatedTarget;
    if (next && state.openBubble && (next === state.openBubble || state.openBubble.contains(next))) {
      return;
    }
    // Give the cursor a tick to land on the bubble before we yank it.
    setTimeout(() => {
      if (!state.openBubble) return;
      // If the mouse is still over the bubble or the trigger, keep
      // showing. Otherwise, hide.
      const hovered = state.openBubble.matches(':hover');
      const onAnchor = triggerEl.matches && triggerEl.matches(':hover');
      if (!hovered && !onAnchor) hideBubble();
    }, 80);
  };
  triggerEl.addEventListener('mouseenter', onEnter);
  triggerEl.addEventListener('mouseleave', onLeave);
  // Touch: tap toggles the bubble.
  triggerEl.addEventListener('click', (e) => {
    // For 'icon' triggers the icon is a non-interactive span; for
    // 'self' triggers (existing toolkit ribbon / sub-header) the
    // click might already mean something else, so we listen but do
    // NOT preventDefault. Just show.
    if (state.openBubble && state.openAnchor === triggerEl) {
      hideBubble();
    } else {
      showBubbleFor(entry, triggerEl);
    }
    e.stopPropagation();
  });
}

function installGlobalDismissHandlers() {
  if (installGlobalDismissHandlers.installed) return;
  document.addEventListener('click', (e) => {
    if (!state.openBubble) return;
    const target = e.target;
    if (state.openBubble.contains(target)) return;
    if (state.openAnchor && state.openAnchor.contains && state.openAnchor.contains(target)) return;
    hideBubble();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.openBubble) hideBubble();
  });
  installGlobalDismissHandlers.installed = true;
}

/**
 * Mount bubble hover anchors for every registry entry matching the
 * given surface. Idempotent: per-anchor READY_ATTR marker means
 * subsequent calls on the same root no-op for already-handled anchors.
 * Safe to call from a MutationObserver: anchors that match selectors
 * but are already wired up cost a single attribute read per call.
 *
 * @param {Document | HTMLElement} root
 * @param {{ surface: 'content' | 'popup' }} options
 * @returns {Promise<{mountedAnchors: number, addedIcons: number}>}
 */
export async function mountInfoBubbles(root, { surface } = { surface: 'content' }) {
  if (!root) return { mountedAnchors: 0, addedIcons: 0 };
  await refreshSettings();
  subscribeStorage();
  ensureStyles(root);
  installGlobalDismissHandlers();

  let mountedAnchors = 0;
  let addedIcons = 0;

  for (const entry of getInfoBubblesForSurface(surface)) {
    let matches;
    try {
      matches = root.querySelectorAll(entry.anchorSelector);
    } catch {
      // A bad selector should not blow up the whole mount loop.
      // Skip and continue.
      continue;
    }
    for (const el of matches) {
      const mode = classifyAnchorForFeature(entry, el);
      if (mode === 'self') {
        if (el.hasAttribute(READY_ATTR)) continue;
        attachHandlersToTrigger(entry, el);
        mountedAnchors += 1;
      } else {
        // 'icon' - if this anchor already has an icon as a descendant
        // we wired up earlier, skip.
        if (el.hasAttribute(READY_ATTR)) continue;
        el.setAttribute(READY_ATTR, '1');
        // Check the planned mount slot to avoid double-icons when
        // mount cycles re-discover the same anchor across a Vue
        // re-render. The READY_ATTR alone is sufficient under
        // normal mount; the existing-icon search is defense-in-depth.
        const mountTarget = entry.mountTarget || 'append';
        let existingIcon = null;
        if (mountTarget === 'before' || mountTarget === 'after') {
          existingIcon = el.parentNode && el.parentNode.querySelector(
            `[${ICON_ATTR}][${FEATURE_ATTR}="${cssEscape(entry.featureId)}"]`
          );
        } else {
          existingIcon = el.querySelector(
            `[${ICON_ATTR}][${FEATURE_ATTR}="${cssEscape(entry.featureId)}"]`
          );
        }
        const icon = existingIcon || buildIcon(entry.featureId);
        if (!existingIcon) {
          placeIcon(el, icon, mountTarget);
          addedIcons += 1;
        }
        attachHandlersToTrigger(entry, icon);
        mountedAnchors += 1;
      }
    }
  }

  return { mountedAnchors, addedIcons };
}

/**
 * Cheap CSS.escape polyfill: registry featureIds are kebab-case so the
 * full spec isn't needed - just guard against accidental quotes /
 * brackets that could break the attribute selector. Returns the input
 * unchanged for the registry's actual values; only the dangerous chars
 * are escaped.
 */
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return String(value).replace(/["\\\[\]]/g, '\\$&');
}

/**
 * Hide any currently-open bubble. Exported for use by augment.js on
 * SPA route changes (so a stale bubble does not float over the new
 * page).
 */
export function dismissOpenInfoBubble() {
  hideBubble();
}

/**
 * Test hook: override the hover delay so JSDOM / Playwright assertions
 * do not have to wait 500 ms. Reset to default via setInfoBubbleHoverDelay(undefined).
 *
 * @param {number | undefined} delayMs
 */
export function setInfoBubbleHoverDelay(delayMs) {
  state.hoverDelayMs = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : HOVER_DELAY_MS;
}

/**
 * Test hook: reset module-level state between tests. Production code
 * never calls this; the module is normally singleton-per-page.
 */
export function _resetInfoBubbleStateForTests() {
  hideBubble();
  state.showEnabled = true;
  state.dismissed = new Set();
  state.openBubble = null;
  state.openAnchor = null;
  state.hoverTimer = null;
  state.storageSubscribed = false;
  state.hoverDelayMs = HOVER_DELAY_MS;
  installGlobalDismissHandlers.installed = false;
}

// Exposed only for tests that want to inspect what the module thinks
// the current state is without round-tripping through chrome.storage.
export function _getInfoBubbleStateForTests() {
  return {
    showEnabled: state.showEnabled,
    dismissed: new Set(state.dismissed),
    openFeatureId: state.openBubble ? state.openBubble.getAttribute(FEATURE_ATTR) : null,
    hoverDelayMs: state.hoverDelayMs,
  };
}
