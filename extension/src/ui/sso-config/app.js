// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Top-level UI controller for the SSO Configuration tool (FMN-139).
// Mirrors fabric-connection's 4-step pattern (hash router, in-memory store).
// Step 3 (Execute) currently runs dry-run only; the FortiMonitor-side save
// is stubbed pending Discovery (FMN-138).

import * as start from './steps/start.js';
import * as review from './steps/review.js';
import * as execute from './steps/execute.js';
import * as results from './steps/results.js';
import { onEvent } from '../../lib/messaging.js';

document.documentElement.dataset.toolMode = 'sso-config';

const store = {
  // Step 1 (Start) inputs:
  spEntityId: '',          // FortiMonitor SP entity ID
  acsUrl: '',              // Assertion Consumer Service URL
  testLoginUrl: '',        // Optional: login URL for the runbook test step
  tenantLabel: '',         // Optional: human label for the tenant
  idpMetadataXml: '',      // Pasted Okta IdP metadata XML
  idpParsed: null,         // { issuer, ssoUrlPost, ssoUrlRedirect, x509Cert, nameIdFormats }
  idpParseError: null,     // String error from parseIdpMetadata, if any

  attributes: {            // SAML attribute statement names
    email: 'email',
    firstName: 'firstName',
    lastName: 'lastName',
    groups: 'groups'
  },

  roleMapping: {
    defaultRole: 'Read-Only',
    overrides: []          // [{ group, role }]
  },

  ssoMode: 'sso-with-password-fallback', // 'sso-only' | 'sso-with-password-fallback'
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',

  // Step 2 (Review):
  dryRun: true,

  // Step 3 (Execute) outputs:
  runResult: null          // { ok, dryRun, message, runbookMd, spMetadataXml }
};

const eventListeners = new Set();
onEvent((event, payload) => {
  for (const cb of eventListeners) {
    try { cb(event, payload); } catch (err) { console.error('[sso-ui event listener]', err); }
  }
});
const events = {
  on(cb) {
    eventListeners.add(cb);
    return () => eventListeners.delete(cb);
  },
  emit(event, payload) {
    for (const cb of eventListeners) {
      try { cb(event, payload); } catch (err) { console.error('[sso-ui synthetic emit]', err); }
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
  if (route === '/review') {
    return !!store.spEntityId
      && !!store.acsUrl
      && !!store.idpParsed;
  }
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
    try { activeTeardown(); } catch (err) { console.error('[sso-ui teardown]', err); }
    activeTeardown = null;
  }
  container.innerHTML = '';
  const teardown = mod.render({ container, store, navigate, events });
  if (typeof teardown === 'function') activeTeardown = teardown;
}

window.addEventListener('hashchange', render);
document.addEventListener('DOMContentLoaded', render);
