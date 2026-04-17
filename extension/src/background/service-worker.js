// FortiMonitor WAN Cleanup — service worker.
//
// Thin Chrome-API wrapper. All orchestration lives in modules that are
// testable in Node (scanner, executor, message-handlers, queue). This
// file wires those modules to chrome.runtime messages, chrome.action
// clicks, and chrome.runtime lifecycle events.

import { createProductionClient } from './fortimonitor-client.js';
import { Queue } from './queue.js';
import { createHandlers, dispatch } from './message-handlers.js';

const client = createProductionClient();
const queue = new Queue(); // uses chrome.storage.local by default

// Broadcast runtime events to any listening extension page.
function emit(name, payload) {
  chrome.runtime.sendMessage({ type: '__event__', event: name, payload }).catch(() => {
    // No listener — that's fine.
  });
}

const handlers = createHandlers({ client, queue, events: { emit } });

chrome.runtime.onInstalled.addListener(() => {
  console.log('[fm-wan-cleanup] installed — version', chrome.runtime.getManifest().version);
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/app.html') });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !message.type) {
    sendResponse({ ok: false, error: 'malformed message' });
    return false;
  }
  dispatch(handlers, message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: error?.message ?? String(error) })
  );
  return true; // keep the channel open for the async response
});
