// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SSO Configuration - Step 3 (Generate).
// Pure generator: builds the runbook Markdown from the store, stores it on
// runResult, and navigates to Results. No FortiMonitor save, no dry-run
// distinction; the operator does both saves themselves with eyes-on.

import { h, titleBar } from '../../../lib/dom.js';
import { buildSsoRunbook } from '../../../lib/sso-runbook.js';
import { ssoBreadcrumbs } from './start.js';

const TOOL_NAME = 'SSO Configuration (Okta)';

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Generate', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    ssoBreadcrumbs('execute'),
    h('h2', {}, 'Generating the runbook'),
    h('p', {}, 'Assembling the Markdown runbook with your inputs and the parsed Okta IdP metadata.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const status = h('div', { class: 'parse-result running' }, 'Working...');
  body.appendChild(status);

  const backBtn = h('button', { class: 'btn' }, 'Back');
  const footer = h('div', { class: 'step-footer' }, backBtn);
  frame.appendChild(footer);
  container.appendChild(frame);

  backBtn.addEventListener('click', () => navigate('/review'));

  setTimeout(() => run(), 0);

  function run() {
    try {
      const runbookMd = buildSsoRunbook({
        tenantLabel: store.tenantLabel || null,
        fortimonitorBaseUrl: store.fortimonitorBaseUrl,
        urlFragment: store.urlFragment,
        domains: store.domains,
        usernameField: store.usernameField,
        loginBinding: store.loginBinding,
        logoutUrl: store.logoutUrl,
        logoutBinding: store.logoutBinding,
        idp: store.idpParsed,
        preventNonSsoLogins: store.preventNonSsoLogins,
        autoCreateUsers: store.autoCreateUsers,
        roleAssignmentMode: store.roleAssignmentMode,
        roleMappings: store.roleMappings
      });

      store.runResult = {
        ok: true,
        message: 'Runbook ready. Download or copy from the Results step.',
        runbookMd
      };
      navigate('/results');
    } catch (err) {
      status.className = 'parse-result error';
      status.textContent = err.message || String(err);
      store.runResult = {
        ok: false,
        message: err.message || String(err),
        runbookMd: null
      };
    }
  }
}
