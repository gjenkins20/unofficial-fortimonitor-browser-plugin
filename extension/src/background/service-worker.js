// Unofficial FortiMonitor Toolkit - service worker.
// Built by Gregori Jenkins - https://www.linkedin.com/in/gregorijenkins
//
// Thin Chrome-API wrapper. All orchestration lives in modules that are
// testable in Node (scanner, executor, message-handlers, queue). This
// file wires those modules to chrome.runtime messages and the runtime
// lifecycle. The toolbar action uses a default_popup (see manifest), so
// chrome.action.onClicked never fires.

const BUILT_BY = 'Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>';

import { createProductionClient } from '../lib/fortimonitor-client.js';
import { Queue } from '../lib/queue.js';
import { createHandlers, dispatch } from './message-handlers.js';
import { createFabricHandlers } from './fabric-connection-handlers.js';
import { createAttributeHandlers } from './attribute-handlers.js';
import { createTemplateHandlers } from './template-handlers.js';
import { createServerLookupHandlers } from './server-lookup-handlers.js';
import { createServerSearchHandlers } from './server-search-handlers.js';
import { createClaudeChatHandlers } from './claude-chat-handlers.js';
import { resolveFortimonitorOrigin } from '../lib/origin-resolver.js';

const resolveOrigin = () => resolveFortimonitorOrigin({
  queryTabs: (q) => chrome.tabs.query(q),
  storage: chrome.storage.local
});
const client = createProductionClient({ origin: resolveOrigin });
const queue = new Queue(); // uses chrome.storage.local by default

// Broadcast runtime events to any listening extension page.
function emit(name, payload) {
  chrome.runtime.sendMessage({ type: '__event__', event: name, payload }).catch(() => {
    // No listener - that's fine.
  });
}

const handlers = {
  ...createHandlers({ client, queue, events: { emit } }),
  ...createFabricHandlers({ events: { emit } }),
  ...createAttributeHandlers({ events: { emit } }),
  ...createTemplateHandlers({ events: { emit } }),
  ...createServerLookupHandlers({ events: { emit } }),
  ...createServerSearchHandlers({ events: { emit } }),
  ...createClaudeChatHandlers({ events: { emit } })
};

chrome.runtime.onInstalled.addListener(() => {
  const m = chrome.runtime.getManifest();
  console.log(`[fm-toolkit] installed - ${m.name} v${m.version}`);
  console.log(`[fm-toolkit] built by ${BUILT_BY}`);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !message.type) {
    sendResponse({ ok: false, error: 'malformed message' });
    return false;
  }
  // FMN-85: dev-reload bridge endpoint. The content-script-side bridge in
  // augment.js can't call chrome.runtime.reload() directly (privileged API),
  // so it asks us to do it. We acknowledge synchronously and then trigger
  // the reload, which tears down this service worker and re-loads all
  // extension code on next activation.
  if (message.type === 'fm:dev-reload-extension') {
    sendResponse({ ok: true });
    console.log('[fm-toolkit] dev-reload requested via bridge');
    chrome.runtime.reload();
    return false;
  }
  dispatch(handlers, message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: error?.message ?? String(error) })
  );
  return true; // keep the channel open for the async response
});
