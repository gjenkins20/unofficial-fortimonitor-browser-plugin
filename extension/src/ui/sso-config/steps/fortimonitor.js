// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Generate SSO Configuration - Step 2 (Configure FortiMonitor).
// Shows the values extracted from the Okta IdP metadata (Step 1) as
// read-only references, then collects the FortiMonitor-tenant-specific
// inputs (URL Fragment, Domains, role mappings, User Configuration).
// Field labels mirror FortiMonitor's "Edit SSO Configuration" admin form
// (Teams & Activity -> Integrations).

import { h, titleBar } from '../../../lib/dom.js';
import { ssoBreadcrumbs } from './okta.js';

const TOOL_NAME = 'Generate SSO Configuration';

// FortiMonitor System Roles (visible at /roles -> Access Control). Used
// as <datalist> suggestions; users with custom roles can free-type.
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

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Configure FortiMonitor', { toolName: TOOL_NAME, beta: true }));

  frame.appendChild(h('div', { class: 'step-header' },
    ssoBreadcrumbs('fortimonitor'),
    h('h2', {}, 'Step 2: Configure FortiMonitor'),
    h('p', {}, 'These are the values you will paste into FortiMonitor\'s Edit SSO Configuration form (Teams & Activity -> Integrations). The wizard fills the Okta-derived fields automatically; you provide the tenant-specific values for your environment.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const idp = store.idpParsed || {};
  const continueBtn = h('button', { class: 'btn primary' }, 'Continue to Review');

  // ---- Datalist for role suggestions ----
  const roleDatalist = h('datalist', { id: 'fm-role-suggestions' });
  for (const r of SYSTEM_ROLE_SUGGESTIONS) roleDatalist.appendChild(h('option', { value: r }));
  body.appendChild(roleDatalist);

  // ============================================================
  // Section: From your Okta IdP metadata (read-only)
  // ============================================================
  body.appendChild(h('h3', { class: 'subhead' }, 'From your Okta IdP metadata (auto-filled)'));
  body.appendChild(h('p', { class: 'help-text' },
    'These three values come straight from the metadata XML you pasted in Step 1. They go into FortiMonitor as Entity ID, Login URL, and the Certificate field.'
  ));

  const ro = h('table', { class: 'kv-table' });
  ro.appendChild(h('tbody', {},
    h('tr', {},
      h('th', { scope: 'row' }, 'Entity ID'),
      h('td', {}, h('code', {}, idp.issuer || '(missing)'))
    ),
    h('tr', {},
      h('th', { scope: 'row' }, 'Login URL'),
      h('td', {}, h('code', {}, idp.ssoUrlPost || idp.ssoUrlRedirect || '(missing)'))
    ),
    h('tr', {},
      h('th', { scope: 'row' }, 'Signing certificate'),
      h('td', {}, h('code', {},
        idp.x509Cert
          ? idp.x509Cert.slice(0, 40) + '... (' + idp.x509Cert.length + ' chars)'
          : '(missing)'
      ))
    )
  ));
  body.appendChild(ro);

  // ============================================================
  // Section: FortiMonitor tenant
  // ============================================================
  body.appendChild(h('h3', { class: 'subhead' }, 'Your FortiMonitor tenant'));

  const baseUrlInput = h('input', {
    type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'https://my.us01.fortimonitor.com'
  });
  baseUrlInput.value = store.fortimonitorBaseUrl;
  body.appendChild(labeledRow('FortiMonitor base URL', baseUrlInput,
    'The region-specific host where you log in to FortiMonitor. The SSO login URL becomes <base>/sso/<URL Fragment>.'));

  const tenantLabelInput = h('input', { type: 'text', placeholder: 'Acme Production', spellcheck: 'false' });
  tenantLabelInput.value = store.tenantLabel;
  body.appendChild(labeledRow('Tenant label (optional)', tenantLabelInput,
    'Friendly name shown in the runbook header. Display only.'));

  // ============================================================
  // Section: General (FortiMonitor's Edit SSO Configuration -> General)
  // ============================================================
  body.appendChild(h('h3', { class: 'subhead' }, 'General (FortiMonitor: Edit SSO Configuration -> General)'));

  const urlFragmentInput = h('input', {
    type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'okta'
  });
  urlFragmentInput.value = store.urlFragment;
  body.appendChild(labeledRow('URL Fragment *', urlFragmentInput,
    'Custom slug appended to /sso/. Pick something tenant-specific so multiple SSO integrations do not collide. Lowercase recommended.'));

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
    'Name of the SAML attribute carrying the user\'s email - default "email" matches the Okta attribute statement you set up in Step 1.'));

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
      'One row per FortiMonitor role assignment. SAML Role Field is the attribute name FortiMonitor checks; SAML Role is the exact value (case-sensitive) that triggers the mapping. The "FortiMonitor role" suggestions are FortiMonitor\'s built-in System Roles - free-type any custom role you have created in your tenant.'));
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
        recompute();
      });
      const valueInput = h('input', {
        type: 'text', placeholder: 'fm_admins', spellcheck: 'false'
      });
      valueInput.value = m.samlValue;
      valueInput.addEventListener('input', () => {
        store.roleMappings[i].samlValue = valueInput.value.trim();
        recompute();
      });
      const fmRoleInput = h('input', {
        type: 'text', placeholder: 'Dashboard Admin', list: 'fm-role-suggestions', spellcheck: 'false'
      });
      fmRoleInput.value = m.fmRole;
      fmRoleInput.addEventListener('input', () => {
        store.roleMappings[i].fmRole = fmRoleInput.value.trim();
        recompute();
      });
      const removeBtn = h('button', {
        class: 'btn', type: 'button', title: 'Remove this mapping',
        onClick: () => {
          store.roleMappings.splice(i, 1);
          renderMappings();
          recompute();
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
        recompute();
      }
    }, '+ Add role mapping');
    mappingsSection.appendChild(addBtn);
  }
  renderMappings();

  // ---- Footer ----
  const backBtn = h('button', { class: 'btn' }, 'Back');
  const footer = h('div', { class: 'step-footer' }, backBtn, continueBtn);
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
    store.preventNonSsoLogins = preventNonSsoCheck.checked;
    store.autoCreateUsers = autoCreateCheck.checked;
    store.roleAssignmentMode = modeManual.checked ? 'manual' : 'saml';
  }

  function recompute() {
    syncStore();
    const baseUrlValid = /^https?:\/\//i.test(store.fortimonitorBaseUrl);
    const fragmentValid = !!store.urlFragment && /^[a-zA-Z0-9_\-]+$/.test(store.urlFragment);
    const idpValid = !!idp.issuer && !!idp.ssoUrlPost && !!idp.x509Cert;
    const rolesValid = store.roleAssignmentMode === 'manual'
      || store.roleMappings.every((m) => m.samlField && m.samlValue && m.fmRole);
    continueBtn.disabled = !(baseUrlValid && fragmentValid && idpValid && rolesValid);
  }

  for (const el of [
    baseUrlInput, tenantLabelInput, urlFragmentInput, domainsInput,
    usernameFieldInput, loginBindingInput, logoutUrlInput, logoutBindingInput
  ]) {
    el.addEventListener('input', recompute);
  }
  preventNonSsoCheck.addEventListener('change', recompute);
  autoCreateCheck.addEventListener('change', recompute);
  modeManual.addEventListener('change', () => { renderMappings(); recompute(); });
  modeSaml.addEventListener('change', () => { renderMappings(); recompute(); });

  backBtn.addEventListener('click', () => navigate('/okta'));
  continueBtn.addEventListener('click', () => { syncStore(); navigate('/review'); });

  recompute();
}
