// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-167: service-worker fan-out for the intro-tour start message.
//
// Flow:
//   1. Popup tile click sends { type: 'fm:intro-tour:start' } to the SW.
//   2. This module's handler runs: query open FortiMonitor tabs, dispatch
//      the same message to each tab via chrome.tabs.sendMessage. Each
//      tab's content-script bridge (intro-tour-bridge.js) picks it up.
//   3. If no FortiMonitor tab is open, the SW opens one to /dashboards
//      and dispatches once the tab finishes loading.
//
// The chrome.runtime.sendMessage from popup -> SW is the safe path
// because the SW has chrome.tabs access; content scripts do not. The
// SW is the only context that can fan one runtime message out to many
// tabs.

const FM_TAB_URL_PATTERNS = [
  'https://fortimonitor.forticloud.com/*',
  'https://*.fortimonitor.com/*',
];
const FM_DEFAULT_DASHBOARDS_URL = 'https://fortimonitor.forticloud.com/dashboards';
const START_MESSAGE = { type: 'fm:intro-tour:start' };
// Cap how long we wait for a freshly-opened FM tab to reach 'complete'
// before giving up and dispatching anyway. 25s covers a slow first-load
// + auth handshake; longer than that and the operator should re-trigger.
const TAB_LOAD_TIMEOUT_MS = 25_000;

/**
 * Send the start message to every FortiMonitor tab. Opens a new tab if
 * none is open and waits for it to finish loading before dispatching.
 * Returns the number of tabs the message was delivered to (1+).
 *
 * Dependency-injected for testability: pass in `tabsApi` so unit tests
 * can stub `query`, `sendMessage`, `create`, and `onUpdated`.
 */
export async function dispatchIntroTourStart({ tabsApi = chrome.tabs } = {}) {
  const existing = await tabsApi.query({ url: FM_TAB_URL_PATTERNS });
  if (Array.isArray(existing) && existing.length > 0) {
    for (const t of existing) {
      try { await tabsApi.sendMessage(t.id, START_MESSAGE); } catch { /* tab may be navigating; skip */ }
    }
    return { delivered: existing.length, openedTab: null };
  }

  const newTab = await tabsApi.create({ url: FM_DEFAULT_DASHBOARDS_URL, active: true });
  // Wait for the new tab to finish loading before dispatching - sending
  // the message before the content script registers its onMessage
  // listener silently drops on the floor.
  await waitForTabComplete(newTab.id, { tabsApi, timeoutMs: TAB_LOAD_TIMEOUT_MS });
  try { await tabsApi.sendMessage(newTab.id, START_MESSAGE); } catch { /* timeout / navigation */ }
  return { delivered: 1, openedTab: newTab.id };
}

function waitForTabComplete(tabId, { tabsApi, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      tabsApi.onUpdated?.removeListener?.(listener);
      resolve();
    };
    function listener(updatedId, info) {
      if (updatedId === tabId && info.status === 'complete') finish();
    }
    if (tabsApi.onUpdated?.addListener) {
      tabsApi.onUpdated.addListener(listener);
      timer = setTimeout(finish, timeoutMs);
    } else {
      // No onUpdated surface available (older tests / odd shims).
      // Resolve synchronously so the dispatch can proceed.
      finish();
    }
  });
}

/**
 * Plug the start-message handler into chrome.runtime.onMessage. Returns
 * a teardown function for tests. The popup tile click is the expected
 * sender, but any extension context can dispatch.
 */
export function attachIntroTourStartHandler({ runtimeApi = chrome.runtime, tabsApi = chrome.tabs } = {}) {
  const listener = (msg, _sender, sendResponse) => {
    if (msg?.type !== 'fm:intro-tour:start') return false;
    dispatchIntroTourStart({ tabsApi })
      .then((result) => sendResponse?.({ ok: true, ...result }))
      .catch((err) => sendResponse?.({ ok: false, error: err?.message || String(err) }));
    // Return true to keep the message channel open for the async response.
    return true;
  };
  runtimeApi.onMessage.addListener(listener);
  return () => runtimeApi.onMessage.removeListener(listener);
}
