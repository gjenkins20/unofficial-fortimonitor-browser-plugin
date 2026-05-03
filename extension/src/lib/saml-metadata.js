// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SAML 2.0 metadata parsing and generation.
// Used by the SSO Configuration tool (FMN-139) to:
//   1. Extract IdP fields (issuer, SSO URL, X.509 cert, NameID formats) from
//      an Okta-issued IdP metadata XML so the user does not need to hand-paste
//      a multi-line cert into FortiMonitor.
//   2. Emit an SP metadata XML the user can import into Okta instead of
//      configuring entity ID, ACS URL, and NameID format field-by-field.
//
// The parser uses DOMParser (browser-native; available in extension page and
// service-worker contexts via the platform). The generator is pure string
// construction, no DOM needed.

const SAML_MD_NS = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';

const HTTP_POST_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const HTTP_REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const NAMEID_UNSPECIFIED = 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified';
const NAMEID_PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';

export const SAML = {
  HTTP_POST_BINDING,
  HTTP_REDIRECT_BINDING,
  NAMEID_EMAIL,
  NAMEID_UNSPECIFIED,
  NAMEID_PERSISTENT
};

/**
 * Parse an Okta-issued (or any SAML 2.0) IdP metadata XML string.
 * Returns { issuer, ssoUrlPost, ssoUrlRedirect, x509Cert, nameIdFormats }.
 * Throws Error with a clear message when the XML is malformed or missing
 * required fields.
 *
 * Browser-only. Service-worker contexts in MV3 do not have DOMParser; the
 * caller (extension page / popup) must invoke this and pass the result to
 * the service worker over chrome.runtime.sendMessage.
 */
export function parseIdpMetadata(xmlString) {
  if (typeof xmlString !== 'string' || !xmlString.trim()) {
    throw new Error('IdP metadata is empty.');
  }
  if (typeof DOMParser === 'undefined') {
    throw new Error('DOMParser is not available in this context. Call parseIdpMetadata from a page or popup, not the service worker.');
  }
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) {
    throw new Error('IdP metadata is not valid XML: ' + (parserError.textContent || '').trim());
  }
  return extractIdpMetadata(doc);
}

/**
 * DOM-level extraction. Exposed separately so tests can pass a Document
 * (or a minimal Document-like object) without going through DOMParser.
 */
export function extractIdpMetadata(doc) {
  const root = doc.documentElement;
  if (!root || root.localName !== 'EntityDescriptor') {
    throw new Error('IdP metadata root is not <EntityDescriptor>.');
  }
  const issuer = root.getAttribute('entityID');
  if (!issuer) {
    throw new Error('IdP metadata is missing the entityID attribute on <EntityDescriptor>.');
  }

  const idpDescriptor = firstByNS(root, SAML_MD_NS, 'IDPSSODescriptor');
  if (!idpDescriptor) {
    throw new Error('IdP metadata is missing <IDPSSODescriptor>.');
  }

  const ssoServices = allByNS(idpDescriptor, SAML_MD_NS, 'SingleSignOnService');
  if (!ssoServices.length) {
    throw new Error('IdP metadata has no <SingleSignOnService> bindings.');
  }
  const ssoUrlPost = pickBinding(ssoServices, HTTP_POST_BINDING);
  const ssoUrlRedirect = pickBinding(ssoServices, HTTP_REDIRECT_BINDING);
  if (!ssoUrlPost && !ssoUrlRedirect) {
    throw new Error('IdP metadata advertises no HTTP-POST or HTTP-Redirect SingleSignOnService binding.');
  }

  const signingKeyDescriptor = pickSigningKeyDescriptor(allByNS(idpDescriptor, SAML_MD_NS, 'KeyDescriptor'));
  if (!signingKeyDescriptor) {
    throw new Error('IdP metadata has no <KeyDescriptor> usable for signing.');
  }
  const certElem = firstByNS(signingKeyDescriptor, DS_NS, 'X509Certificate');
  if (!certElem) {
    throw new Error('IdP metadata signing <KeyDescriptor> has no <ds:X509Certificate>.');
  }
  const x509Cert = normalizeCert(textOf(certElem));
  if (!x509Cert) {
    throw new Error('IdP metadata signing certificate is empty.');
  }

  const nameIdFormats = allByNS(idpDescriptor, SAML_MD_NS, 'NameIDFormat')
    .map((el) => (textOf(el) || '').trim())
    .filter(Boolean);

  return { issuer, ssoUrlPost, ssoUrlRedirect, x509Cert, nameIdFormats };
}

function pickBinding(elements, binding) {
  for (const el of elements) {
    if (el.getAttribute('Binding') === binding) {
      const loc = el.getAttribute('Location');
      if (loc) return loc;
    }
  }
  return null;
}

function pickSigningKeyDescriptor(keyDescriptors) {
  // SAML allows use="signing", use="encryption", or omitted (means both).
  // Prefer explicit signing; fall back to omitted (treated as both).
  const explicitSigning = keyDescriptors.find((el) => el.getAttribute('use') === 'signing');
  if (explicitSigning) return explicitSigning;
  return keyDescriptors.find((el) => !el.getAttribute('use')) || null;
}

function normalizeCert(text) {
  if (!text) return '';
  return text.replace(/\s+/g, '');
}

function firstByNS(parent, ns, localName) {
  if (typeof parent.getElementsByTagNameNS === 'function') {
    return parent.getElementsByTagNameNS(ns, localName)[0] || null;
  }
  return null;
}

function allByNS(parent, ns, localName) {
  if (typeof parent.getElementsByTagNameNS === 'function') {
    return Array.from(parent.getElementsByTagNameNS(ns, localName));
  }
  return [];
}

function textOf(el) {
  return el && typeof el.textContent === 'string' ? el.textContent : '';
}

/**
 * Generate an SP metadata XML the operator can import into Okta.
 * Inputs:
 *   entityId       - SP entity ID (typically the FortiMonitor base URL)
 *   acsUrl         - Assertion Consumer Service URL (POST binding)
 *   nameIdFormat   - one of SAML.NAMEID_*, defaults to emailAddress
 *   wantSignedAssertions  - whether the SP requires signed assertions (default true)
 *   wantSignedResponse    - whether the SP requires signed responses (default false)
 *   organization   - optional { name, displayName, url }
 *   contact        - optional { name, email }
 */
export function generateSpMetadata({
  entityId,
  acsUrl,
  nameIdFormat = NAMEID_EMAIL,
  wantSignedAssertions = true,
  wantSignedResponse = false,
  organization = null,
  contact = null
} = {}) {
  if (!entityId || typeof entityId !== 'string') {
    throw new Error('entityId is required.');
  }
  if (!acsUrl || typeof acsUrl !== 'string') {
    throw new Error('acsUrl is required.');
  }
  if (!/^https?:\/\//i.test(acsUrl)) {
    throw new Error('acsUrl must be an absolute http(s) URL.');
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<md:EntityDescriptor xmlns:md="${SAML_MD_NS}" entityID="${esc(entityId)}">`,
    `  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="${wantSignedAssertions ? 'true' : 'false'}" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">`,
    `    <md:NameIDFormat>${esc(nameIdFormat)}</md:NameIDFormat>`,
    `    <md:AssertionConsumerService Binding="${HTTP_POST_BINDING}" Location="${esc(acsUrl)}" index="0" isDefault="true"/>`,
    '  </md:SPSSODescriptor>'
  ];

  if (organization && organization.name) {
    lines.push('  <md:Organization>');
    lines.push(`    <md:OrganizationName xml:lang="en">${esc(organization.name)}</md:OrganizationName>`);
    lines.push(`    <md:OrganizationDisplayName xml:lang="en">${esc(organization.displayName || organization.name)}</md:OrganizationDisplayName>`);
    if (organization.url) {
      lines.push(`    <md:OrganizationURL xml:lang="en">${esc(organization.url)}</md:OrganizationURL>`);
    }
    lines.push('  </md:Organization>');
  }
  if (contact && contact.email) {
    lines.push('  <md:ContactPerson contactType="technical">');
    if (contact.name) {
      const [given, ...rest] = contact.name.split(/\s+/);
      lines.push(`    <md:GivenName>${esc(given)}</md:GivenName>`);
      if (rest.length) {
        lines.push(`    <md:SurName>${esc(rest.join(' '))}</md:SurName>`);
      }
    }
    lines.push(`    <md:EmailAddress>${esc(contact.email)}</md:EmailAddress>`);
    lines.push('  </md:ContactPerson>');
  }

  lines.push('</md:EntityDescriptor>');

  // wantSignedResponse is reserved for the configurator; SP metadata does not
  // surface it directly (Okta sets it via app config). Reject silently here
  // by ignoring the parameter; the value still flows through the caller's
  // FortiMonitor-side config.
  void wantSignedResponse;

  return lines.join('\n') + '\n';
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
