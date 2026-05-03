// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SSO Configuration - Step 2 (Review).
// Side-by-side preview: the FortiMonitor "Edit SSO Configuration" form
// values the operator will paste, plus the Okta-side notes for the
// runbook. No save happens here or anywhere; this is a generator-only tool.

import { h, titleBar } from '../../../lib/dom.js';
import { ssoBreadcrumbs } from './start.js';

const TOOL_NAME = 'SSO Configuration (Okta)';

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Review', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    ssoBreadcrumbs('review'),
    h('h2', {}, 'Review the values you will paste'),
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
  fmCol.appendChild(h('p', { class: 'help-text' }, `Open Teams & Activity -> Integrations -> Add (or edit) SSO Configuration. Paste these values; copy buttons are on the right.`));

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
  const certText = h('code', { class: 'cert-text' }, idp.x509Cert || '(unparsed)');
  certBlock.appendChild(certText);
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
  const userConfigRows = [
    ['Prevent non-SSO logins', store.preventNonSsoLogins ? 'checked' : 'unchecked'],
    ['Auto Create Users', store.autoCreateUsers ? 'checked' : 'unchecked'],
    ['Default Roles', store.roleAssignmentMode === 'manual' ? 'Assign roles manually' : 'Assign roles based on SAML mapping']
  ];
  fmCol.appendChild(buildKvTable(userConfigRows));

  if (store.roleAssignmentMode === 'saml' && store.roleMappings.length) {
    fmCol.appendChild(h('h4', { class: 'subhead-sub' }, 'Role mappings'));
    const t = h('table', { class: 'kv-table' });
    const thead = h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'SAML Role Field'),
      h('th', { scope: 'col' }, 'SAML Role'),
      h('th', { scope: 'col' }, 'FortiMonitor role')
    ));
    const tbody = h('tbody', {});
    for (const m of store.roleMappings) {
      tbody.appendChild(h('tr', {},
        h('td', {}, h('code', {}, m.samlField)),
        h('td', {}, h('code', {}, m.samlValue)),
        h('td', {}, h('code', {}, m.fmRole))
      ));
    }
    t.appendChild(thead);
    t.appendChild(tbody);
    fmCol.appendChild(t);
  }
  grid.appendChild(fmCol);

  // ---- Okta side notes ----
  const oktaCol = h('div', { class: 'review-col' });
  oktaCol.appendChild(h('h3', { class: 'subhead' }, 'Okta: SAML app config'));
  oktaCol.appendChild(h('p', { class: 'help-text' }, 'Two-pass setup: create the Okta SAML app with placeholders before saving FortiMonitor; come back to update Okta with the SP-side values FortiMonitor displays after save. The runbook walks both passes.'));

  oktaCol.appendChild(h('h4', { class: 'subhead-sub' }, 'Pass 1 (placeholders)'));
  oktaCol.appendChild(buildKvTable([
    ['Single sign on URL', 'https://placeholder.example/acs (replaced in Pass 3)'],
    ['Audience URI', 'https://placeholder.example (replaced in Pass 3)'],
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

  oktaCol.appendChild(h('h4', { class: 'subhead-sub' }, 'Pass 3 (after FortiMonitor save)'));
  oktaCol.appendChild(h('p', { class: 'help-text' }, `Replace the Pass 1 placeholders with the SP Entity ID and ACS URL FortiMonitor displays on the integration row. Login URL the user will visit: ${ssoLoginUrl}`));

  grid.appendChild(oktaCol);

  // ---- Footer ----
  const backBtn = h('button', { class: 'btn' }, 'Back');
  const goBtn = h('button', { class: 'btn primary' }, 'Generate runbook');
  const footer = h('div', { class: 'step-footer' }, backBtn, goBtn);
  frame.appendChild(footer);
  container.appendChild(frame);

  backBtn.addEventListener('click', () => navigate('/start'));
  goBtn.addEventListener('click', () => navigate('/execute'));
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
