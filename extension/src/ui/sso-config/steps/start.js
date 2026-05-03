// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SSO Configuration - Step 1 (Start).
// Operator pastes Okta IdP metadata XML, fills in FortiMonitor SP-side
// fields (entity ID, ACS URL), and configures attribute statement names,
// role mapping, and SSO mode.

import { h, titleBar } from '../../../lib/dom.js';
import { parseIdpMetadata, SAML } from '../../../lib/saml-metadata.js';

const TOOL_NAME = 'SSO Configuration (Okta IdP)';

const ROLE_SUGGESTIONS = ['Read-Only', 'Editor', 'Admin'];
const NAMEID_OPTIONS = [
  { label: 'EmailAddress (recommended)', value: SAML.NAMEID_EMAIL },
  { label: 'Unspecified', value: SAML.NAMEID_UNSPECIFIED },
  { label: 'Persistent', value: SAML.NAMEID_PERSISTENT }
];

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
    { id: 'execute', label: '3. Execute' },
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
    h('h2', {}, 'Build your SSO configuration'),
    h('p', {}, 'Paste your Okta IdP metadata XML and fill in the FortiMonitor side. The plugin will assemble the SP entity ID, ACS URL, attribute statements, and role mapping you can paste into Okta, plus a downloadable SP metadata XML for one-shot import.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const continueBtn = h('button', { class: 'btn primary', disabled: true }, 'Continue to Review');

  // ---- FortiMonitor SP-side ----
  body.appendChild(h('h3', { class: 'subhead' }, 'FortiMonitor (Service Provider)'));

  const spEntityIdInput = h('input', {
    type: 'text',
    placeholder: 'https://acme.fortimonitor.com',
    spellcheck: 'false',
    autocomplete: 'off'
  });
  spEntityIdInput.value = store.spEntityId;
  body.appendChild(labeledRow('SP Entity ID / Audience URI', spEntityIdInput,
    'Typically your FortiMonitor base URL. Sent to Okta as the audience the SAML assertion is intended for.'));

  const acsUrlInput = h('input', {
    type: 'text',
    placeholder: 'https://acme.fortimonitor.com/saml/acs',
    spellcheck: 'false',
    autocomplete: 'off'
  });
  acsUrlInput.value = store.acsUrl;
  body.appendChild(labeledRow('Assertion Consumer Service (ACS) URL', acsUrlInput,
    'Where Okta POSTs the signed SAML assertion after authentication. Captured during Discovery (FMN-138); for now, paste the value FortiMonitor advertises in its SSO admin UI.'));

  const testLoginUrlInput = h('input', {
    type: 'text',
    placeholder: 'https://acme.fortimonitor.com/login',
    spellcheck: 'false',
    autocomplete: 'off'
  });
  testLoginUrlInput.value = store.testLoginUrl;
  body.appendChild(labeledRow('Test login URL (optional)', testLoginUrlInput,
    'Included in the runbook as the link operators visit to verify the integration.'));

  const tenantLabelInput = h('input', {
    type: 'text',
    placeholder: 'Acme Production',
    spellcheck: 'false'
  });
  tenantLabelInput.value = store.tenantLabel;
  body.appendChild(labeledRow('Tenant label (optional)', tenantLabelInput,
    'Friendly name shown in the runbook header. Display only.'));

  const nameIdSelect = h('select', {});
  for (const opt of NAMEID_OPTIONS) {
    const o = h('option', { value: opt.value }, opt.label);
    if (opt.value === store.nameIdFormat) o.selected = true;
    nameIdSelect.appendChild(o);
  }
  body.appendChild(labeledRow('Name ID format', nameIdSelect,
    'Most Okta tenants use EmailAddress. Change only if FortiMonitor expects a different NameID shape.'));

  // ---- Okta IdP metadata paste ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Okta (Identity Provider)'));

  const idpPaste = h('textarea', {
    class: 'paste-area',
    rows: 8,
    spellcheck: 'false',
    placeholder: 'Paste the IdP metadata XML you downloaded from your Okta SAML app (Sign On tab -> "View Setup Instructions" -> Identity Provider metadata).'
  });
  idpPaste.value = store.idpMetadataXml;
  body.appendChild(idpPaste);

  const parseStatus = h('div', { class: 'parse-result empty' });
  body.appendChild(parseStatus);

  // ---- Attribute statement names ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Attribute statements'));
  body.appendChild(h('p', { class: 'help-text' },
    'Names Okta sends in the SAML assertion. Defaults match the typical Okta + FortiMonitor convention; change only if your tenant standard differs.'));

  const attrEmailInput = h('input', { type: 'text', spellcheck: 'false' });
  attrEmailInput.value = store.attributes.email;
  const attrFirstInput = h('input', { type: 'text', spellcheck: 'false' });
  attrFirstInput.value = store.attributes.firstName;
  const attrLastInput = h('input', { type: 'text', spellcheck: 'false' });
  attrLastInput.value = store.attributes.lastName;
  const attrGroupsInput = h('input', { type: 'text', spellcheck: 'false' });
  attrGroupsInput.value = store.attributes.groups;

  const attrGrid = h('div', { class: 'attr-grid' });
  attrGrid.appendChild(labeledRow('email', attrEmailInput));
  attrGrid.appendChild(labeledRow('firstName', attrFirstInput));
  attrGrid.appendChild(labeledRow('lastName', attrLastInput));
  attrGrid.appendChild(labeledRow('groups', attrGroupsInput));
  body.appendChild(attrGrid);

  // ---- Role mapping ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Role mapping'));

  const defaultRoleInput = h('input', {
    type: 'text', list: 'role-suggestions', spellcheck: 'false'
  });
  defaultRoleInput.value = store.roleMapping.defaultRole;
  const roleDatalist = h('datalist', { id: 'role-suggestions' });
  for (const r of ROLE_SUGGESTIONS) roleDatalist.appendChild(h('option', { value: r }));
  body.appendChild(roleDatalist);
  body.appendChild(labeledRow('Default role', defaultRoleInput,
    'Role assigned to any signed-in Okta user not matched by a group override below. Free text; specific role values supported by your FortiMonitor tenant get verified during Discovery (FMN-138).'));

  const overridesContainer = h('div', { class: 'overrides-list' });
  body.appendChild(overridesContainer);
  body.appendChild(h('button', {
    class: 'btn',
    type: 'button',
    onClick: () => addOverrideRow({ group: '', role: '' })
  }, '+ Add group override'));

  function renderOverrides() {
    overridesContainer.innerHTML = '';
    if (!store.roleMapping.overrides.length) {
      overridesContainer.appendChild(h('p', { class: 'help-text' },
        'No group overrides yet. Add one to map an Okta group to a non-default FortiMonitor role.'));
      return;
    }
    for (let i = 0; i < store.roleMapping.overrides.length; i += 1) {
      const o = store.roleMapping.overrides[i];
      const groupInput = h('input', {
        type: 'text', placeholder: 'FortiMonitor-Admins', spellcheck: 'false'
      });
      groupInput.value = o.group;
      groupInput.addEventListener('input', () => {
        store.roleMapping.overrides[i].group = groupInput.value.trim();
        recomputeContinue();
      });
      const roleInput = h('input', {
        type: 'text', list: 'role-suggestions', spellcheck: 'false'
      });
      roleInput.value = o.role;
      roleInput.addEventListener('input', () => {
        store.roleMapping.overrides[i].role = roleInput.value.trim();
        recomputeContinue();
      });
      const removeBtn = h('button', {
        class: 'btn', type: 'button', title: 'Remove this override',
        onClick: () => {
          store.roleMapping.overrides.splice(i, 1);
          renderOverrides();
          recomputeContinue();
        }
      }, '×');
      overridesContainer.appendChild(h('div', { class: 'override-row' },
        groupInput, roleInput, removeBtn
      ));
    }
  }
  function addOverrideRow(seed) {
    store.roleMapping.overrides.push({ group: seed.group, role: seed.role });
    renderOverrides();
    recomputeContinue();
  }
  renderOverrides();

  // ---- SSO mode ----
  body.appendChild(h('h3', { class: 'subhead' }, 'SSO mode'));
  const modeFallback = h('input', {
    type: 'radio', name: 'sso-mode', value: 'sso-with-password-fallback'
  });
  if (store.ssoMode === 'sso-with-password-fallback') modeFallback.checked = true;
  const modeOnly = h('input', {
    type: 'radio', name: 'sso-mode', value: 'sso-only'
  });
  if (store.ssoMode === 'sso-only') modeOnly.checked = true;
  body.appendChild(h('label', { class: 'radio-row' }, modeFallback,
    h('span', {}, h('strong', {}, 'SSO with password fallback'),
      ' (recommended during cutover; users can sign in with Okta or local password)')));
  body.appendChild(h('label', { class: 'radio-row' }, modeOnly,
    h('span', {}, h('strong', {}, 'SSO-only'),
      ' (local passwords disabled; verify end-to-end before enabling)')));

  // ---- Footer ----
  const footer = h('div', { class: 'step-footer' }, continueBtn);
  frame.appendChild(footer);
  container.appendChild(frame);

  // ---- Wiring ----
  function syncStore() {
    store.spEntityId = spEntityIdInput.value.trim();
    store.acsUrl = acsUrlInput.value.trim();
    store.testLoginUrl = testLoginUrlInput.value.trim();
    store.tenantLabel = tenantLabelInput.value.trim();
    store.nameIdFormat = nameIdSelect.value;
    store.idpMetadataXml = idpPaste.value;
    store.attributes = {
      email: attrEmailInput.value.trim() || 'email',
      firstName: attrFirstInput.value.trim() || 'firstName',
      lastName: attrLastInput.value.trim() || 'lastName',
      groups: attrGroupsInput.value.trim() || 'groups'
    };
    store.roleMapping = {
      defaultRole: defaultRoleInput.value.trim() || 'Read-Only',
      overrides: store.roleMapping.overrides.filter((o) => o.group && o.role)
    };
    store.ssoMode = modeOnly.checked ? 'sso-only' : 'sso-with-password-fallback';
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
        h('div', {}, 'Issuer: ', h('code', {}, store.idpParsed.issuer)),
        h('div', {}, 'SSO URL (POST): ', h('code', {}, store.idpParsed.ssoUrlPost || '(none)')),
        h('div', {}, 'Signing cert: ', h('code', {}, store.idpParsed.x509Cert.slice(0, 32) + '... (' + store.idpParsed.x509Cert.length + ' chars)')),
        h('div', {}, 'NameID formats: ', h('code', {}, store.idpParsed.nameIdFormats.join(', ') || '(none)'))
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
    const ok = !!store.spEntityId
      && !!store.acsUrl
      && !!store.idpParsed
      && /^https?:\/\//i.test(store.acsUrl);
    continueBtn.disabled = !ok;
  }

  // Live wiring
  for (const el of [
    spEntityIdInput, acsUrlInput, testLoginUrlInput, tenantLabelInput,
    nameIdSelect, attrEmailInput, attrFirstInput, attrLastInput,
    attrGroupsInput, defaultRoleInput
  ]) {
    el.addEventListener('input', recomputeContinue);
    el.addEventListener('change', recomputeContinue);
  }
  modeFallback.addEventListener('change', recomputeContinue);
  modeOnly.addEventListener('change', recomputeContinue);
  idpPaste.addEventListener('input', () => {
    reparseMetadata();
    recomputeContinue();
  });

  continueBtn.addEventListener('click', () => {
    syncStore();
    if (!store.idpParsed) {
      reparseMetadata();
      if (!store.idpParsed) return;
    }
    navigate('/review');
  });

  // First render: parse if there's already pasted XML, sync derived state.
  if (store.idpMetadataXml) reparseMetadata();
  recomputeContinue();
}
