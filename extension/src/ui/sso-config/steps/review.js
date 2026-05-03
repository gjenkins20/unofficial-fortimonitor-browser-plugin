// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Generate SSO Configuration - Step 3 (Review).
// Side-by-side preview of the FortiMonitor Edit SSO Configuration values
// + the Okta-side notes that the runbook will document. The "Generate
// runbook" button is the terminal action of this step: it builds the
// Markdown runbook and routes to Results. There is no separate Generate
// step (the build is synchronous).

import { h, titleBar } from '../../../lib/dom.js';
import { ssoBreadcrumbs } from './okta.js';
import { buildSsoRunbook } from '../../../lib/sso-runbook.js';

const TOOL_NAME = 'Generate SSO Configuration';

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Review', { toolName: TOOL_NAME, beta: true }));

  frame.appendChild(h('div', { class: 'step-header' },
    ssoBreadcrumbs('review'),
    h('h2', {}, 'Step 3: Review the values you will paste'),
    h('p', {}, 'Left: every field FortiMonitor\'s Edit SSO Configuration form expects, mapped to your inputs and the parsed Okta metadata. Right: what to expect on the Okta side. The full step-by-step lands as a downloadable runbook in the next step.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const idp = store.idpParsed || {};
  const baseUrl = stripTrailingSlash(store.fortimonitorBaseUrl);
  const ssoLoginUrl = `${baseUrl}/sso/${store.urlFragment}`;

  // ---- FortiMonitor side: paste targets ----
  const grid = h('div', { class: 'review-grid' });
  body.appendChild(grid);

  const fmCol = h('div', { class: 'review-col' });
  fmCol.appendChild(h('h3', { class: 'subhead' }, 'FortiMonitor: Edit SSO Configuration'));
  fmCol.appendChild(h('p', { class: 'help-text' }, 'Open Teams & Activity -> Integrations -> Add (or edit) SSO Configuration. Paste these values; copy buttons are on the right.'));

  fmCol.appendChild(h('h4', { class: 'subhead-sub' }, 'General'));
  fmCol.appendChild(buildKvTable([
    ['URL Fragment', store.urlFragment],
    ['Domains', store.domains.length ? store.domains.join(', ') : '(blank)'],
    ['Username Field', store.usernameField],
    ['Entity ID', idp.issuer || '(unparsed)'],
    ['Login URL', idp.ssoUrlPost || idp.ssoUrlRedirect || '(unparsed)'],
    ['Login Binding', store.loginBinding],
    ['Logout URL', store.logoutUrl || '(blank)'],
    ['Logout Binding', store.logoutBinding || '(blank)']
  ], { copy: true }));

  fmCol.appendChild(h('h4', { class: 'subhead-sub' }, 'Certificate'));
  fmCol.appendChild(h('p', { class: 'help-text' }, 'Paste this single base64 block (no BEGIN/END markers, no whitespace) into FortiMonitor\'s Certificate field.'));
  const certBlock = h('div', { class: 'cert-block' });
  certBlock.appendChild(h('code', { class: 'cert-text' }, idp.x509Cert || '(unparsed)'));
  if (idp.x509Cert) {
    const copyBtn = h('button', { class: 'btn copy-btn', title: 'Copy', type: 'button' }, '⧉');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(idp.x509Cert).catch(() => {});
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '⧉'; }, 900);
    });
    certBlock.appendChild(copyBtn);
  }
  fmCol.appendChild(certBlock);

  fmCol.appendChild(h('h4', { class: 'subhead-sub' }, 'User Configuration'));
  fmCol.appendChild(buildKvTable([
    ['Prevent non-SSO logins', store.preventNonSsoLogins ? 'checked' : 'unchecked'],
    ['Auto Create Users', store.autoCreateUsers ? 'checked' : 'unchecked'],
    ['Default Roles', store.roleAssignmentMode === 'manual' ? 'Assign roles manually' : 'Assign roles based on SAML mapping']
  ]));

  if (store.roleAssignmentMode === 'saml' && store.roleMappings.length) {
    fmCol.appendChild(h('h4', { class: 'subhead-sub' }, 'Role mappings'));
    const t = h('table', { class: 'kv-table' });
    t.appendChild(h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'SAML Role Field'),
      h('th', { scope: 'col' }, 'SAML Role'),
      h('th', { scope: 'col' }, 'FortiMonitor role')
    )));
    const tbody = h('tbody', {});
    for (const m of store.roleMappings) {
      tbody.appendChild(h('tr', {},
        h('td', {}, h('code', {}, m.samlField)),
        h('td', {}, h('code', {}, m.samlValue)),
        h('td', {}, h('code', {}, m.fmRole))
      ));
    }
    t.appendChild(tbody);
    fmCol.appendChild(t);
  }
  grid.appendChild(fmCol);

  // ---- Okta side notes ----
  const oktaCol = h('div', { class: 'review-col' });
  oktaCol.appendChild(h('h3', { class: 'subhead' }, 'Okta: SAML app config'));
  oktaCol.appendChild(h('p', { class: 'help-text' }, 'You created the Okta SAML app with placeholder URLs in Step 1. After saving FortiMonitor, you will return to Okta to replace those placeholders with the SP-side values FortiMonitor displays on its integration row. The runbook walks both passes.'));

  oktaCol.appendChild(h('h4', { class: 'subhead-sub' }, 'Pass 1 (placeholders, already done)'));
  oktaCol.appendChild(buildKvTable([
    ['Single sign on URL', 'https://placeholder.example/acs (replaced after FortiMonitor save)'],
    ['Audience URI', 'https://placeholder.example (replaced after FortiMonitor save)'],
    ['Name ID format', 'EmailAddress'],
    ['Application username', 'Email']
  ]));

  oktaCol.appendChild(h('h4', { class: 'subhead-sub' }, 'Attribute statements'));
  oktaCol.appendChild(buildKvTable([
    [store.usernameField, 'user.email (Basic name format)']
  ]));

  if (store.roleAssignmentMode === 'saml' && store.roleMappings.length) {
    oktaCol.appendChild(h('h4', { class: 'subhead-sub' }, 'Group attribute statements'));
    const seen = new Set();
    const rows = [];
    for (const m of store.roleMappings) {
      if (seen.has(m.samlField)) continue;
      seen.add(m.samlField);
      const matchingValues = store.roleMappings.filter((x) => x.samlField === m.samlField).map((x) => x.samlValue);
      const filterRegex = matchingValues.length > 1
        ? `^(${matchingValues.join('|')})$`
        : `^${matchingValues[0]}$`;
      rows.push([m.samlField, `Matches regex ${filterRegex}`]);
    }
    oktaCol.appendChild(buildKvTable(rows));
  }

  oktaCol.appendChild(h('h4', { class: 'subhead-sub' }, 'After FortiMonitor save'));
  oktaCol.appendChild(h('p', { class: 'help-text' }, `Replace the Pass 1 placeholders with the SP Entity ID and ACS URL FortiMonitor displays on the integration row. The login URL the user will visit: ${ssoLoginUrl}`));

  grid.appendChild(oktaCol);

  // ---- Footer ----
  const backBtn = h('button', { class: 'btn' }, 'Back');
  const generateBtn = h('button', { class: 'btn primary' }, 'Generate runbook');
  const footer = h('div', { class: 'step-footer' }, backBtn, generateBtn);
  frame.appendChild(footer);
  container.appendChild(frame);

  backBtn.addEventListener('click', () => navigate('/fortimonitor'));
  generateBtn.addEventListener('click', () => {
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
      store.runResult = {
        ok: false,
        message: err.message || String(err),
        runbookMd: null
      };
      navigate('/results');
    }
  });
}

function buildKvTable(rows, { copy = false } = {}) {
  const t = h('table', { class: 'kv-table' });
  const tbody = h('tbody', {});
  for (const [k, v] of rows) {
    const cells = [
      h('th', { scope: 'row' }, k),
      h('td', {}, h('code', {}, v))
    ];
    if (copy) {
      const btn = h('button', { class: 'btn copy-btn', title: 'Copy', type: 'button' }, '⧉');
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(String(v)).catch(() => {});
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '⧉'; }, 900);
      });
      cells.push(h('td', { class: 'copy-cell' }, btn));
    }
    tbody.appendChild(h('tr', {}, ...cells));
  }
  t.appendChild(tbody);
  return t;
}

function stripTrailingSlash(s) {
  return s && s.endsWith('/') ? s.slice(0, -1) : (s || '');
}
