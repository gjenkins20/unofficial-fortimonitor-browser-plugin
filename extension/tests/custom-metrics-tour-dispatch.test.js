// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-244: tests for the SW fan-out of fm:custom-metrics-tour:start.
// Sibling of intro-tour-dispatch.test.js; covers the existing-tab and
// no-tab branches and the message-listener integration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchCustomMetricsTourStart,
  attachCustomMetricsTourStartHandler,
} from '../src/background/custom-metrics-tour-dispatch.js';

function makeTabsApi({
  existing = [],
  createdTab = { id: 9999 },
  autoComplete = true,
} = {}) {
  const sent = [];
  const created = [];
  const listeners = new Set();
  return {
    sent, created, listeners,
    async query() { return existing.slice(); },
    async sendMessage(tabId, msg) { sent.push({ tabId, msg }); },
    async create(opts) {
      created.push(opts);
      if (autoComplete) {
        setTimeout(() => {
          for (const fn of listeners) fn(createdTab.id, { status: 'complete' });
        }, 0);
      }
      return createdTab;
    },
    onUpdated: {
      addListener(fn) { listeners.add(fn); },
      removeListener(fn) { listeners.delete(fn); },
    },
  };
}

test('dispatch: with one existing FM tab, sends one message to that tab', async () => {
  const tabsApi = makeTabsApi({ existing: [{ id: 42 }] });
  const result = await dispatchCustomMetricsTourStart({ tabsApi });
  assert.equal(result.delivered, 1);
  assert.equal(result.openedTab, null);
  assert.equal(tabsApi.sent.length, 1);
  assert.deepEqual(tabsApi.sent[0].msg, { type: 'fm:custom-metrics-tour:start' });
});

test('dispatch: with multiple FM tabs, fans out one message per tab', async () => {
  const tabsApi = makeTabsApi({ existing: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  const result = await dispatchCustomMetricsTourStart({ tabsApi });
  assert.equal(result.delivered, 3);
  assert.equal(result.openedTab, null);
  assert.equal(tabsApi.sent.length, 3);
  assert.deepEqual(tabsApi.sent.map((s) => s.tabId).sort(), [1, 2, 3]);
});

test('dispatch: with no existing FM tab, opens one and dispatches once it loads', async () => {
  const tabsApi = makeTabsApi({ existing: [], createdTab: { id: 555 } });
  const result = await dispatchCustomMetricsTourStart({ tabsApi });
  assert.equal(result.delivered, 1);
  assert.equal(result.openedTab, 555);
  assert.equal(tabsApi.created.length, 1);
  assert.ok(tabsApi.created[0].url.includes('fortimonitor'));
  assert.equal(tabsApi.sent.length, 1);
  assert.equal(tabsApi.sent[0].tabId, 555);
});

test('handler: intercepts only fm:custom-metrics-tour:start and answers async', async () => {
  const tabsApi = makeTabsApi({ existing: [{ id: 7 }] });
  const listeners = [];
  const runtimeApi = {
    onMessage: {
      addListener(fn) { listeners.push(fn); },
      removeListener(fn) {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      }
    }
  };
  attachCustomMetricsTourStartHandler({ runtimeApi, tabsApi });
  assert.equal(listeners.length, 1);
  const listener = listeners[0];

  // Wrong message type: handler returns false / no response.
  const result1 = listener({ type: 'something-else' }, {}, () => {});
  assert.equal(result1, false);

  // Right message type: handler returns true and resolves the callback.
  const responses = [];
  const result2 = listener(
    { type: 'fm:custom-metrics-tour:start' },
    {},
    (r) => responses.push(r)
  );
  assert.equal(result2, true);
  // Give the async dispatch a tick to resolve.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].delivered, 1);
});

test('handler: detach removes the listener', () => {
  const listeners = [];
  const runtimeApi = {
    onMessage: {
      addListener(fn) { listeners.push(fn); },
      removeListener(fn) {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      }
    }
  };
  const detach = attachCustomMetricsTourStartHandler({ runtimeApi, tabsApi: makeTabsApi() });
  assert.equal(listeners.length, 1);
  detach();
  assert.equal(listeners.length, 0);
});
