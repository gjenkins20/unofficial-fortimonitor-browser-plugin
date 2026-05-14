// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-191: SW-side wiring for the report-completion notification
// feature. Owns the polling loop, the chrome.notifications.create
// dispatch, and the message handlers the popup uses for the toggle +
// test-notification button.

import {
  STORAGE_KEY,
  HISTORY_STORAGE_KEY,
  initialState,
  classifyPoll,
  notificationText,
  appendHistory,
  extractCompletedReports,
} from '../lib/report-notification-detector.js';

const POLL_ENDPOINT = 'https://fortimonitor.forticloud.com/report/get_canned_history_report_requests_data';
const POLL_ALARM = 'fm:reportNotificationPoll';
const POLL_PERIOD_MIN = 1;             // every 60s while feature on
const NOTIFICATION_ID_PREFIX = 'fm-report-ready-';
const SETTINGS_KEY = 'fm:reportNotificationsEnabled';

// One poll: fetch the endpoint with credentials, update detector state,
// fire a chrome.notifications.create on every count increase.
async function pollOnce(deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch.bind(globalThis);
  const storage = deps.storage || chrome.storage?.local;
  if (!storage) return { ok: false, reason: 'no-storage' };
  let resp;
  try {
    resp = await fetchImpl(POLL_ENDPOINT + '?_=' + Date.now(), {
      credentials: 'include',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
      },
    });
  } catch (err) {
    return { ok: false, reason: 'network', message: err?.message || String(err) };
  }
  if (!resp.ok) return { ok: false, reason: 'http', status: resp.status };
  const ct = resp.headers.get('content-type') || '';
  if (!/json/i.test(ct)) {
    // FortiMonitor returns the SPA shell HTML when the session has lapsed.
    // Treat as transient; do not touch state.
    return { ok: false, reason: 'session-lapsed' };
  }
  let payload;
  try { payload = await resp.json(); } catch { return { ok: false, reason: 'parse' }; }
  if (!payload || typeof payload.recordsTotal !== 'number') {
    return { ok: false, reason: 'unexpected-shape' };
  }
  const prior = (await storage.get(STORAGE_KEY))?.[STORAGE_KEY] || null;
  const { nextState, notify } = classifyPoll(prior, payload.recordsTotal);
  await storage.set({ [STORAGE_KEY]: nextState });
  if (notify) {
    // Pull per-row detail for the new completions so the bell can show
    // report name + download link instead of just a count.
    const reports = extractCompletedReports(payload.data, notify.delta);
    const enriched = { ...notify, reports };
    await fireNotification(enriched, deps);
    const priorHistory = (await storage.get(HISTORY_STORAGE_KEY))?.[HISTORY_STORAGE_KEY] || [];
    const nextHistory = appendHistory(priorHistory, enriched);
    await storage.set({ [HISTORY_STORAGE_KEY]: nextHistory });
    await bumpBadge(deps);
    return { ok: true, notify: enriched, recordsTotal: payload.recordsTotal };
  }
  return { ok: true, notify: null, recordsTotal: payload.recordsTotal };
}

// Toolbar badge: shows the count of unread completion notifications since
// the popup was last opened. Stored separately from the history so the
// badge can be cleared without losing the history.
const BADGE_KEY = 'fm:reportNotificationBadge';

async function bumpBadge(deps = {}) {
  const storage = deps.storage || chrome.storage?.local;
  if (!storage) return;
  const prior = (await storage.get(BADGE_KEY))?.[BADGE_KEY] || 0;
  const next = (Number.isFinite(prior) ? prior : 0) + 1;
  await storage.set({ [BADGE_KEY]: next });
  await renderBadge(next, deps);
}

async function clearBadge(deps = {}) {
  const storage = deps.storage || chrome.storage?.local;
  if (!storage) return;
  await storage.set({ [BADGE_KEY]: 0 });
  await renderBadge(0, deps);
}

async function renderBadge(count, deps = {}) {
  const setText = deps.setBadgeText ||
    ((opts) => new Promise((resolve) =>
      (typeof chrome !== 'undefined' && chrome.action?.setBadgeText)
        ? chrome.action.setBadgeText(opts, resolve)
        : resolve()
    ));
  const setBgColor = deps.setBadgeBackgroundColor ||
    ((opts) => new Promise((resolve) =>
      (typeof chrome !== 'undefined' && chrome.action?.setBadgeBackgroundColor)
        ? chrome.action.setBadgeBackgroundColor(opts, resolve)
        : resolve()
    ));
  try {
    await setText({ text: count > 0 ? String(count) : '' });
    if (count > 0) await setBgColor({ color: '#ed4f0e' });
  } catch { /* action API unavailable in unit tests */ }
}

// In-page bell (FMN-191 pivot) is the primary completion surface; the SW
// no longer fires an OS-level chrome.notifications. fireNotification stays
// as the side-effect hook for tests + the "Send test notification" path,
// which now broadcasts a synthetic event the augment.js bell listens for.
async function fireNotification(notify, deps = {}) {
  const create = deps.createNotification ||
    ((id, opts) => Promise.resolve({ id, opts })); // no-op in production
  const { title, message } = notificationText(notify);
  const id = NOTIFICATION_ID_PREFIX + Date.now();
  try {
    await create(id, { type: 'in-page-bell', title, message, priority: 1 });
  } catch { /* test stubs may throw; swallow */ }
}

// Click handler: focus the FortiMonitor tab if one's open, otherwise
// open the Canned Reports page in a new tab. Exported for unit tests;
// the SW attaches it as a chrome.notifications.onClicked listener.
export async function handleNotificationClick(notificationId, deps = {}) {
  if (!String(notificationId || '').startsWith(NOTIFICATION_ID_PREFIX)) return { ok: false, reason: 'not-our-notification' };
  const tabsApi = deps.tabs || (typeof chrome !== 'undefined' ? chrome.tabs : null);
  const windowsApi = deps.windows || (typeof chrome !== 'undefined' ? chrome.windows : null);
  const notifApi = deps.notifications || (typeof chrome !== 'undefined' ? chrome.notifications : null);
  if (!tabsApi) return { ok: false, reason: 'no-tabs-api' };
  try {
    const tabs = await tabsApi.query({ url: 'https://fortimonitor.forticloud.com/*' });
    if (tabs.length > 0) {
      const tab = tabs[0];
      await tabsApi.update(tab.id, { active: true, url: 'https://fortimonitor.forticloud.com/report/ListReports#report-history' });
      if (tab.windowId != null && windowsApi) await windowsApi.update(tab.windowId, { focused: true });
      try { if (notifApi?.clear) await notifApi.clear(notificationId); } catch {}
      return { ok: true, focused: 'existing-tab', tabId: tab.id, windowId: tab.windowId };
    }
    await tabsApi.create({ url: 'https://fortimonitor.forticloud.com/report/ListReports#report-history' });
    try { if (notifApi?.clear) await notifApi.clear(notificationId); } catch {}
    return { ok: true, focused: 'new-tab' };
  } catch (err) {
    return { ok: false, reason: 'error', message: err?.message || String(err) };
  }
}

export function createReportNotificationHandlers(deps = {}) {
  const storage = deps.storage || chrome.storage?.local;
  return {
    'report-notifications:status': async () => {
      const enabled = Boolean((await storage.get(SETTINGS_KEY))?.[SETTINGS_KEY]);
      const detector = (await storage.get(STORAGE_KEY))?.[STORAGE_KEY] || null;
      return { ok: true, enabled, detector };
    },
    'report-notifications:test': async () => {
      // Synthetic completion: include a fake report row so the bell + the
      // popup card render their report-detail layout, not just a count.
      const notify = {
        delta: 1,
        baseline: 0,
        newTotal: 1,
        reports: [{
          reportTypeId: 0,
          reportTypeName: 'Test Notification',
          reportName: 'Test Notification (Simulated)',
          createdBy: '(toolkit test)',
          lastSent: new Date().toISOString(),
          downloadLink: null,
          historyId: null,
        }],
      };
      await fireNotification(notify, deps);
      const priorHistory = (await storage.get(HISTORY_STORAGE_KEY))?.[HISTORY_STORAGE_KEY] || [];
      await storage.set({ [HISTORY_STORAGE_KEY]: appendHistory(priorHistory, notify) });
      await bumpBadge(deps);
      return { ok: true };
    },
    'report-notifications:reset': async () => {
      await storage.set({ [STORAGE_KEY]: initialState() });
      return { ok: true };
    },
    // Recent-completions card surface.
    'report-notifications:history': async () => {
      const items = (await storage.get(HISTORY_STORAGE_KEY))?.[HISTORY_STORAGE_KEY] || [];
      return { ok: true, items };
    },
    'report-notifications:clear-history': async () => {
      await storage.set({ [HISTORY_STORAGE_KEY]: [] });
      return { ok: true };
    },
    // Popup calls this on open to clear the unread badge counter (keeps
    // history intact).
    'report-notifications:clear-badge': async () => {
      await clearBadge(deps);
      return { ok: true };
    },
    // Manually run one poll cycle (for Settings "check now" testing and
    // for the test suite). Returns whatever the poll observed.
    'report-notifications:poll-now': async () => {
      return pollOnce(deps);
    },
  };
}

// Wire chrome.alarms + the click handler onto the SW. Idempotent.
export function attachReportNotificationAlarms({ pollImpl } = {}) {
  const poll = pollImpl || pollOnce;
  if (!chrome.alarms) return { ok: false, reason: 'no-alarms' };

  async function ensureAlarmMatchesEnabled() {
    const enabled = Boolean(
      (await chrome.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY]
    );
    if (enabled) {
      const existing = await chrome.alarms.get(POLL_ALARM);
      if (!existing) {
        chrome.alarms.create(POLL_ALARM, {
          delayInMinutes: POLL_PERIOD_MIN,
          periodInMinutes: POLL_PERIOD_MIN,
        });
        // FMN-191: kick off a poll RIGHT NOW so the detector baseline is
        // set immediately. Otherwise the first poll waits up to 60s and
        // any reports finished in that window get absorbed into the
        // baseline. Swallow errors; the alarm will retry on its cadence.
        poll().catch(() => {});
      }
    } else {
      await chrome.alarms.clear(POLL_ALARM).catch(() => {});
    }
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== POLL_ALARM) return;
    poll().catch(() => { /* swallow; next tick retries */ });
  });
  // FMN-191 pivot: chrome.notifications is no longer the surface;
  // handleNotificationClick remains exported so the in-page bell + the
  // popup history card can call it for tab focus + navigation.

  // Re-sync the alarm whenever the toggle flips.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes[SETTINGS_KEY]) return;
    ensureAlarmMatchesEnabled().catch(() => {});
  });

  // SW wakeup: sync alarm with current setting.
  ensureAlarmMatchesEnabled().catch(() => {});
  return { ok: true };
}

// Test-only export.
export const __test__ = { pollOnce, fireNotification, POLL_ENDPOINT, SETTINGS_KEY };
