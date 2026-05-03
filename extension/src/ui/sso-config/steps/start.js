// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SSO Configuration - Step 1 (Configure).
// Field labels and order mirror FortiMonitor's "Edit SSO Configuration"
// admin form (Teams & Activity -> Integrations). The operator pastes their
// Okta IdP metadata XML; the wizard parses out Entity ID + Login URL +
// Cert and combines them with the operator's other inputs to render a
// paste-ready runbook in Step 4.

import { h, titleBar } from '../../../lib/dom.js';
import { parseIdpMetadata } from '../../../lib/saml-metadata.js';

const TOOL_NAME = 'SSO Configuration (Okta)';

// FortiMonitor System Roles (visible at /roles -> Access Control).
// Used as <datalist> suggestions; users with custom roles can free-type.
const SYSTEM_ROLE_SUGGESTIONS = [
  'Account Admin',
  'API Full Access',
  'API Read-only Access',
  'Billing Admin',
  'Dashboard Admin',
  'Dashboard Viewer',
  'Hide Account Details',
  'Incident Responder',
  'No Access',
  'Server Admin',
  'Sub-Tenant Read-only'
];

const DEFAULT_LOGIN_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';

function labeledRow(labelText, input, helpText = null) {
  return h('label', { class: 'form-row' },
    h('span', { class: 'label-text' }, labelText),
    input,
    helpText ? h('span', { class: 'help-text' }, helpText) : null
  );
}

export function ssoBreadcrumbs(active) {
  const steps = [
    { id: 'start', label: '1. Configure' },
    { id: 'review', label: '2. Review' },
    { id: 'execute', label: '3. Generate' },
    { id: 'results', label: '4. Results' }
  ];
  const order = steps.findIndex((s) => s.id === active);
  return h('div', { class: 'step-breadcrumbs' },
    steps.flatMap((s, i) => {
      const cls = i < order ? 'step done' : i === order ? 'step active' : 'step';
      const label = i < order ? `${s.label} ✓` : s.label;
      const item = h('span', { class: cls }, label);
      return i === 0 ? [item] : [h('span', { class: 'arrow' }, '›'), item];
    })
  );
}

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Configure', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    ssoBreadcrumbs('start'),
    h('h2', {}, 'Build the FortiMonitor SSO config'),
    h('p', {}, 'Paste your Okta IdP metadata XML and fill in the values FortiMonitor\'s Edit SSO Configuration form expects. The wizard generates a paste-ready Markdown runbook covering both sides; you save the actual config in the FortiMonitor and Okta admin UIs.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const continueBtn = h('button', { class: 'btn primary', disabled: true }, 'Continue to Review');

  // ---- Datalist for role suggestions (shared across all role inputs) ----
  const roleDatalist = h('datalist', { id: 'fm-role-suggestions' });
  for (const r of SYSTEM_ROLE_SUGGESTIONS) roleDatalist.appendChild(h('option', { value: r }));
  body.appendChild(roleDatalist);

  // ============================================================
  // Section: FortiMonitor tenant
  // ============================================================
  body.appendChild(h('h3', { class: 'subhead' }, 'FortiMonitor tenant'));

  const baseUrlInput = h('input', {
    type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'https://my.us01.fortimonitor.com'
  });
  baseUrlInput.value = store.fortimonitorBaseUrl;
  body.appendChild(labeledRow('FortiMonitor base URL', baseUrlInput,
    'The region-specific host where you log in (the URL FortiMonitor displays for your tenant). Login URL becomes <base>/sso/<URL Fragment>.'));

  const tenantLabelInput = h('input', { type: 'text', placeholder: 'Acme Production', spellcheck: 'false' });
  tenantLabelInput.value = store.tenantLabel;
  body.appendChild(labeledRow('Tenant label (optional)', tenantLabelInput,
    'Friendly name shown in the runbook header. Display only.'));

  // ============================================================
  // Section: General (FortiMonitor Edit SSO Configuration -> General)
  // ============================================================
  body.appendChild(h('h3', { class: 'subhead' }, 'General'));
  body.appendChild(h('p', { class: 'help-text' },
    'These map 1:1 to fields in FortiMonitor\'s Edit SSO Configuration form. Required fields are starred there; the wizard validates the same set.'));

  const urlFragmentInput = h('input', {
    type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'okta'
  });
  urlFragmentInput.value = store.urlFragment;
  body.appendChild(labeledRow('URL Fragment *', urlFragmentInput,
    'Custom slug appended to /sso/. Pick something tenant-specific so multiple SSO integrations do not collide. Text only; lowercase recommended.'));

  const domainsInput = h('input', {
    type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: '@acme.com, @acme.net'
  });
  domainsInput.value = (store.domains || []).join(', ');
  body.appendChild(labeledRow('Domains', domainsInput,
    'Comma-separated email domains (each starting with @). FortiMonitor uses these to enable first-time login for users from these domains.'));

  const usernameFieldInput = h('input', { type: 'text', spellcheck: 'false' });
  usernameFieldInput.value = store.usernameField;
  body.appendChild(labeledRow('Username Field *', usernameFieldInput,
    'Name of the SAML attribute statement carrying the user\'s email. Default "email" works with the standard Okta attribute mapping.'));

  const loginBindingInput = h('input', { type: 'text', spellcheck: 'false' });
  loginBindingInput.value = store.loginBinding || DEFAULT_LOGIN_BINDING;
  body.appendChild(labeledRow('Login Binding *', loginBindingInput,
    'SAML binding URN. HTTP-POST is the Okta default and what FortiMonitor recommends.'));

  const logoutUrlInput = h('input', {
    type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: '(optional)'
  });
  logoutUrlInput.value = store.logoutUrl;
  body.appendChild(labeledRow('Logout URL (optional)', logoutUrlInput,
    'Where FortiMonitor sends users on logout. Leave blank to skip Single Logout.'));

  const logoutBindingInput = h('input', {
    type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: '(optional)'
  });
  logoutBindingInput.value = store.logoutBinding;
  body.appendChild(labeledRow('Logout Binding (optional)', logoutBindingInput,
    'Required only if you set a Logout URL.'));

  // ============================================================
  // Section: IdP metadata paste (provides Entity ID, Login URL, Cert)
  // ============================================================
  body.appendChild(h('h3', { class: 'subhead' }, 'Okta IdP metadata XML'));
  body.appendChild(h('p', { class: 'help-text' },
    'Paste the Identity Provider metadata XML you downloaded from your Okta SAML app (Sign On tab -> View SAML setup instructions). The wizard extracts the Entity ID, Login URL, and signing certificate that go into FortiMonitor\'s General section + Certificate field.'));

  const idpPaste = h('textarea', {
    class: 'paste-area',
    rows: 8,
    spellcheck: 'false',
    placeholder: '<?xml version="1.0" encoding="UTF-8"?>\n<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="...">\n  <md:IDPSSODescriptor ...>\n    ...\n  </md:IDPSSODescriptor>\n</md:EntityDescriptor>'
  });
  idpPaste.value = store.idpMetadataXml;
  body.appendChild(idpPaste);

  const parseStatus = h('div', { class: 'parse-result empty' });
  body.appendChild(parseStatus);

  // ============================================================
  // Section: User Configuration (FortiMonitor's User Configuration block)
  // ============================================================
  body.appendChild(h('h3', { class: 'subhead' }, 'User Configuration'));

  const preventNonSsoCheck = h('input', { type: 'checkbox' });
  if (store.preventNonSsoLogins) preventNonSsoCheck.checked = true;
  body.appendChild(h('label', { class: 'radio-row' }, preventNonSsoCheck,
    h('span', {},
      h('strong', {}, 'Prevent non-SSO logins'),
      ' (FortiMonitor recommends leaving this OFF until you have confirmed end-to-end SSO works for at least one admin)'
    )
  ));

  const autoCreateCheck = h('input', { type: 'checkbox' });
  if (store.autoCreateUsers) autoCreateCheck.checked = true;
  body.appendChild(h('label', { class: 'radio-row' }, autoCreateCheck,
    h('span', {},
      h('strong', {}, 'Auto Create Users'),
      ' (first-time SSO users are created automatically; off = an admin must approve each)'
    )
  ));

  body.appendChild(h('p', { class: 'help-text' }, 'Default Roles for New Users:'));
  const modeManual = h('input', { type: 'radio', name: 'role-mode', value: 'manual' });
  if (store.roleAssignmentMode === 'manual') modeManual.checked = true;
  const modeSaml = h('input', { type: 'radio', name: 'role-mode', value: 'saml' });
  if (store.roleAssignmentMode === 'saml') modeSaml.checked = true;
  body.appendChild(h('label', { class: 'radio-row' }, modeManual,
    h('span', {}, 'Assign roles ', h('strong', {}, 'manually'),
      ' (admin assigns each new user after first login)')));
  body.appendChild(h('label', { class: 'radio-row' }, modeSaml,
    h('span', {}, 'Assign roles based on ', h('strong', {}, 'SAML mapping'),
      ' (rules below)')));

  // ============================================================
  // Section: Role mappings (visible only when mode = saml)
  // ============================================================
  const mappingsSection = h('div', { class: 'role-mappings-section' });
  body.appendChild(mappingsSection);

  function renderMappings() {
    mappingsSection.innerHTML = '';
    if (modeManual.checked) return;
    mappingsSection.appendChild(h('h4', { class: 'subhead-sub' }, 'Role mappings'));
    mappingsSection.appendChild(h('p', { class: 'help-text' },
      'One row per FortiMonitor role assignment. SAML Role Field is the attribute name FortiMonitor checks; SAML Role is the exact value (case sensitive) that triggers the mapping. If multiple rows match, FortiMonitor checks them in order.'));
    if (!store.roleMappings.length) {
      mappingsSection.appendChild(h('p', { class: 'help-text' },
        'No role mappings yet. Click below to add one.'));
    }
    for (let i = 0; i < store.roleMappings.length; i += 1) {
      const m = store.roleMappings[i];
      const fieldInput = h('input', {
        type: 'text', placeholder: 'admin_group', spellcheck: 'false'
      });
      fieldInput.value = m.samlField;
      fieldInput.addEventListener('input', () => {
        store.roleMappings[i].samlField = fieldInput.value.trim();
        recomputeContinue();
      });
      const valueInput = h('input', {
        type: 'text', placeholder: 'fm_admins', spellcheck: 'false'
      });
      valueInput.value = m.samlValue;
      valueInput.addEventListener('input', () => {
        store.roleMappings[i].samlValue = valueInput.value.trim();
        recomputeContinue();
      });
      const fmRoleInput = h('input', {
        type: 'text', placeholder: 'Dashboard Admin', list: 'fm-role-suggestions', spellcheck: 'false'
      });
      fmRoleInput.value = m.fmRole;
      fmRoleInput.addEventListener('input', () => {
        store.roleMappings[i].fmRole = fmRoleInput.value.trim();
        recomputeContinue();
      });
      const removeBtn = h('button', {
        class: 'btn', type: 'button', title: 'Remove this mapping',
        onClick: () => {
          store.roleMappings.splice(i, 1);
          renderMappings();
          recomputeContinue();
        }
      }, '×');
      mappingsSection.appendChild(h('div', { class: 'role-mapping-row' },
        labeledRow('SAML Role Field', fieldInput),
        labeledRow('SAML Role', valueInput),
        labeledRow('FortiMonitor role', fmRoleInput),
        removeBtn
      ));
    }
    const addBtn = h('button', {
      class: 'btn', type: 'button',
      onClick: () => {
        store.roleMappings.push({ samlField: '', samlValue: '', fmRole: '' });
        renderMappings();
        recomputeContinue();
      }
    }, '+ Add role mapping');
    mappingsSection.appendChild(addBtn);
  }
  renderMappings();

  // ---- Footer ----
  const footer = h('div', { class: 'step-footer' }, continueBtn);
  frame.appendChild(footer);
  container.appendChild(frame);

  // ---- Wiring ----
  function syncStore() {
    store.fortimonitorBaseUrl = baseUrlInput.value.trim();
    store.tenantLabel = tenantLabelInput.value.trim();
    store.urlFragment = urlFragmentInput.value.trim();
    store.domains = domainsInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    store.usernameField = usernameFieldInput.value.trim() || 'email';
    store.loginBinding = loginBindingInput.value.trim() || DEFAULT_LOGIN_BINDING;
    store.logoutUrl = logoutUrlInput.value.trim();
    store.logoutBinding = logoutBindingInput.value.trim();
    store.idpMetadataXml = idpPaste.value;
    store.preventNonSsoLogins = preventNonSsoCheck.checked;
    store.autoCreateUsers = autoCreateCheck.checked;
    store.roleAssignmentMode = modeManual.checked ? 'manual' : 'saml';
    // store.roleMappings already kept in sync via per-row listeners.
  }

  function reparseMetadata() {
    const xml = idpPaste.value;
    if (!xml.trim()) {
      store.idpParsed = null;
      store.idpParseError = null;
      parseStatus.className = 'parse-result empty';
      parseStatus.textContent = '';
      return;
    }
    try {
      store.idpParsed = parseIdpMetadata(xml);
      store.idpParseError = null;
      parseStatus.className = 'parse-result ok';
      parseStatus.innerHTML = '';
      parseStatus.appendChild(h('div', { class: 'parse-summary' },
        h('strong', {}, 'IdP metadata parsed'),
        h('div', {}, 'Entity ID (IdP issuer): ', h('code', {}, store.idpParsed.issuer)),
        h('div', {}, 'Login URL (HTTP-POST): ', h('code', {}, store.idpParsed.ssoUrlPost || '(none)')),
        h('div', {}, 'Signing cert: ', h('code', {}, store.idpParsed.x509Cert.slice(0, 32) + '... (' + store.idpParsed.x509Cert.length + ' chars)'))
      ));
    } catch (err) {
      store.idpParsed = null;
      store.idpParseError = err.message || String(err);
      parseStatus.className = 'parse-result error';
      parseStatus.textContent = store.idpParseError;
    }
  }

  function recomputeContinue() {
    syncStore();
    const baseUrlValid = /^https?:\/\//i.test(store.fortimonitorBaseUrl);
    const fragmentValid = !!store.urlFragment && /^[a-zA-Z0-9_\-]+$/.test(store.urlFragment);
    const idpValid = !!store.idpParsed && !!store.idpParsed.issuer && !!store.idpParsed.ssoUrlPost;
    const rolesValid = store.roleAssignmentMode === 'manual'
      || store.roleMappings.every((m) => m.samlField && m.samlValue && m.fmRole);
    continueBtn.disabled = !(baseUrlValid && fragmentValid && idpValid && rolesValid);
  }

  // Live wiring
  for (const el of [
    baseUrlInput, tenantLabelInput, urlFragmentInput, domainsInput,
    usernameFieldInput, loginBindingInput, logoutUrlInput, logoutBindingInput
  ]) {
    el.addEventListener('input', recomputeContinue);
  }
  preventNonSsoCheck.addEventListener('change', recomputeContinue);
  autoCreateCheck.addEventListener('change', recomputeContinue);
  modeManual.addEventListener('change', () => { renderMappings(); recomputeContinue(); });
  modeSaml.addEventListener('change', () => { renderMappings(); recomputeContinue(); });
  idpPaste.addEventListener('input', () => { reparseMetadata(); recomputeContinue(); });

  continueBtn.addEventListener('click', () => {
    syncStore();
    if (!store.idpParsed) {
      reparseMetadata();
      if (!store.idpParsed) return;
    }
    navigate('/review');
  });

  // First render: parse pre-existing XML, sync derived state.
  if (store.idpMetadataXml) reparseMetadata();
  recomputeContinue();
}
