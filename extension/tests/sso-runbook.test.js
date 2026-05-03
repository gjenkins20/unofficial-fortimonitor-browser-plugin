// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Unit tests for lib/sso-runbook.js (FMN-139).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSsoRunbook } from '../src/lib/sso-runbook.js';

const BASE = {
  fortimonitorBaseUrl: 'https://my.us01.fortimonitor.com',
  urlFragment: 'okta',
  domains: ['@acme.com'],
  usernameField: 'email',
  loginBinding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
  idp: {
    issuer: 'http://www.okta.com/exk1abcdEFGHIJK0L1m2',
    ssoUrlPost: 'https://acme.okta.com/app/acme_fortimonitor/exk1abcdEFGHIJK0L1m2/sso/saml',
    x509Cert: 'MIIDqDCCApCgAwIBAgIGAYpHFAKEcert'
  },
  preventNonSsoLogins: false,
  autoCreateUsers: true,
  roleAssignmentMode: 'saml',
  roleMappings: [
    { samlField: 'admin_group', samlValue: 'fm_admins', fmRole: 'Dashboard Admin' },
    { samlField: 'user_group',  samlValue: 'fm_users',  fmRole: 'Dashboard Viewer' }
  ]
};

// ---------- Required-field validation ----------

test('buildSsoRunbook: rejects missing fortimonitorBaseUrl', () => {
  assert.throws(() => buildSsoRunbook({ ...BASE, fortimonitorBaseUrl: null }), /fortimonitorBaseUrl is required/);
});

test('buildSsoRunbook: rejects missing urlFragment', () => {
  assert.throws(() => buildSsoRunbook({ ...BASE, urlFragment: null }), /urlFragment is required/);
});

test('buildSsoRunbook: rejects missing idp.issuer', () => {
  assert.throws(() => buildSsoRunbook({ ...BASE, idp: { ...BASE.idp, issuer: null } }), /idp\.issuer is required/);
});

test('buildSsoRunbook: rejects missing idp.ssoUrlPost', () => {
  assert.throws(() => buildSsoRunbook({ ...BASE, idp: { ...BASE.idp, ssoUrlPost: null } }), /idp\.ssoUrlPost is required/);
});

test('buildSsoRunbook: rejects missing idp.x509Cert', () => {
  assert.throws(() => buildSsoRunbook({ ...BASE, idp: { ...BASE.idp, x509Cert: null } }), /idp\.x509Cert is required/);
});

// ---------- Section coverage ----------

test('buildSsoRunbook: emits all top-level sections in order', () => {
  const md = buildSsoRunbook(BASE);
  const headings = md.match(/^## .+$/gm) || [];
  assert.deepEqual(headings, [
    '## Overview',
    '## Pass 1: Create the Okta SAML application',
    '## Pass 2: Configure FortiMonitor SSO',
    '## Pass 3: Update Okta with FortiMonitor\'s SP-side values',
    '## Pass 4: Test the integration',
    '## Troubleshooting'
  ]);
});

test('buildSsoRunbook: header includes tenant label when provided', () => {
  const md = buildSsoRunbook({ ...BASE, tenantLabel: 'Acme Production' });
  assert.match(md, /Tenant: \*\*Acme Production\*\*/);
});

test('buildSsoRunbook: header omits tenant line when no label provided', () => {
  const md = buildSsoRunbook({ ...BASE, tenantLabel: null });
  assert.doesNotMatch(md, /^Tenant:/m);
});

test('buildSsoRunbook: derives the SSO login URL from base + urlFragment', () => {
  const md = buildSsoRunbook(BASE);
  assert.match(md, /Login URL after setup: `https:\/\/my\.us01\.fortimonitor\.com\/sso\/okta`/);
});

test('buildSsoRunbook: handles base URL with trailing slash without doubling', () => {
  const md = buildSsoRunbook({ ...BASE, fortimonitorBaseUrl: 'https://my.us01.fortimonitor.com/' });
  assert.match(md, /Login URL after setup: `https:\/\/my\.us01\.fortimonitor\.com\/sso\/okta`/);
});

// ---------- Pass 2 (FortiMonitor) field rendering ----------

test('Pass 2: renders the General table with all 8 fields', () => {
  const md = buildSsoRunbook(BASE);
  assert.match(md, /\| URL Fragment \| `okta` \|/);
  assert.match(md, /\| Domains \| @acme\.com \|/);
  assert.match(md, /\| Username Field \| `email` \|/);
  assert.match(md, /\| Entity ID \| `http:\/\/www\.okta\.com\/exk1abcdEFGHIJK0L1m2` \|/);
  assert.match(md, /\| Login URL \| `https:\/\/acme\.okta\.com\/app\/acme_fortimonitor\/exk1abcdEFGHIJK0L1m2\/sso\/saml` \|/);
  assert.match(md, /\| Login Binding \| `urn:oasis:names:tc:SAML:2\.0:bindings:HTTP-POST` \|/);
  assert.match(md, /\| Logout URL \| _\(blank\)_ \|/);
  assert.match(md, /\| Logout Binding \| _\(blank\)_ \|/);
});

test('Pass 2: shows logout URL + binding when supplied', () => {
  const md = buildSsoRunbook({
    ...BASE,
    logoutUrl: 'https://acme.okta.com/app/acme/exk1/slo/saml',
    logoutBinding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
  });
  assert.match(md, /\| Logout URL \| `https:\/\/acme\.okta\.com\/app\/acme\/exk1\/slo\/saml` \|/);
  assert.doesNotMatch(md, /\| Logout URL \| _\(blank\)_ \|/);
});

test('Pass 2: joins multiple domains with ", "', () => {
  const md = buildSsoRunbook({ ...BASE, domains: ['@acme.com', '@acme.net', '@acme.org'] });
  assert.match(md, /\| Domains \| @acme\.com, @acme\.net, @acme\.org \|/);
});

test('Pass 2: shows _(blank)_ when domains is empty', () => {
  const md = buildSsoRunbook({ ...BASE, domains: [] });
  assert.match(md, /\| Domains \| _\(blank\)_ \|/);
});

test('Pass 2: includes the X.509 certificate inside a fenced code block', () => {
  const md = buildSsoRunbook(BASE);
  assert.match(md, /```\nMIIDqDCCApCgAwIBAgIGAYpHFAKEcert\n```/);
});

test('Pass 2: User Configuration reflects preventNonSsoLogins=false with cutover note', () => {
  const md = buildSsoRunbook({ ...BASE, preventNonSsoLogins: false });
  assert.match(md, /\*\*Prevent non-SSO logins\*\*: unchecked/);
  assert.match(md, /Recommended during cutover/);
  assert.doesNotMatch(md, /Lockout warning/);
});

test('Pass 2: User Configuration reflects preventNonSsoLogins=true with lockout warning', () => {
  const md = buildSsoRunbook({ ...BASE, preventNonSsoLogins: true });
  assert.match(md, /\*\*Prevent non-SSO logins\*\*: \*\*checked\*\*/);
  assert.match(md, /Lockout warning/);
});

test('Pass 2: User Configuration explains autoCreateUsers=false', () => {
  const md = buildSsoRunbook({ ...BASE, autoCreateUsers: false });
  assert.match(md, /\*\*Auto Create Users\*\*: unchecked \(an admin must approve new users/);
});

test('Pass 2: SAML role mode renders one row per mapping', () => {
  const md = buildSsoRunbook(BASE);
  assert.match(md, /Assign roles based on SAML mapping/);
  assert.match(md, /\| `admin_group` \| `fm_admins` \| \*\*Dashboard Admin\*\* \|/);
  assert.match(md, /\| `user_group` \| `fm_users` \| \*\*Dashboard Viewer\*\* \|/);
});

test('Pass 2: manual role mode skips the mapping table', () => {
  const md = buildSsoRunbook({ ...BASE, roleAssignmentMode: 'manual', roleMappings: [] });
  assert.match(md, /Assign roles manually/);
  assert.doesNotMatch(md, /SAML Role Field \| SAML Role/);
});

test('Pass 2: SAML role mode with empty mappings notes the missing config', () => {
  const md = buildSsoRunbook({ ...BASE, roleAssignmentMode: 'saml', roleMappings: [] });
  assert.match(md, /No role mappings configured/);
});

// ---------- Pass 3 (Okta-side updates) rendering ----------

test('Pass 3: attribute statement table uses the configured usernameField', () => {
  const md = buildSsoRunbook({ ...BASE, usernameField: 'mail' });
  assert.match(md, /\| `mail` \| Basic \| `user\.email` \|/);
});

test('Pass 3: group attribute regex collapses to ^value$ for a single SAML field/value', () => {
  const md = buildSsoRunbook({
    ...BASE,
    roleMappings: [{ samlField: 'admin_group', samlValue: 'fm_admins', fmRole: 'Dashboard Admin' }]
  });
  assert.match(md, /\| `admin_group` \| Basic \| Matches regex: `\^fm_admins\$` \|/);
});

test('Pass 3: group attribute regex collapses to ^(a|b)$ when one field has multiple values', () => {
  const md = buildSsoRunbook({
    ...BASE,
    roleMappings: [
      { samlField: 'admin_group', samlValue: 'fm_admins',  fmRole: 'Dashboard Admin' },
      { samlField: 'admin_group', samlValue: 'fm_billing', fmRole: 'Billing Admin' }
    ]
  });
  assert.match(md, /\| `admin_group` \| Basic \| Matches regex: `\^\(fm_admins\|fm_billing\)\$` \|/);
});

test('Pass 3: emits one row per distinct SAML field across mappings', () => {
  const md = buildSsoRunbook(BASE);
  // Two distinct fields (admin_group, user_group) -> two rows.
  const matches = (md.match(/Matches regex: `[^`]+`/g) || []).length;
  assert.equal(matches, 2);
});

test('Pass 3: skips Group Attribute step when no role mappings', () => {
  const md = buildSsoRunbook({ ...BASE, roleAssignmentMode: 'manual', roleMappings: [] });
  assert.match(md, /No SAML role mappings were configured in Pass 2/);
  assert.doesNotMatch(md, /Group Attribute Statements/);
});

// ---------- Pass 4 (test) rendering ----------

test('Pass 4: visit URL is the SSO login URL', () => {
  const md = buildSsoRunbook(BASE);
  assert.match(md, /visit `https:\/\/my\.us01\.fortimonitor\.com\/sso\/okta`/);
});

test('Pass 4: notes manual role assignment when no mappings', () => {
  const md = buildSsoRunbook({ ...BASE, roleAssignmentMode: 'manual', roleMappings: [] });
  assert.match(md, /role assignment is manual; an admin must assign a role/);
});

test('Pass 4: with mappings, instructs operator to test one user per role', () => {
  const md = buildSsoRunbook(BASE);
  assert.match(md, /Repeat with one user per role mapping/);
});

// ---------- Troubleshooting + determinism ----------

test('Troubleshooting: references the SSO login URL', () => {
  const md = buildSsoRunbook(BASE);
  assert.match(md, /Login URL the user visits is `https:\/\/my\.us01\.fortimonitor\.com\/sso\/okta`/);
});

test('buildSsoRunbook: deterministic output for fixed inputs', () => {
  const a = buildSsoRunbook(BASE);
  const b = buildSsoRunbook(BASE);
  assert.equal(a, b);
});
