// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// BPA Audit - top-level UI controller (FMN-133).
// 4-step flow: /start (configure) -> /collect (crawl) -> /analyze (run analyzers) -> /review (11-tab viewer + CSV).

import * as start from './steps/start.js';
import * as collect from './steps/collect.js';
import * as analyze from './steps/analyze.js';
import * as review from './steps/review.js';
import { onEvent } from '../../lib/messaging.js';

document.documentElement.dataset.toolMode = 'bpa-audit';

const store = {
  // Step 1
  customerName: '',
  deep: false,
  maxServers: 0,

  // Steps 2-3 - filled as the run progresses
  runResult: null,       // { inventory, analysis, started_at, finished_at, deep, max_servers }
  runError: null,        // null | string
  runCancelled: false
};

const eventListeners = new Set();
onEvent((event, payload) => {
  for (const cb of eventListeners) {
    try { cb(event, payload); } catch (err) { console.error('[bpa-audit event listener]', err); }
  }
});
const events = {
  on(cb) {
    eventListeners.add(cb);
    return () => eventListeners.delete(cb);
  },
  emit(event, payload) {
    for (const cb of eventListeners) {
      try { cb(event, payload); } catch (err) { console.error('[bpa-audit synthetic emit]', err); }
    }
  }
};

const routes = {
  '/start': start,
  '/collect': collect,
  '/analyze': analyze,
  '/review': review
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
  if (route === '/collect') return true;
  if (route === '/analyze') return Boolean(store.runResult);
  if (route === '/review') return Boolean(store.runResult?.analysis);
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
    try { activeTeardown(); } catch (err) { console.error('[bpa-audit teardown]', err); }
    activeTeardown = null;
  }
  container.innerHTML = '';
  const teardown = mod.render({ container, store, navigate, events });
  if (typeof teardown === 'function') activeTeardown = teardown;
}

window.addEventListener('hashchange', render);
document.addEventListener('DOMContentLoaded', render);
