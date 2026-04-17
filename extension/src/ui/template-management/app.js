// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Top-level UI controller for the Manage Server Templates (Bulk) tool.
// Mirrors src/ui/attribute-management/app.js — hash router, in-memory
// store, fan-out event subscription.

import * as start from './steps/start.js';
import * as preview from './steps/preview.js';
import * as execute from './steps/execute.js';
import * as results from './steps/results.js';
import { onEvent } from '../../lib/messaging.js';

document.documentElement.dataset.toolMode = 'template-management';

const store = {
  // From Start:
  operation: 'attach',     // 'attach' | 'detach'
  templateUrl: null,       // URL of the chosen server_template
  templateId: null,        // numeric id parsed from the URL
  templateName: null,
  continuous: true,        // attach only
  strategy: 'dissociate',  // detach only: 'dissociate' | 'delete'
  entries: [],             // raw pasted lines (names or numeric ids)
  templates: [],           // cached dropdown data

  // From Preview:
  plan: null,              // Array of per-target rows

  // From Execute:
  runResult: null          // { results, startedAt, finishedAt }
};

const eventListeners = new Set();
onEvent((event, payload) => {
  for (const cb of eventListeners) {
    try { cb(event, payload); } catch (err) { console.error('[tmpl-ui event listener]', err); }
  }
});
const events = {
  on(cb) {
    eventListeners.add(cb);
    return () => eventListeners.delete(cb);
  }
};

const routes = {
  '/start': start,
  '/preview': preview,
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
  if (route === '/preview') return !!store.templateUrl && store.entries.length > 0;
  if (route === '/execute') return Array.isArray(store.plan) && store.plan.length > 0;
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
    try { activeTeardown(); } catch (err) { console.error('[tmpl-ui teardown]', err); }
    activeTeardown = null;
  }
  container.innerHTML = '';
  const teardown = mod.render({ container, store, navigate, events });
  if (typeof teardown === 'function') activeTeardown = teardown;
}

window.addEventListener('hashchange', render);
document.addEventListener('DOMContentLoaded', render);
