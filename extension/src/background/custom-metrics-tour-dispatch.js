// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-244: Service-worker fan-out for the Custom Metrics training tour
// start message. Sibling of intro-tour-dispatch.js (FMN-167); same
// shape, different message type + landing URL.
//
// Flow:
//   1. Popup tile click sends { type: 'fm:custom-metrics-tour:start' } to
//      the SW.
//   2. This module's handler runs: query open FortiMonitor tabs, dispatch
//      the same message to each via chrome.tabs.sendMessage. Each tab's
//      content-script bridge (custom-metrics-tour-bridge.js) picks it up.
//   3. If no FortiMonitor tab is open, the SW opens one and dispatches
//      once it finishes loading.

const FM_TAB_URL_PATTERNS = [
  'https://fortimonitor.forticloud.com/*',
  'https://*.fortimonitor.com/*',
];
// FMN-244 QA rewrite: land on the real Custom Metrics page (hands-on tour)
// so the "Advanced Metrics" / "Add Custom Metric" anchors resolve on a fresh
// launch. Mirrors CUSTOM_METRICS_TOUR_CONSTANTS.LANDING_PATH in steps.js.
const FM_DEFAULT_LANDING_URL = 'https://fortimonitor.forticloud.com/config/ListCustomMetrics';
const START_MESSAGE = { type: 'fm:custom-metrics-tour:start' };
const TAB_LOAD_TIMEOUT_MS = 25_000;

export async function dispatchCustomMetricsTourStart({ tabsApi = chrome.tabs } = {}) {
  const existing = await tabsApi.query({ url: FM_TAB_URL_PATTERNS });
  if (Array.isArray(existing) && existing.length > 0) {
    let okCount = 0;
    for (const t of existing) {
      try { await tabsApi.sendMessage(t.id, START_MESSAGE); okCount += 1; } catch { /* this tab's bridge is stale/absent or navigating */ }
    }
    if (okCount > 0) return { delivered: existing.length, openedTab: null, reloadedTab: null };

    // FMN-253: every open FortiMonitor tab rejected the message - the
    // content-script bridge is stale or absent (typical when the extension
    // was reloaded/updated with a tab already open). Without this fallback
    // the tile click is a silent no-op and the toolkit looks broken. Reload
    // one tab to re-inject the bridge, then dispatch once it hits 'complete'.
    const target = existing[0];
    let delivered = 0;
    try {
      await tabsApi.reload(target.id);
      await waitForTabComplete(target.id, { tabsApi, timeoutMs: TAB_LOAD_TIMEOUT_MS });
      await tabsApi.sendMessage(target.id, START_MESSAGE);
      delivered = 1;
    } catch { /* reload or redispatch failed; report delivered:0 */ }
    return { delivered, openedTab: null, reloadedTab: target.id };
  }

  const newTab = await tabsApi.create({ url: FM_DEFAULT_LANDING_URL, active: true });
  await waitForTabComplete(newTab.id, { tabsApi, timeoutMs: TAB_LOAD_TIMEOUT_MS });
  let delivered = 0;
  try { await tabsApi.sendMessage(newTab.id, START_MESSAGE); delivered = 1; } catch { /* timeout / navigation */ }
  return { delivered, openedTab: newTab.id, reloadedTab: null };
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
      finish();
    }
  });
}

export function attachCustomMetricsTourStartHandler({ runtimeApi = chrome.runtime, tabsApi = chrome.tabs } = {}) {
  const listener = (msg, _sender, sendResponse) => {
    if (msg?.type !== 'fm:custom-metrics-tour:start') return false;
    dispatchCustomMetricsTourStart({ tabsApi })
      .then((result) => sendResponse?.({ ok: true, ...result }))
      .catch((err) => sendResponse?.({ ok: false, error: err?.message || String(err) }));
    return true;
  };
  runtimeApi.onMessage.addListener(listener);
  return () => runtimeApi.onMessage.removeListener(listener);
}
