// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Unit tests for lib/saml-metadata.js (FMN-139).
// extractIdpMetadata is tested via a hand-rolled Document mock so the
// suite stays dep-free. The full parseIdpMetadata round-trip (DOMParser
// -> extractIdpMetadata) is exercised in Playwright e2e (FMN-140).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractIdpMetadata,
  generateSpMetadata,
  SAML
} from '../src/lib/saml-metadata.js';

// ---------- minimal Document factory for tests ----------
//
// SAML metadata access pattern in extractIdpMetadata is narrow:
//   doc.documentElement
//   element.localName, element.getAttribute(name)
//   element.getElementsByTagNameNS(ns, localName) -> array-like
//   element.textContent
// Build a tree literally; no XML string needed.

const SAML_MD_NS = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';

function makeElement({ ns, localName, attrs = {}, text = '', children = [] }) {
  const node = {
    namespaceURI: ns,
    localName,
    attrs: { ...attrs },
    children: [],
    textContent: text,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    getElementsByTagNameNS(targetNs, targetLocalName) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.namespaceURI === targetNs && c.localName === targetLocalName) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
  };
  for (const child of children) {
    node.children.push(child);
  }
  return node;
}

function makeDoc(rootElement) {
  return {
    documentElement: rootElement,
    getElementsByTagName(_name) { return []; }
  };
}

function buildOktaIdpDoc(overrides = {}) {
  const opts = {
    entityID: 'http://www.okta.com/exk1abcdEFGHIJK0L1m2',
    ssoPostUrl: 'https://example.okta.com/app/example_fortimonitor_1/exk1abcdEFGHIJK0L1m2/sso/saml',
    ssoRedirectUrl: null,
    cert: 'MIIDqDCCApCgAwIBAgIGAYpHFAKEcert==',
    keyUseAttr: 'signing',
    nameIdFormats: [SAML.NAMEID_EMAIL, SAML.NAMEID_UNSPECIFIED],
    omitIdpDescriptor: false,
    omitSsoServices: false,
    omitKeyDescriptor: false,
    omitX509Cert: false,
    ...overrides
  };

  const ssoServices = [];
  if (opts.ssoPostUrl) {
    ssoServices.push(makeElement({
      ns: SAML_MD_NS,
      localName: 'SingleSignOnService',
      attrs: { Binding: SAML.HTTP_POST_BINDING, Location: opts.ssoPostUrl }
    }));
  }
  if (opts.ssoRedirectUrl) {
    ssoServices.push(makeElement({
      ns: SAML_MD_NS,
      localName: 'SingleSignOnService',
      attrs: { Binding: SAML.HTTP_REDIRECT_BINDING, Location: opts.ssoRedirectUrl }
    }));
  }

  const keyChildren = [];
  if (!opts.omitX509Cert) {
    const x509 = makeElement({
      ns: DS_NS, localName: 'X509Certificate', text: opts.cert
    });
    const x509Data = makeElement({
      ns: DS_NS, localName: 'X509Data', children: [x509]
    });
    const keyInfo = makeElement({
      ns: DS_NS, localName: 'KeyInfo', children: [x509Data]
    });
    keyChildren.push(keyInfo);
  }
  const keyDescriptor = makeElement({
    ns: SAML_MD_NS,
    localName: 'KeyDescriptor',
    attrs: opts.keyUseAttr ? { use: opts.keyUseAttr } : {},
    children: keyChildren
  });

  const idpChildren = [];
  if (!opts.omitKeyDescriptor) idpChildren.push(keyDescriptor);
  for (const fmt of opts.nameIdFormats) {
    idpChildren.push(makeElement({
      ns: SAML_MD_NS, localName: 'NameIDFormat', text: fmt
    }));
  }
  if (!opts.omitSsoServices) {
    for (const svc of ssoServices) idpChildren.push(svc);
  }

  const idp = makeElement({
    ns: SAML_MD_NS,
    localName: 'IDPSSODescriptor',
    attrs: { protocolSupportEnumeration: 'urn:oasis:names:tc:SAML:2.0:protocol' },
    children: idpChildren
  });

  const root = makeElement({
    ns: SAML_MD_NS,
    localName: 'EntityDescriptor',
    attrs: { entityID: opts.entityID },
    children: opts.omitIdpDescriptor ? [] : [idp]
  });

  return makeDoc(root);
}

// ---------- extractIdpMetadata: happy path ----------

test('extractIdpMetadata: extracts issuer, SSO URL, cert, NameID formats', () => {
  const doc = buildOktaIdpDoc();
  const md = extractIdpMetadata(doc);
  assert.equal(md.issuer, 'http://www.okta.com/exk1abcdEFGHIJK0L1m2');
  assert.equal(md.ssoUrlPost, 'https://example.okta.com/app/example_fortimonitor_1/exk1abcdEFGHIJK0L1m2/sso/saml');
  assert.equal(md.ssoUrlRedirect, null);
  assert.equal(md.x509Cert, 'MIIDqDCCApCgAwIBAgIGAYpHFAKEcert==');
  assert.deepEqual(md.nameIdFormats, [SAML.NAMEID_EMAIL, SAML.NAMEID_UNSPECIFIED]);
});

test('extractIdpMetadata: strips whitespace from cert (line wrapping is common)', () => {
  const doc = buildOktaIdpDoc({
    cert: '\n      MIIDqDCC ApCgAwIBAgIG\n      AYpHFAKEcert==\n    '
  });
  const md = extractIdpMetadata(doc);
  assert.equal(md.x509Cert, 'MIIDqDCCApCgAwIBAgIGAYpHFAKEcert==');
});

test('extractIdpMetadata: prefers explicit use=signing KeyDescriptor', () => {
  // Build a doc with two KeyDescriptors: encryption first, signing second.
  // Parser must pick the signing one regardless of order.
  const doc = buildOktaIdpDoc();
  const idp = doc.documentElement.children[0];
  const signingCert = makeElement({ ns: DS_NS, localName: 'X509Certificate', text: 'SIGNING_CERT' });
  const signingX509Data = makeElement({ ns: DS_NS, localName: 'X509Data', children: [signingCert] });
  const signingKeyInfo = makeElement({ ns: DS_NS, localName: 'KeyInfo', children: [signingX509Data] });
  const encCert = makeElement({ ns: DS_NS, localName: 'X509Certificate', text: 'ENC_CERT' });
  const encX509Data = makeElement({ ns: DS_NS, localName: 'X509Data', children: [encCert] });
  const encKeyInfo = makeElement({ ns: DS_NS, localName: 'KeyInfo', children: [encX509Data] });
  idp.children.length = 0;
  idp.children.push(makeElement({
    ns: SAML_MD_NS, localName: 'KeyDescriptor', attrs: { use: 'encryption' }, children: [encKeyInfo]
  }));
  idp.children.push(makeElement({
    ns: SAML_MD_NS, localName: 'KeyDescriptor', attrs: { use: 'signing' }, children: [signingKeyInfo]
  }));
  idp.children.push(makeElement({
    ns: SAML_MD_NS, localName: 'SingleSignOnService',
    attrs: { Binding: SAML.HTTP_POST_BINDING, Location: 'https://example.okta.com/sso' }
  }));
  const md = extractIdpMetadata(doc);
  assert.equal(md.x509Cert, 'SIGNING_CERT');
});

test('extractIdpMetadata: falls back to KeyDescriptor without use= when no explicit signing', () => {
  const doc = buildOktaIdpDoc({ keyUseAttr: null });
  const md = extractIdpMetadata(doc);
  assert.equal(md.x509Cert, 'MIIDqDCCApCgAwIBAgIGAYpHFAKEcert==');
});

test('extractIdpMetadata: captures both POST and Redirect bindings when both present', () => {
  const doc = buildOktaIdpDoc({
    ssoRedirectUrl: 'https://example.okta.com/app/example/sso/saml/redirect'
  });
  const md = extractIdpMetadata(doc);
  assert.equal(md.ssoUrlPost, 'https://example.okta.com/app/example_fortimonitor_1/exk1abcdEFGHIJK0L1m2/sso/saml');
  assert.equal(md.ssoUrlRedirect, 'https://example.okta.com/app/example/sso/saml/redirect');
});

// ---------- extractIdpMetadata: error paths ----------

test('extractIdpMetadata: rejects non-EntityDescriptor root', () => {
  const root = makeElement({ ns: SAML_MD_NS, localName: 'NotEntityDescriptor', attrs: {} });
  assert.throws(() => extractIdpMetadata(makeDoc(root)), /root is not <EntityDescriptor>/);
});

test('extractIdpMetadata: rejects missing entityID attribute', () => {
  const root = makeElement({ ns: SAML_MD_NS, localName: 'EntityDescriptor', attrs: {} });
  assert.throws(() => extractIdpMetadata(makeDoc(root)), /missing the entityID attribute/);
});

test('extractIdpMetadata: rejects missing IDPSSODescriptor', () => {
  const doc = buildOktaIdpDoc({ omitIdpDescriptor: true });
  assert.throws(() => extractIdpMetadata(doc), /missing <IDPSSODescriptor>/);
});

test('extractIdpMetadata: rejects no SingleSignOnService bindings', () => {
  const doc = buildOktaIdpDoc({ omitSsoServices: true });
  assert.throws(() => extractIdpMetadata(doc), /no <SingleSignOnService> bindings/);
});

test('extractIdpMetadata: rejects unsupported-only bindings', () => {
  // Build a doc with only SOAP binding, neither POST nor Redirect.
  const doc = buildOktaIdpDoc({ ssoPostUrl: null, ssoRedirectUrl: null });
  const idp = doc.documentElement.children[0];
  idp.children.push(makeElement({
    ns: SAML_MD_NS, localName: 'SingleSignOnService',
    attrs: { Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:SOAP', Location: 'https://example.okta.com/sso/soap' }
  }));
  assert.throws(() => extractIdpMetadata(doc), /no HTTP-POST or HTTP-Redirect/);
});

test('extractIdpMetadata: rejects missing KeyDescriptor', () => {
  const doc = buildOktaIdpDoc({ omitKeyDescriptor: true });
  assert.throws(() => extractIdpMetadata(doc), /no <KeyDescriptor> usable for signing/);
});

test('extractIdpMetadata: rejects missing X509Certificate', () => {
  const doc = buildOktaIdpDoc({ omitX509Cert: true });
  assert.throws(() => extractIdpMetadata(doc), /no <ds:X509Certificate>/);
});

test('extractIdpMetadata: rejects empty X509Certificate text', () => {
  const doc = buildOktaIdpDoc({ cert: '   \n  \t  ' });
  assert.throws(() => extractIdpMetadata(doc), /signing certificate is empty/);
});

// ---------- generateSpMetadata ----------

test('generateSpMetadata: emits a well-formed minimal document', () => {
  const xml = generateSpMetadata({
    entityId: 'https://acme.fortimonitor.com',
    acsUrl: 'https://acme.fortimonitor.com/saml/acs'
  });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n/);
  assert.match(xml, /<md:EntityDescriptor[^>]*entityID="https:\/\/acme.fortimonitor.com"/);
  assert.match(xml, /xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"/);
  assert.match(xml, /<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https:\/\/acme.fortimonitor.com\/saml\/acs" index="0" isDefault="true"\/>/);
  assert.match(xml, /WantAssertionsSigned="true"/);
  assert.match(xml, /<md:NameIDFormat>urn:oasis:names:tc:SAML:1\.1:nameid-format:emailAddress<\/md:NameIDFormat>/);
});

test('generateSpMetadata: respects wantSignedAssertions=false', () => {
  const xml = generateSpMetadata({
    entityId: 'https://acme.fortimonitor.com',
    acsUrl: 'https://acme.fortimonitor.com/saml/acs',
    wantSignedAssertions: false
  });
  assert.match(xml, /WantAssertionsSigned="false"/);
});

test('generateSpMetadata: escapes XML-significant characters in inputs', () => {
  const xml = generateSpMetadata({
    entityId: 'https://acme.com/?team=R&D&dept="ops"',
    acsUrl: 'https://acme.com/saml/acs?dest=<all>'
  });
  assert.match(xml, /entityID="https:\/\/acme\.com\/\?team=R&amp;D&amp;dept=&quot;ops&quot;"/);
  assert.match(xml, /Location="https:\/\/acme\.com\/saml\/acs\?dest=&lt;all&gt;"/);
});

test('generateSpMetadata: includes Organization block when provided', () => {
  const xml = generateSpMetadata({
    entityId: 'https://acme.fortimonitor.com',
    acsUrl: 'https://acme.fortimonitor.com/saml/acs',
    organization: { name: 'Acme', displayName: 'Acme Inc.', url: 'https://acme.com' }
  });
  assert.match(xml, /<md:Organization>/);
  assert.match(xml, /<md:OrganizationName xml:lang="en">Acme<\/md:OrganizationName>/);
  assert.match(xml, /<md:OrganizationDisplayName xml:lang="en">Acme Inc\.<\/md:OrganizationDisplayName>/);
  assert.match(xml, /<md:OrganizationURL xml:lang="en">https:\/\/acme\.com<\/md:OrganizationURL>/);
});

test('generateSpMetadata: includes ContactPerson block when email is provided', () => {
  const xml = generateSpMetadata({
    entityId: 'https://acme.fortimonitor.com',
    acsUrl: 'https://acme.fortimonitor.com/saml/acs',
    contact: { name: 'Jane Q Public', email: 'jane@acme.com' }
  });
  assert.match(xml, /<md:ContactPerson contactType="technical">/);
  assert.match(xml, /<md:GivenName>Jane<\/md:GivenName>/);
  assert.match(xml, /<md:SurName>Q Public<\/md:SurName>/);
  assert.match(xml, /<md:EmailAddress>jane@acme\.com<\/md:EmailAddress>/);
});

test('generateSpMetadata: rejects missing entityId', () => {
  assert.throws(() => generateSpMetadata({ acsUrl: 'https://x' }), /entityId is required/);
});

test('generateSpMetadata: rejects missing acsUrl', () => {
  assert.throws(() => generateSpMetadata({ entityId: 'https://x' }), /acsUrl is required/);
});

test('generateSpMetadata: rejects non-http acsUrl', () => {
  assert.throws(() => generateSpMetadata({
    entityId: 'https://x',
    acsUrl: 'javascript:alert(1)'
  }), /must be an absolute http\(s\) URL/);
});

test('generateSpMetadata: deterministic output for fixed inputs', () => {
  const inputs = {
    entityId: 'https://acme.fortimonitor.com',
    acsUrl: 'https://acme.fortimonitor.com/saml/acs',
    nameIdFormat: SAML.NAMEID_EMAIL,
    organization: { name: 'Acme' }
  };
  const a = generateSpMetadata(inputs);
  const b = generateSpMetadata(inputs);
  assert.equal(a, b);
});

test('generateSpMetadata: applies non-default nameIdFormat', () => {
  const xml = generateSpMetadata({
    entityId: 'https://acme.fortimonitor.com',
    acsUrl: 'https://acme.fortimonitor.com/saml/acs',
    nameIdFormat: SAML.NAMEID_PERSISTENT
  });
  assert.match(xml, /<md:NameIDFormat>urn:oasis:names:tc:SAML:2\.0:nameid-format:persistent<\/md:NameIDFormat>/);
});
