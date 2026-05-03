// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Unit tests for lib/sso-runbook.js (FMN-139).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOktaRunbook } from '../src/lib/sso-runbook.js';

const BASE = {
  spEntityId: 'https://acme.fortimonitor.com',
  acsUrl: 'https://acme.fortimonitor.com/saml/acs',
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  testLoginUrl: 'https://acme.fortimonitor.com/login'
};

test('buildOktaRunbook: rejects missing required inputs', () => {
  assert.throws(() => buildOktaRunbook({}), /spEntityId is required/);
  assert.throws(() => buildOktaRunbook({ spEntityId: 'x' }), /acsUrl is required/);
  assert.throws(() => buildOktaRunbook({ spEntityId: 'x', acsUrl: 'y' }), /nameIdFormat is required/);
});

test('buildOktaRunbook: emits all 7 numbered sections', () => {
  const md = buildOktaRunbook(BASE);
  assert.match(md, /^# Okta \+ FortiMonitor SSO setup runbook/);
  assert.match(md, /## 1\. Values to paste into Okta/);
  assert.match(md, /## 2\. Create the Okta SAML application/);
  assert.match(md, /## 3\. Attribute statements/);
  assert.match(md, /## 4\. Role mapping/);
  assert.match(md, /## 5\. SSO mode/);
  assert.match(md, /## 6\. Test the integration/);
  assert.match(md, /## 7\. Troubleshooting/);
});

test('buildOktaRunbook: SP values section includes entityID, ACS URL, NameID format', () => {
  const md = buildOktaRunbook(BASE);
  assert.match(md, /\| Audience URI \/ SP Entity ID \| `https:\/\/acme\.fortimonitor\.com` \|/);
  assert.match(md, /\| Single sign on URL \/ ACS URL \| `https:\/\/acme\.fortimonitor\.com\/saml\/acs` \|/);
  assert.match(md, /\| Name ID format \| `urn:oasis:names:tc:SAML:1\.1:nameid-format:emailAddress` \|/);
});

test('buildOktaRunbook: defaults attribute names to email/firstName/lastName/groups', () => {
  const md = buildOktaRunbook(BASE);
  assert.match(md, /\| `email` \| Basic \| `user\.email` \|/);
  assert.match(md, /\| `firstName` \| Basic \| `user\.firstName` \|/);
  assert.match(md, /\| `lastName` \| Basic \| `user\.lastName` \|/);
  assert.match(md, /\| `groups` \| Basic \| Matches regex/);
});

test('buildOktaRunbook: applies custom attribute names', () => {
  const md = buildOktaRunbook({
    ...BASE,
    attributes: { email: 'mail', firstName: 'givenName', lastName: 'sn', groups: 'memberOf' }
  });
  assert.match(md, /\| `mail` \| Basic \| `user\.email` \|/);
  assert.match(md, /\| `givenName` \| Basic \| `user\.firstName` \|/);
  assert.match(md, /\| `sn` \| Basic \| `user\.lastName` \|/);
  assert.match(md, /\| `memberOf` \| Basic \| Matches regex/);
});

test('buildOktaRunbook: role mapping section names default role', () => {
  const md = buildOktaRunbook({
    ...BASE,
    roleMapping: { defaultRole: 'Editor', overrides: [] }
  });
  assert.match(md, /By default every signed-in Okta user lands in FortiMonitor as \*\*Editor\*\*\./);
  assert.match(md, /No per-group overrides configured\./);
});

test('buildOktaRunbook: role mapping renders overrides as a table', () => {
  const md = buildOktaRunbook({
    ...BASE,
    roleMapping: {
      defaultRole: 'Read-Only',
      overrides: [
        { group: 'FortiMonitor-Admins', role: 'Admin' },
        { group: 'FortiMonitor-Editors', role: 'Editor' }
      ]
    }
  });
  assert.match(md, /\| `FortiMonitor-Admins` \| `Admin` \|/);
  assert.match(md, /\| `FortiMonitor-Editors` \| `Editor` \|/);
  assert.match(md, /Users not in any listed group fall back to \*\*Read-Only\*\*/);
});

test('buildOktaRunbook: SSO-only mode includes lockout warning', () => {
  const md = buildOktaRunbook({ ...BASE, ssoMode: 'sso-only' });
  assert.match(md, /\*\*SSO-only\.\*\* Local password login is disabled/);
  assert.match(md, /Lockout warning/);
});

test('buildOktaRunbook: SSO-with-password-fallback notes the cutover guidance', () => {
  const md = buildOktaRunbook({ ...BASE, ssoMode: 'sso-with-password-fallback' });
  assert.match(md, /\*\*SSO with password fallback\.\*\*/);
  assert.match(md, /Recommended during cutover/);
  assert.doesNotMatch(md, /Lockout warning/);
});

test('buildOktaRunbook: test section uses provided testLoginUrl', () => {
  const md = buildOktaRunbook(BASE);
  assert.match(md, /Open a private\/incognito window and visit: https:\/\/acme\.fortimonitor\.com\/login/);
});

test('buildOktaRunbook: test section falls back when no testLoginUrl is provided', () => {
  const md = buildOktaRunbook({ ...BASE, testLoginUrl: null });
  assert.match(md, /Open a private\/incognito window and visit your FortiMonitor login URL\./);
});

test('buildOktaRunbook: header includes tenant label when provided', () => {
  const md = buildOktaRunbook({ ...BASE, tenantLabel: 'Acme Production' });
  assert.match(md, /Tenant: \*\*Acme Production\*\*/);
});

test('buildOktaRunbook: header omits tenant line when no label provided', () => {
  const md = buildOktaRunbook(BASE);
  assert.doesNotMatch(md, /Tenant:/);
});

test('buildOktaRunbook: deterministic output for fixed inputs', () => {
  const inputs = {
    ...BASE,
    roleMapping: {
      defaultRole: 'Read-Only',
      overrides: [{ group: 'FortiMonitor-Admins', role: 'Admin' }]
    },
    attributes: { email: 'email', firstName: 'firstName', lastName: 'lastName', groups: 'groups' },
    ssoMode: 'sso-with-password-fallback',
    tenantLabel: 'Acme'
  };
  const a = buildOktaRunbook(inputs);
  const b = buildOktaRunbook(inputs);
  assert.equal(a, b);
});

test('buildOktaRunbook: troubleshooting section references the ACS URL', () => {
  const md = buildOktaRunbook(BASE);
  assert.match(md, /POST to `https:\/\/acme\.fortimonitor\.com\/saml\/acs`/);
});

test('buildOktaRunbook: SSO-only mode adds extra cross-browser test step', () => {
  const md = buildOktaRunbook({ ...BASE, ssoMode: 'sso-only' });
  assert.match(md, /re-test from a different browser profile/);
});
