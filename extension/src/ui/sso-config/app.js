// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Top-level UI controller for the SSO Configuration tool (FMN-139).
// Mirrors fabric-connection's 4-step pattern (hash router, in-memory store).
// Pure generator: no FortiMonitor session-auth, no v2 API. The tool emits a
// paste-ready runbook that walks the operator through configuring Okta and
// FortiMonitor from both sides; the operator does the actual saves.

import * as start from './steps/start.js';
import * as review from './steps/review.js';
import * as execute from './steps/execute.js';
import * as results from './steps/results.js';
import { onEvent } from '../../lib/messaging.js';

document.documentElement.dataset.toolMode = 'sso-config';

const store = {
  // FortiMonitor SSO admin form (Teams & Activity -> Integrations -> Edit
  // SSO Configuration). Field names mirror the FortiMonitor labels exactly.
  fortimonitorBaseUrl: '',     // e.g. https://my.us01.fortimonitor.com (region-specific)
  urlFragment: '',             // e.g. "okta" -> /sso/okta login URL
  domains: [],                 // e.g. ['@company.com']
  usernameField: 'email',      // SAML attribute matched to the user's FortiMonitor login email
  loginBinding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
  logoutUrl: '',               // optional
  logoutBinding: '',           // optional

  // User Configuration block of FortiMonitor's SSO admin form.
  preventNonSsoLogins: false,  // FortiMonitor field; maps to the v2 user.allow_non_sso_login flag
  autoCreateUsers: true,
  roleAssignmentMode: 'saml',  // 'manual' | 'saml'
  roleMappings: [],            // [{ samlField, samlValue, fmRole }]

  // Okta IdP metadata (parsed from XML the operator pastes in Step 1).
  idpMetadataXml: '',
  idpParsed: null,             // { issuer, ssoUrlPost, ssoUrlRedirect, x509Cert, nameIdFormats }
  idpParseError: null,

  // Display only.
  tenantLabel: '',

  // Step 3 output.
  runResult: null              // { ok, message, runbookMd }
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
    return !!store.fortimonitorBaseUrl
      && !!store.urlFragment
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
