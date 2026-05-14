// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-191: tests for the SW-side report-notification handlers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReportNotificationHandlers,
  handleNotificationClick,
  __test__,
} from '../src/background/report-notification-handlers.js';
import {
  STORAGE_KEY,
  HISTORY_STORAGE_KEY,
  initialState,
} from '../src/lib/report-notification-detector.js';
import { createStorageMock } from './fixtures/chrome-mocks.js';

function jsonResp(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function htmlResp(body = '<html></html>') {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
}

function makeNotifSpy() {
  const calls = [];
  return {
    fn: (id, opts) => { calls.push({ id, opts }); return Promise.resolve(); },
    calls,
  };
}

// =====================================================================
// pollOnce via the :poll-now handler (the SW handler is the public API)
// =====================================================================

test('poll-now: first call sets baseline, fires no notification', async () => {
  const storage = createStorageMock();
  const notif = makeNotifSpy();
  const handlers = createReportNotificationHandlers({
    storage,
    fetch: async () => jsonResp({ data: [], recordsTotal: 33, draw: '1' }),
    createNotification: notif.fn,
  });
  const out = await handlers['report-notifications:poll-now']();
  assert.equal(out.ok, true);
  assert.equal(out.recordsTotal, 33);
  assert.equal(out.notify, null);
  assert.equal(notif.calls.length, 0);
  const stored = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
  assert.equal(stored.baseline, 33);
});

test('poll-now: count increase fires chrome.notifications.create + bumps baseline', async () => {
  const storage = createStorageMock();
  const notif = makeNotifSpy();
  let count = 33;
  const handlers = createReportNotificationHandlers({
    storage,
    fetch: async () => jsonResp({ data: [], recordsTotal: count, draw: '1' }),
    createNotification: notif.fn,
  });
  await handlers['report-notifications:poll-now']();
  count = 34;
  const out = await handlers['report-notifications:poll-now']();
  assert.equal(out.ok, true);
  assert.equal(out.notify.delta, 1);
  assert.equal(notif.calls.length, 1);
  assert.match(notif.calls[0].opts.title, /FortiMonitor report ready/i);
  assert.match(notif.calls[0].opts.message, /A canned report finished/i);
  const stored = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
  assert.equal(stored.baseline, 34);
  assert.equal(stored.notifiedCount, 1);
});

test('poll-now: count regression does not fire and does not lower baseline', async () => {
  const storage = createStorageMock();
  const notif = makeNotifSpy();
  let count = 33;
  const handlers = createReportNotificationHandlers({
    storage,
    fetch: async () => jsonResp({ data: [], recordsTotal: count, draw: '1' }),
    createNotification: notif.fn,
  });
  await handlers['report-notifications:poll-now']();
  count = 30;
  const out = await handlers['report-notifications:poll-now']();
  assert.equal(out.ok, true);
  assert.equal(notif.calls.length, 0);
  const stored = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
  assert.equal(stored.baseline, 33);
});

test('poll-now: session-lapsed HTML response is treated as transient', async () => {
  const storage = createStorageMock({
    [STORAGE_KEY]: { ...initialState(), baseline: 33 },
  });
  const notif = makeNotifSpy();
  const handlers = createReportNotificationHandlers({
    storage,
    fetch: async () => htmlResp(),
    createNotification: notif.fn,
  });
  const out = await handlers['report-notifications:poll-now']();
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'session-lapsed');
  assert.equal(notif.calls.length, 0);
  // baseline untouched.
  const stored = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
  assert.equal(stored.baseline, 33);
});

test('poll-now: network failure is reported, state unchanged', async () => {
  const storage = createStorageMock({
    [STORAGE_KEY]: { ...initialState(), baseline: 33 },
  });
  const handlers = createReportNotificationHandlers({
    storage,
    fetch: async () => { throw new Error('fetch failed: ECONNREFUSED'); },
    createNotification: () => Promise.resolve(),
  });
  const out = await handlers['report-notifications:poll-now']();
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'network');
  assert.match(out.message, /ECONNREFUSED/);
  const stored = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
  assert.equal(stored.baseline, 33);
});

test('poll-now: unexpected payload shape is reported, state unchanged', async () => {
  const storage = createStorageMock({
    [STORAGE_KEY]: { ...initialState(), baseline: 33 },
  });
  const handlers = createReportNotificationHandlers({
    storage,
    fetch: async () => jsonResp({ something: 'else' }),
    createNotification: () => Promise.resolve(),
  });
  const out = await handlers['report-notifications:poll-now']();
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'unexpected-shape');
});

// =====================================================================
// :status and :test and :reset
// =====================================================================

test('status: returns enabled flag + detector state', async () => {
  const storage = createStorageMock({
    'fm:reportNotificationsEnabled': true,
    [STORAGE_KEY]: { ...initialState(), baseline: 7 },
  });
  const handlers = createReportNotificationHandlers({ storage });
  const out = await handlers['report-notifications:status']();
  assert.equal(out.ok, true);
  assert.equal(out.enabled, true);
  assert.equal(out.detector.baseline, 7);
});

test('status: empty storage returns enabled=false, detector=null', async () => {
  const handlers = createReportNotificationHandlers({ storage: createStorageMock() });
  const out = await handlers['report-notifications:status']();
  assert.equal(out.enabled, false);
  assert.equal(out.detector, null);
});

test('test handler appends history + bumps badge (in-page bell side effects)', async () => {
  const storage = createStorageMock();
  const badgeCalls = [];
  const handlers = createReportNotificationHandlers({
    storage,
    setBadgeText: (opts) => { badgeCalls.push(opts.text); return Promise.resolve(); },
    setBadgeBackgroundColor: () => Promise.resolve(),
  });
  const out = await handlers['report-notifications:test']();
  assert.equal(out.ok, true);
  const history = (await storage.get(HISTORY_STORAGE_KEY))[HISTORY_STORAGE_KEY];
  assert.equal(history.length, 1);
  // Test handler now sends a synthetic report row so the bell renders
  // its report-detail layout; legacy delta-count entry is gone.
  assert.match(history[0].reportName, /Test Notification/i);
  assert.deepEqual(badgeCalls, ['1']);
});

test('reset: replaces stored detector with initialState', async () => {
  const storage = createStorageMock({
    [STORAGE_KEY]: { baseline: 9999, notifiedCount: 12, lastPollAt: 'x' },
  });
  const handlers = createReportNotificationHandlers({ storage });
  const out = await handlers['report-notifications:reset']();
  assert.equal(out.ok, true);
  const stored = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
  assert.equal(stored.baseline, null);
  assert.equal(stored.notifiedCount, 0);
});

// =====================================================================
// Task 9: history ring buffer + toolbar badge
// =====================================================================

test('poll-now with count increase: appends to history ring buffer', async () => {
  const storage = createStorageMock();
  let count = 33;
  const handlers = createReportNotificationHandlers({
    storage,
    fetch: async () => jsonResp({ data: [], recordsTotal: count, draw: '1' }),
    createNotification: () => Promise.resolve(),
    setBadgeText: () => Promise.resolve(),
    setBadgeBackgroundColor: () => Promise.resolve(),
  });
  await handlers['report-notifications:poll-now'](); // calibrate
  count = 34;
  await handlers['report-notifications:poll-now']();
  const history = (await storage.get(HISTORY_STORAGE_KEY))[HISTORY_STORAGE_KEY];
  assert.equal(history.length, 1);
  assert.equal(history[0].delta, 1);
  assert.equal(history[0].baseline, 33);
  assert.equal(history[0].newTotal, 34);
});

test('poll-now with count increase: bumps badge to 1, then 2', async () => {
  const storage = createStorageMock();
  const badgeCalls = [];
  let count = 33;
  const handlers = createReportNotificationHandlers({
    storage,
    fetch: async () => jsonResp({ data: [], recordsTotal: count, draw: '1' }),
    createNotification: () => Promise.resolve(),
    setBadgeText: (opts) => { badgeCalls.push(opts.text); return Promise.resolve(); },
    setBadgeBackgroundColor: () => Promise.resolve(),
  });
  await handlers['report-notifications:poll-now'](); // calibrate (no badge call expected)
  count = 34;
  await handlers['report-notifications:poll-now']();
  count = 36;
  await handlers['report-notifications:poll-now']();
  assert.deepEqual(badgeCalls, ['1', '2']);
});

test('history handler: returns the stored items', async () => {
  const storage = createStorageMock({
    [HISTORY_STORAGE_KEY]: [
      { id: 'a', delta: 1, baseline: 33, newTotal: 34, takenAt: 'T1' },
      { id: 'b', delta: 2, baseline: 34, newTotal: 36, takenAt: 'T2' },
    ],
  });
  const handlers = createReportNotificationHandlers({ storage });
  const out = await handlers['report-notifications:history']();
  assert.equal(out.ok, true);
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].id, 'a');
});

test('clear-history: empties the buffer; badge is unaffected', async () => {
  const storage = createStorageMock({
    [HISTORY_STORAGE_KEY]: [{ id: 'x', delta: 1, baseline: 0, newTotal: 1 }],
    'fm:reportNotificationBadge': 3,
  });
  const handlers = createReportNotificationHandlers({
    storage,
    setBadgeText: () => Promise.resolve(),
  });
  await handlers['report-notifications:clear-history']();
  const items = (await storage.get(HISTORY_STORAGE_KEY))[HISTORY_STORAGE_KEY];
  assert.deepEqual(items, []);
  const badge = (await storage.get('fm:reportNotificationBadge'))['fm:reportNotificationBadge'];
  assert.equal(badge, 3);
});

// =====================================================================
// Task 10: handleNotificationClick (focus or open FortiMonitor tab)
// =====================================================================

function makeTabsMock({ queryReturns = [], updateCalls, createCalls } = {}) {
  return {
    query: async (criteria) => { return queryReturns; },
    update: async (tabId, opts) => { if (updateCalls) updateCalls.push({ tabId, opts }); },
    create: async (opts) => { if (createCalls) createCalls.push(opts); return { id: 999 }; },
  };
}

test('click handler ignores notification ids that are not ours', async () => {
  const out = await handleNotificationClick('some-other-id', {
    tabs: makeTabsMock(),
    windows: { update: async () => {} },
    notifications: { clear: async () => {} },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'not-our-notification');
});

test('click handler with existing FortiMonitor tab: focuses + navigates to ListReports', async () => {
  const updateCalls = [];
  const windowCalls = [];
  const cleared = [];
  const out = await handleNotificationClick('fm-report-ready-123', {
    tabs: makeTabsMock({
      queryReturns: [{ id: 42, windowId: 7, url: 'https://fortimonitor.forticloud.com/dashboardv2/x' }],
      updateCalls,
    }),
    windows: { update: async (id, opts) => { windowCalls.push({ id, opts }); } },
    notifications: { clear: async (id) => { cleared.push(id); } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.focused, 'existing-tab');
  assert.equal(out.tabId, 42);
  assert.equal(out.windowId, 7);
  assert.deepEqual(updateCalls, [{ tabId: 42, opts: { active: true, url: 'https://fortimonitor.forticloud.com/report/ListReports#report-history' } }]);
  assert.deepEqual(windowCalls, [{ id: 7, opts: { focused: true } }]);
  assert.deepEqual(cleared, ['fm-report-ready-123']);
});

test('click handler with no FortiMonitor tab: opens a new tab', async () => {
  const createCalls = [];
  const out = await handleNotificationClick('fm-report-ready-999', {
    tabs: makeTabsMock({ queryReturns: [], createCalls }),
    windows: { update: async () => {} },
    notifications: { clear: async () => {} },
  });
  assert.equal(out.ok, true);
  assert.equal(out.focused, 'new-tab');
  assert.deepEqual(createCalls, [{ url: 'https://fortimonitor.forticloud.com/report/ListReports#report-history' }]);
});

test('click handler error from tabs.query is surfaced, not thrown', async () => {
  const out = await handleNotificationClick('fm-report-ready-444', {
    tabs: { query: async () => { throw new Error('boom'); }, update: async () => {}, create: async () => ({}) },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'error');
  assert.match(out.message, /boom/);
});

test('clear-badge: zeros the badge; history is unaffected', async () => {
  const storage = createStorageMock({
    [HISTORY_STORAGE_KEY]: [{ id: 'x', delta: 1, baseline: 0, newTotal: 1 }],
    'fm:reportNotificationBadge': 5,
  });
  const badgeCalls = [];
  const handlers = createReportNotificationHandlers({
    storage,
    setBadgeText: (opts) => { badgeCalls.push(opts.text); return Promise.resolve(); },
  });
  await handlers['report-notifications:clear-badge']();
  const badge = (await storage.get('fm:reportNotificationBadge'))['fm:reportNotificationBadge'];
  assert.equal(badge, 0);
  // setBadgeText called with empty string to remove the badge visually.
  assert.deepEqual(badgeCalls, ['']);
  const items = (await storage.get(HISTORY_STORAGE_KEY))[HISTORY_STORAGE_KEY];
  assert.equal(items.length, 1);
});
