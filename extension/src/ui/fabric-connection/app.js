// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Top-level UI controller for the Add Fabric Connection (Bulk) tool.
// Mirrors src/ui/app.js's pattern (hash router, in-memory store,
// fan-out event subscription) but with a simpler 4-step flow.

import * as start from './steps/start.js';
import * as review from './steps/review.js';
import * as execute from './steps/execute.js';
import * as results from './steps/results.js';
import { onEvent } from '../../lib/messaging.js';

document.documentElement.dataset.toolMode = 'fabric-connection';

const store = {
  // From the Start step:
  devices: [],            // [{serial, ip, port}]
  warnings: [],
  onsightUrl: null,
  serverGroupUrl: null,
  applianceGroupUrl: null,
  discoverFrequency: 60,

  // Lookup tables to render names instead of URLs in later steps:
  onsightOptions: [],     // [{id, name, resourceUrl}]
  serverGroupOptions: [],
  onsightGroupOptions: [],

  // From the Review step:
  dryRun: true,
  confirmationPhrase: null,

  // From the Execute step:
  executeProgress: new Map(), // serial -> { status, attempts, error, resourceId }
  runResult: null         // { results, startedAt, finishedAt }
};

const eventListeners = new Set();
onEvent((event, payload) => {
  for (const cb of eventListeners) {
    try { cb(event, payload); } catch (err) { console.error('[fc-ui event listener]', err); }
  }
});
const events = {
  on(cb) {
    eventListeners.add(cb);
    return () => eventListeners.delete(cb);
  },
  emit(event, payload) {
    for (const cb of eventListeners) {
      try { cb(event, payload); } catch (err) { console.error('[fc-ui synthetic emit]', err); }
    }
  }
};

const routes = {
  '/start': start,
  '/review': review,
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
  if (route === '/review') return store.devices.length > 0
    && !!store.onsightUrl
    && !!store.serverGroupUrl;
  if (route === '/execute') return canEnter('/review');
  if (route === '/results') return !!store.runResult;
  return false;
}

let activeTeardown = null;
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

function mountRoute(route, mod) {
  const container = document.getElementById('app-root');
  if (activeTeardown) {
    try { activeTeardown(); } catch (err) { console.error('[fc-ui teardown]', err); }
    activeTeardown = null;
  }
  container.innerHTML = '';
  const teardown = mod.render({ container, store, navigate, events });
  if (typeof teardown === 'function') activeTeardown = teardown;
}

window.addEventListener('hashchange', render);
document.addEventListener('DOMContentLoaded', render);
