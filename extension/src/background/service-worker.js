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
import { createSdwanReportHandlers } from './sdwan-report-handlers.js';
import { createBpaAuditHandlers } from './bpa-audit-handlers.js';
import { createBpaSnapshotHandlers } from './bpa-snapshot-handlers.js';
import { createClaudeChatHandlers } from './claude-chat-handlers.js';
import { createOmniSearchHandlers } from './omni-search-handlers.js';
import { createBulkComposerHandlers } from './bulk-composer-handlers.js';
import { attachIntroTourStartHandler } from './intro-tour-dispatch.js';
import { resolveFortimonitorOrigin } from '../lib/origin-resolver.js';
import { applyAllProviderRules, WATCHED_STORAGE_KEYS } from '../lib/origin-rewrite.js';
import { checkForUpdate } from './update-check.js';

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
  ...createSdwanReportHandlers({ events: { emit } }),
  ...createBpaAuditHandlers({ events: { emit }, resolveOrigin }),
  ...createBpaSnapshotHandlers({ events: { emit }, resolveOrigin }),
  ...createClaudeChatHandlers({ events: { emit } }),
  ...createOmniSearchHandlers({ events: { emit } }),
  ...createBulkComposerHandlers({ events: { emit } })
};

// FMN-152 dev aid: expose handler keys on globalThis so a Playwright
// sw.evaluate() probe can verify each handler module wired in.
globalThis.__fmDebugHandlerKeys = Object.keys(handlers).sort();

// FMN-167: register the intro-tour start-message fan-out listener on top
// of the regular dispatch path. The message uses chrome.tabs.sendMessage
// to reach content scripts; the regular dispatch() answers extension-
// context messages and doesn't fan out to tabs. This listener returns
// true to keep the response channel open for the async tab work.
attachIntroTourStartHandler();

chrome.runtime.onInstalled.addListener(() => {
  const m = chrome.runtime.getManifest();
  console.log(`[fm-toolkit] installed - ${m.name} v${m.version}`);
  console.log(`[fm-toolkit] built by ${BUILT_BY}`);
  // FMN-120: re-apply Origin-rewrite rules so a fresh install / update
  // picks up any saved local-provider URLs immediately.
  applyAllProviderRules();
});

// Service worker wakeups (and reloads) - re-apply Origin rules so they
// match the current saved URLs even if storage changed while the
// worker was inactive.
applyAllProviderRules();

// FMN-157: in-extension update check. On service-worker wakeup, run
// checkForUpdate(); the function's own rate limiter bails if a
// successful check happened within the last hour, so repeated SW
// wakeups don't hammer GitHub. We also set a 12h chrome.alarms alarm
// as a backstop so installations that rarely wake the SW still get a
// daily-ish check. Errors are swallowed inside checkForUpdate.
checkForUpdate().catch(() => { /* silent */ });

const UPDATE_CHECK_ALARM = 'fm:updateCheckAlarm';
try {
  chrome.alarms?.create?.(UPDATE_CHECK_ALARM, {
    // First fire 12h from now; periodic every 12h after. The function's
    // hour rate limit is the real gate; the alarm just guarantees the
    // check runs even on long-idle profiles.
    delayInMinutes: 12 * 60,
    periodInMinutes: 12 * 60
  });
  chrome.alarms?.onAlarm?.addListener?.((alarm) => {
    if (alarm?.name === UPDATE_CHECK_ALARM) {
      checkForUpdate().catch(() => { /* silent */ });
    }
  });
} catch { /* alarms permission missing or API unavailable; ignored */ }

// Keep DNR rules in sync with Settings edits.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of WATCHED_STORAGE_KEYS) {
    if (changes[key]) {
      applyAllProviderRules();
      return;
    }
  }
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
  // FMN-157 / FMN-165: popup-triggered update check.
  //
  // The popup fires this on open (force=false) - checkForUpdate's hour
  // rate limit handles "don't actually refetch every popup open"
  // gracefully and the popup re-reads storage to render the banner.
  //
  // The popup also fires this from the Settings "Check for updates
  // now" button (force=true; FMN-165). That path bypasses the hour
  // rate-limit and the popup needs the resolved result to render the
  // success / failure UI synchronously, so we await checkForUpdate
  // and report the outcome over sendResponse.
  if (message.type === 'fm:update-check:run') {
    const force = Boolean(message?.payload?.force);
    checkForUpdate({ force }).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error?.message ?? String(error) })
    );
    return true; // keep the channel open for the async response
  }
  dispatch(handlers, message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: error?.message ?? String(error) })
  );
  return true; // keep the channel open for the async response
});
