// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155: Bulk Action Composer - top-level UI controller.
//
// Four-step wizard:
//   /pick     pick a subset of instances (omni-search corpus + chips +
//             optional clipboard CSV / current-page-selection loaders)
//   /action   pick an action card (Add Tag / Remove Tag / Apply Template)
//   /configure  action-specific form
//   /commit   preview prev->next table + commit with concurrency 3
//
// State is held in an in-memory `store`. The flag gate is enforced
// here on mount: if the bulk-composer flag is off, render a stub that
// tells the operator to enable in Settings.

import * as pick from './steps/pick.js';
import * as action from './steps/action.js';
import * as configure from './steps/configure.js';
import * as commit from './steps/commit.js';
import { onEvent, call } from '../../lib/messaging.js';
import { getAction } from '../../lib/bulk-actions/index.js';

document.documentElement.dataset.toolMode = 'bulk-composer';

export const store = {
  // Step 1 (pick): selected target entries from the omni-search corpus.
  // Shape per target mirrors omni-search-handlers' buildServerEntry()
  // result, with `id` + `name` + optional `tags` + `template_names`.
  targets: [],

  // Step 2 (action): id of the chosen action ('add-tag', 'remove-tag',
  // 'apply-template').
  actionId: null,

  // Step 3 (configure): action-specific params (e.g. { tag } or
  // { templateUrl, templateId, templateName, continuous }).
  params: {},

  // Step 4 (commit): cached run result for display + CSV export.
  runResult: null
};

const eventListeners = new Set();
onEvent((event, payload) => {
  for (const cb of eventListeners) {
    try { cb(event, payload); } catch (err) { console.error('[bulk-composer event listener]', err); }
  }
});
export const events = {
  on(cb) {
    eventListeners.add(cb);
    return () => eventListeners.delete(cb);
  }
};

const routes = {
  '/pick': pick,
  '/action': action,
  '/configure': configure,
  '/commit': commit
};

function currentHash() {
  const hash = window.location.hash || '#/pick';
  return hash.startsWith('#') ? hash.slice(1) : hash;
}

export function navigate(to) {
  if (!to.startsWith('/')) to = '/' + to;
  window.location.hash = '#' + to;
}

function canEnter(route) {
  if (route === '/pick') return true;
  if (route === '/action') return store.targets.length > 0;
  if (route === '/configure') return store.targets.length > 0 && !!store.actionId;
  if (route === '/commit') {
    // delete-instance collects its only param (the confirm phrase) ON the
    // commit/preview step itself, so it is "configured" for entry with just
    // targets + action chosen. The phrase gates Apply (UI), commit(), and the
    // service worker - not navigation. Without this exemption validate()
    // (which requires the phrase) bounces the operator back to /pick: the
    // route_guard_tracks_store_shape trap, here inverted (the param is
    // collected on the destination step, not before it).
    if (store.actionId === 'delete-instance') return store.targets.length > 0;
    return store.targets.length > 0 && !!store.actionId && hasRequiredParams();
  }
  return false;
}

function hasRequiredParams() {
  if (!store.actionId) return false;
  // FMN-200: route through the action's own validate() so the guard
  // automatically tracks any new action without per-action branches
  // here. Memory rule route_guard_tracks_store_shape: this exact bug
  // (add a new action, forget to update canEnter, get silent /pick
  // bounces) is what this delegation prevents.
  try {
    const a = getAction(store.actionId);
    if (a && typeof a.validate === 'function') {
      const v = a.validate(store.params || {});
      if (v && typeof v.ok === 'boolean') return v.ok === true;
    }
  } catch { /* fall through */ }
  // Back-compat for add-tag / remove-tag / apply-template - their
  // validate() returns the same boolean shape so this branch is a
  // belt-and-suspenders fallback.
  if (store.actionId === 'add-tag' || store.actionId === 'remove-tag') {
    return typeof store.params?.tag === 'string' && store.params.tag.trim().length > 0;
  }
  if (store.actionId === 'apply-template') {
    return typeof store.params?.templateUrl === 'string' && store.params.templateUrl.trim().length > 0;
  }
  return false;
}

let activeTeardown = null;
function render() {
  const container = document.getElementById('app-root');
  if (activeTeardown) {
    try { activeTeardown(); } catch (err) { console.error('[bulk-composer teardown]', err); }
    activeTeardown = null;
  }
  container.innerHTML = '';
  const route = currentHash();
  const mod = routes[route];
  if (!mod || !canEnter(route)) {
    if (route !== '/pick') {
      navigate('/pick');
      return;
    }
    mountRoute('/pick', pick, container);
    return;
  }
  mountRoute(route, mod, container);
}

function mountRoute(route, mod, container) {
  const teardown = mod.render({ container, store, navigate, events, call });
  if (typeof teardown === 'function') activeTeardown = teardown;
}

window.addEventListener('hashchange', render);
document.addEventListener('DOMContentLoaded', render);
