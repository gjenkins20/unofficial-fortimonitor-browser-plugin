// FortiMonitor WAN Cleanup — service worker (Phase 1 stub)
//
// Phase 1: minimal install handler and action-click handler that opens
// the app in a new tab. Batch orchestration, retries, and message routing
// are added in Phase 3.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[fm-wan-cleanup] installed — version', chrome.runtime.getManifest().version);
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/app.html') });
});
