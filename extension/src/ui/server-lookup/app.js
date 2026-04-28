// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Top-level UI controller for the Server Name → ID Lookup tool.
// 2-step flow: /start (paste names, fire lookup) → /results (table + CSV).

import * as start from './steps/start.js';
import * as results from './steps/results.js';
import { onEvent } from '../../lib/messaging.js';

document.documentElement.dataset.toolMode = 'server-lookup';

const store = {
  // From the Start step (FMN-113):
  entries: [],            // {kind:'url'|'id'|'name', raw, serverId?, name?}[]
  warnings: [],
  confirm: false,         // when true, URL/ID entries hit GET /server/{id} to verify

  // From the Execute/fan-out call:
  executeProgress: new Map(), // label -> { status, serverId, matchCount, error }
  runResult: null         // { results, startedAt, finishedAt }
};

const eventListeners = new Set();
onEvent((event, payload) => {
  for (const cb of eventListeners) {
    try { cb(event, payload); } catch (err) { console.error('[lookup-ui event listener]', err); }
  }
});
const events = {
  on(cb) {
    eventListeners.add(cb);
    return () => eventListeners.delete(cb);
  },
  emit(event, payload) {
    for (const cb of eventListeners) {
      try { cb(event, payload); } catch (err) { console.error('[lookup-ui synthetic emit]', err); }
    }
  }
};

const routes = {
  '/start': start,
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
    try { activeTeardown(); } catch (err) { console.error('[lookup-ui teardown]', err); }
    activeTeardown = null;
  }
  container.innerHTML = '';
  const teardown = mod.render({ container, store, navigate, events });
  if (typeof teardown === 'function') activeTeardown = teardown;
}

window.addEventListener('hashchange', render);
document.addEventListener('DOMContentLoaded', render);
