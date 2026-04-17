// Top-level UI controller. Owns the hash-based router, the shared state
// store, and the event subscription to the service worker. Each step is
// a module that exports render({ container, store, navigate, events }).

import * as start from './steps/start.js';
import * as review from './steps/review.js';
import * as queue from './steps/queue.js';
import * as execute from './steps/execute.js';
import * as results from './steps/results.js';
import { onEvent } from '../lib/messaging.js';

// -------- Session state store --------
// Held in memory for the lifetime of the tab. The durable queue lives in
// chrome.storage.local via the service worker's Queue; this object just
// carries transient wizard state between steps.
const store = {
  batchId: null,
  serverIds: [],
  nameById: {},
  inputWarnings: [],
  scanResult: null,        // { groups: [...], errored: [...] }
  reviewIndex: 0,
  decisions: new Map(),    // fingerprint -> { skipped, removePortNames }
  queueEntries: [],        // planned entries (not yet persisted)
  executeConfig: { dryRun: true, verbose: false },
  executePlan: null,       // { totalDevices, totalPortsToRemove, entries, startedAt }
  executeProgress: new Map(), // entryId -> { status, attempts, durationMs, error }
  runResult: null          // { results, startedAt, finishedAt, dryRun }
};

// -------- Event fan-out --------
// Multiple steps may want to subscribe to service-worker events. Rather
// than fighting over chrome.runtime.onMessage, we centralize it and fan
// out locally.
const eventListeners = new Set();
onEvent((event, payload) => {
  for (const cb of eventListeners) {
    try { cb(event, payload); } catch (err) { console.error('[ui event listener]', err); }
  }
});
const events = {
  on(cb) {
    eventListeners.add(cb);
    return () => eventListeners.delete(cb);
  },
  emit(event, payload) {
    // Synthetic emit used by dry-run simulation to reuse the same UI
    // wiring without the service worker round-trip.
    for (const cb of eventListeners) {
      try { cb(event, payload); } catch (err) { console.error('[ui synthetic emit]', err); }
    }
  }
};

// -------- Router --------
const routes = {
  '/start': start,
  '/review': review,
  '/queue': queue,
  '/execute': execute,
  '/results': results
};

function currentHash() {
  const h = window.location.hash || '#/start';
  return h.startsWith('#') ? h.slice(1) : h;
}

function navigate(to) {
  if (!to.startsWith('/')) to = '/' + to;
  window.location.hash = '#' + to;
}

function canEnter(route) {
  if (route === '/start') return true;
  if (route === '/review') return !!store.scanResult;
  if (route === '/queue') return store.queueEntries.length > 0;
  if (route === '/execute') return !!store.executePlan;
  if (route === '/results') return !!store.runResult;
  return false;
}

function render() {
  const route = currentHash();
  const mod = routes[route];
  if (!mod || !canEnter(route)) {
    if (route !== '/start') navigate('/start');
    else mountRoute('/start', start);
    return;
  }
  mountRoute(route, mod);
}

let activeTeardown = null;
function mountRoute(route, mod) {
  const container = document.getElementById('app-root');
  if (activeTeardown) {
    try { activeTeardown(); } catch (err) { console.error('[teardown]', err); }
    activeTeardown = null;
  }
  container.innerHTML = '';
  const teardown = mod.render({ container, store, navigate, events });
  if (typeof teardown === 'function') activeTeardown = teardown;
}

window.addEventListener('hashchange', render);
document.addEventListener('DOMContentLoaded', render);
