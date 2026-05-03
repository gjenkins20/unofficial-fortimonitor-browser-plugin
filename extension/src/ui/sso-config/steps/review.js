// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SSO Configuration - Step 2 (Review).
// Side-by-side preview: what FortiMonitor will receive vs. what the operator
// pastes into Okta. Dry-run on by default; until FMN-138 (Discovery) lands,
// the real-run path errors out with a clear message in Step 3.

import { h, titleBar } from '../../../lib/dom.js';
import { ssoBreadcrumbs } from './start.js';

const TOOL_NAME = 'SSO Configuration (Okta IdP)';

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Review', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    ssoBreadcrumbs('review'),
    h('h2', {}, 'Review the configuration before executing'),
    h('p', {}, 'Left: the values FortiMonitor will receive when the configuration is saved. Right: the values you paste into Okta. Make sure both panels match before continuing.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ---- Two-column preview ----
  const grid = h('div', { class: 'review-grid' });
  body.appendChild(grid);

  // FortiMonitor side
  const fmCol = h('div', { class: 'review-col' });
  fmCol.appendChild(h('h3', { class: 'subhead' }, 'FortiMonitor will receive'));
  const idp = store.idpParsed || {};
  const fmRows = [
    ['IdP issuer', idp.issuer || '(not parsed)'],
    ['IdP SSO URL (POST)', idp.ssoUrlPost || idp.ssoUrlRedirect || '(none)'],
    ['IdP signing cert', certPreview(idp.x509Cert)],
    ['SP entity ID', store.spEntityId],
    ['ACS URL', store.acsUrl],
    ['NameID format', store.nameIdFormat],
    ['SSO mode', store.ssoMode === 'sso-only' ? 'SSO-only' : 'SSO with password fallback'],
    ['Default role', store.roleMapping.defaultRole],
    ['Group overrides', formatOverrides(store.roleMapping.overrides)]
  ];
  fmCol.appendChild(buildKvTable(fmRows));
  grid.appendChild(fmCol);

  // Okta side
  const oktaCol = h('div', { class: 'review-col' });
  oktaCol.appendChild(h('h3', { class: 'subhead' }, 'Paste into Okta'));
  const oktaRows = [
    ['Single sign on URL', store.acsUrl],
    ['Audience URI / SP Entity ID', store.spEntityId],
    ['Name ID format', store.nameIdFormat],
    ['Application username', 'Email (user.email)'],
    ['Attribute: ' + store.attributes.email, 'user.email'],
    ['Attribute: ' + store.attributes.firstName, 'user.firstName'],
    ['Attribute: ' + store.attributes.lastName, 'user.lastName'],
    ['Group attribute: ' + store.attributes.groups, 'Matches regex .* (or your prefix)']
  ];
  oktaCol.appendChild(buildKvTable(oktaRows, { copy: true }));
  grid.appendChild(oktaCol);

  // ---- Dry-run toggle ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Execution mode'));
  const dryRunCheck = h('input', { type: 'checkbox' });
  if (store.dryRun) dryRunCheck.checked = true;
  dryRunCheck.addEventListener('change', () => {
    store.dryRun = dryRunCheck.checked;
  });
  body.appendChild(h('label', { class: 'radio-row' },
    dryRunCheck,
    h('span', {},
      h('strong', {}, 'Dry run'),
      ' (recommended). Builds the runbook and SP metadata XML; does not POST to FortiMonitor.'
    )
  ));

  body.appendChild(h('div', { class: 'banner banner-info' },
    'The FortiMonitor save endpoint is being captured under FMN-138 (Discovery). Until it lands, the wizard supports dry-run only; the real-run path will error in Step 3 with a pointer to the Discovery ticket.'
  ));

  // ---- Footer ----
  const backBtn = h('button', { class: 'btn' }, 'Back');
  const goBtn = h('button', { class: 'btn primary' }, 'Continue to Execute');
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

function certPreview(cert) {
  if (!cert) return '(none)';
  return cert.slice(0, 32) + '... (' + cert.length + ' chars)';
}

function formatOverrides(overrides) {
  if (!overrides || !overrides.length) return '(none)';
  return overrides.map((o) => `${o.group} -> ${o.role}`).join(', ');
}
