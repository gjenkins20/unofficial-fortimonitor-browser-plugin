// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Top-level UI controller for the Generate SSO Configuration tool (FMN-139).
// Pure generator: no FortiMonitor session-auth, no v2 API. Wizard reads
// Okta-first-then-FortiMonitor:
//   /okta         (Step 1) walkthrough + IdP metadata XML paste
//   /fortimonitor (Step 2) FortiMonitor-tenant inputs (read-only Okta values shown inline)
//   /review       (Step 3) side-by-side preview, "Generate runbook" button
//   /results      (Step 4) download Markdown runbook

import * as okta from './steps/okta.js';
import * as fortimonitor from './steps/fortimonitor.js';
import * as review from './steps/review.js';
import * as results from './steps/results.js';
import { onEvent } from '../../lib/messaging.js';

document.documentElement.dataset.toolMode = 'sso-config';

const store = {
  // Okta IdP metadata (parsed from XML the operator pastes in Step 1).
  idpMetadataXml: '',
  idpParsed: null,             // { issuer, ssoUrlPost, ssoUrlRedirect, x509Cert, nameIdFormats }
  idpParseError: null,

  // FortiMonitor SSO admin form (Teams & Activity -> Integrations -> Edit
  // SSO Configuration). Field names mirror the FortiMonitor labels exactly.
  fortimonitorBaseUrl: '',     // e.g. https://my.us01.fortimonitor.com (region-specific)
  urlFragment: '',             // e.g. "okta" -> /sso/okta login URL
  domains: [],                 // e.g. ['@company.com']
  usernameField: 'email',
  loginBinding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
  logoutUrl: '',
  logoutBinding: '',

  // FortiMonitor User Configuration block.
  preventNonSsoLogins: false,
  autoCreateUsers: true,
  roleAssignmentMode: 'saml',  // 'manual' | 'saml'
  roleMappings: [],            // [{ samlField, samlValue, fmRole }]

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
  '/okta': okta,
  '/fortimonitor': fortimonitor,
  '/review': review,
  '/results': results
};

function currentHash() {
  const h = window.location.hash || '#/okta';
  return h.startsWith('#') ? h.slice(1) : h;
}

function navigate(to) {
  if (!to.startsWith('/')) to = '/' + to;
  window.location.hash = '#' + to;
}

function canEnter(route) {
  if (route === '/okta') return true;
  if (route === '/fortimonitor') return !!store.idpParsed;
  if (route === '/review') {
    return !!store.idpParsed
      && !!store.fortimonitorBaseUrl
      && !!store.urlFragment;
  }
  if (route === '/results') return !!store.runResult;
  return false;
}

let activeTeardown = null;
function render() {
  const route = currentHash();
  const mod = routes[route];
  if (!mod || !canEnter(route)) {
    if (route !== '/okta') navigate('/okta');
    else mountRoute('/okta', okta);
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
