// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Generate SSO Configuration - Step 1 (Set up Okta).
// Walks the operator through creating the Okta SAML application using
// Okta-documented procedures, then collects the IdP metadata XML the
// operator downloads from Okta. Subsequent steps need the parsed metadata
// (Entity ID, Login URL, signing certificate) so this step is the gating
// entry point.

import { h, titleBar } from '../../../lib/dom.js';
import { parseIdpMetadata } from '../../../lib/saml-metadata.js';

const TOOL_NAME = 'Generate SSO Configuration';

export function ssoBreadcrumbs(active) {
  const steps = [
    { id: 'okta', label: '1. Set up Okta' },
    { id: 'fortimonitor', label: '2. Configure FortiMonitor' },
    { id: 'review', label: '3. Review' },
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
  frame.appendChild(titleBar('Set up Okta', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    ssoBreadcrumbs('okta'),
    h('h2', {}, 'Step 1: Create the Okta SAML application'),
    h('p', {}, 'Follow the steps below in your Okta admin console (in another tab). When you finish, download the Identity Provider metadata XML and paste it at the bottom of this page. The wizard will extract the values FortiMonitor needs and carry them into Step 2.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ---- Walkthrough: substantively informative, based on Okta's docs ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Walkthrough'));

  const ol = h('ol', { class: 'walkthrough-steps' });
  ol.appendChild(h('li', {},
    h('strong', {}, 'Sign in to your Okta admin console'),
    ' as a user with permission to create applications. Open the admin URL (typically ',
    h('code', {}, 'https://<your-org>.okta.com/admin'),
    ').'
  ));
  ol.appendChild(h('li', {},
    'Go to ', h('strong', {}, 'Applications'), ' -> ', h('strong', {}, 'Applications'),
    ' -> ', h('strong', {}, 'Create App Integration'), '.'
  ));
  ol.appendChild(h('li', {},
    'Pick ', h('strong', {}, 'SAML 2.0'), ' and click ', h('strong', {}, 'Next'), '.'
  ));
  ol.appendChild(h('li', {},
    'Set the app name to ', h('code', {}, 'FortiMonitor'),
    ' (or any descriptive name). Optionally upload an app logo. Click ', h('strong', {}, 'Next'), '.'
  ));
  ol.appendChild(h('li', {},
    h('strong', {}, 'SAML Settings'), ' - fill in ',
    h('strong', {}, 'placeholder'), ' values for now. You will replace them in Step 4 once FortiMonitor surfaces its real SP-side values:',
    h('ul', { class: 'walkthrough-sublist' },
      h('li', {}, 'Single sign on URL: ', h('code', {}, 'https://placeholder.example/acs')),
      h('li', {}, 'Check ', h('strong', {}, 'Use this for Recipient URL and Destination URL'), '.'),
      h('li', {}, 'Audience URI (SP Entity ID): ', h('code', {}, 'https://placeholder.example')),
      h('li', {}, 'Name ID format: ', h('strong', {}, 'EmailAddress'), '.'),
      h('li', {}, 'Application username: ', h('strong', {}, 'Email'), '.')
    )
  ));
  ol.appendChild(h('li', {},
    h('strong', {}, 'Attribute Statements'), ' - add at minimum:',
    h('ul', { class: 'walkthrough-sublist' },
      h('li', {}, 'Name: ', h('code', {}, 'email'), ', Format: Basic, Value: ', h('code', {}, 'user.email')),
      h('li', {}, '(Optional) ', h('code', {}, 'firstName'), ' = ', h('code', {}, 'user.firstName'), ', ',
        h('code', {}, 'lastName'), ' = ', h('code', {}, 'user.lastName'), '.')
    )
  ));
  ol.appendChild(h('li', {},
    h('strong', {}, 'Group Attribute Statements'),
    ' - add one if you plan to use SAML-driven role mapping in FortiMonitor (you will configure those mappings in Step 2). For now, name it whatever your role-defining attribute should be (e.g. ', h('code', {}, 'admin_group'),
    ') with Filter ', h('strong', {}, 'Matches regex'), ' and a value placeholder you will tighten in Step 4. You can also add it later.'
  ));
  ol.appendChild(h('li', {},
    'Click ', h('strong', {}, 'Next'), ', then ', h('strong', {}, 'Finish'), ' to save the app.'
  ));
  ol.appendChild(h('li', {},
    'On the new app\'s ', h('strong', {}, 'Sign On'), ' tab, click ',
    h('strong', {}, 'View SAML setup instructions'),
    ' (or the equivalent metadata-download link). Save the ',
    h('strong', {}, 'Identity Provider metadata XML'), ' file.'
  ));
  ol.appendChild(h('li', {},
    'On the ', h('strong', {}, 'Assignments'),
    ' tab, assign the users (or groups of users) who should be able to sign in to FortiMonitor.'
  ));
  body.appendChild(ol);

  body.appendChild(h('p', { class: 'help-text' },
    h('a', {
      href: 'https://help.okta.com/oag/en-us/content/topics/access-gateway/add-app-saml-pass-thru-add.htm',
      target: '_blank', rel: 'noopener'
    }, 'Okta\'s official "Configure a SAML App Integration" docs'),
    ' have screenshots and a deeper reference if any of the above is unclear.'
  ));

  // ---- Paste field ----
  body.appendChild(h('h3', { class: 'subhead' }, 'Paste the IdP metadata XML'));
  body.appendChild(h('p', { class: 'help-text' },
    'When the Okta SAML app is saved and you have downloaded the Identity Provider metadata XML, paste its contents here. The wizard extracts the Entity ID, Login URL, and signing certificate that go into FortiMonitor in Step 2.'
  ));

  const idpPaste = h('textarea', {
    class: 'paste-area',
    rows: 10,
    spellcheck: 'false',
    placeholder: '<?xml version="1.0" encoding="UTF-8"?>\n<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="...">\n  <md:IDPSSODescriptor ...>\n    ...\n  </md:IDPSSODescriptor>\n</md:EntityDescriptor>'
  });
  idpPaste.value = store.idpMetadataXml;
  body.appendChild(idpPaste);

  const parseStatus = h('div', { class: 'parse-result empty' });
  body.appendChild(parseStatus);

  // ---- Footer ----
  const continueBtn = h('button', { class: 'btn primary', disabled: true }, 'Continue to FortiMonitor');
  const footer = h('div', { class: 'step-footer' }, continueBtn);
  frame.appendChild(footer);
  container.appendChild(frame);

  // ---- Wiring ----
  function reparseMetadata() {
    const xml = idpPaste.value;
    store.idpMetadataXml = xml;
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
        h('strong', {}, 'Okta IdP metadata parsed - ready for Step 2'),
        h('div', {}, 'Entity ID: ', h('code', {}, store.idpParsed.issuer)),
        h('div', {}, 'Login URL (HTTP-POST): ', h('code', {}, store.idpParsed.ssoUrlPost || '(none)')),
        h('div', {}, 'Signing certificate: ', h('code', {}, store.idpParsed.x509Cert.slice(0, 32) + '... (' + store.idpParsed.x509Cert.length + ' chars)'))
      ));
    } catch (err) {
      store.idpParsed = null;
      store.idpParseError = err.message || String(err);
      parseStatus.className = 'parse-result error';
      parseStatus.textContent = store.idpParseError;
    }
  }

  function recompute() {
    continueBtn.disabled = !(store.idpParsed && store.idpParsed.issuer && store.idpParsed.ssoUrlPost);
  }

  idpPaste.addEventListener('input', () => { reparseMetadata(); recompute(); });
  continueBtn.addEventListener('click', () => {
    if (!store.idpParsed) { reparseMetadata(); if (!store.idpParsed) return; }
    navigate('/fortimonitor');
  });

  if (store.idpMetadataXml) reparseMetadata();
  recompute();
}
