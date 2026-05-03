// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SSO Configuration popup wiring + wizard smoke test (FMN-139).
//
// Verifies the operator-facing wiring:
//   1. The SSO Configuration tile is [hidden] by default in the popup.
//   2. Toggling "Show SSO Configuration" in Settings makes the tile visible.
//   3. The Settings toggle copy is scoped to SSO Configuration only.
//   4. The wizard app loads on the Configure (start) step with the
//      expected sections and a disabled Continue button.
//   5. Pasting a known-good Okta IdP metadata XML parses successfully and
//      surfaces the issuer and SSO URL in the parse-result panel.
//
// Per memory verify_in_playwright_what_you_can.md: this is the verifiable
// residue of the popup + wizard wiring. saml-metadata.js and
// sso-runbook.js logic are covered exhaustively by Node unit tests.

import { test, expect } from './fixtures.js';

const FIXTURE_OKTA_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="http://www.okta.com/exk1abcdEFGHIJK0L1m2">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data>
          <ds:X509Certificate>MIIDqDCCApCgAwIBAgIGAYpHFAKEcert</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://example.okta.com/app/example_fortimonitor_1/exk1abcdEFGHIJK0L1m2/sso/saml"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

test.describe('SSO Configuration popup wiring (FMN-139)', () => {
  test('Tile is hidden by default; appears when SSO Configuration toggle is enabled', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    const tile = page.locator('.tool-card[data-tool="sso-config"]');
    await expect(tile).toBeAttached();
    await expect(tile).toBeHidden();

    await page.locator('#settings-toggle').click();
    const toggle = page.locator('#sso-config-toggle');
    await expect(toggle).toBeAttached();
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await expect(toggle).toBeChecked();
    await page.locator('#settings-back').click();
    await expect(tile).toBeVisible();

    await page.locator('#settings-toggle').click();
    await toggle.uncheck();
    await page.locator('#settings-back').click();
    await expect(tile).toBeHidden();

    await page.close();
  });

  test('Settings toggle copy is scoped to SSO Configuration only', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();
    const toggleSpan = page.locator('label.toggle-row:has(#sso-config-toggle) span');
    await expect(toggleSpan).toBeAttached();
    const text = (await toggleSpan.textContent())?.trim() ?? '';
    expect(text).toBe('Show SSO Configuration');
    expect(text).not.toContain('BPA');
    expect(text).not.toContain('SD-WAN');
    expect(text).not.toContain('Ask AI');
    await page.close();
  });

  test('Tile description matches the registered copy', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    const tile = page.locator('.tool-card[data-tool="sso-config"]');
    await expect(tile.locator('.tool-name')).toContainText('SSO Configuration');
    await expect(tile.locator('.tool-desc')).toHaveAttribute('data-default-desc', /Okta IdP metadata XML/);
    await page.close();
  });

  test('SSO Config app loads on Configure (start) step with all sections and disabled Continue', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);
    await expect(page.locator('.step-header h2')).toContainText('Build your SSO configuration');
    // Section subheads
    const subheads = page.locator('.subhead');
    await expect(subheads).toContainText(['FortiMonitor (Service Provider)']);
    await expect(subheads).toContainText(['Okta (Identity Provider)']);
    await expect(subheads).toContainText(['Attribute statements']);
    await expect(subheads).toContainText(['Role mapping']);
    await expect(subheads).toContainText(['SSO mode']);
    // Continue is disabled until the form is valid.
    const continueBtn = page.locator('button.primary', { hasText: 'Continue to Review' });
    await expect(continueBtn).toBeDisabled();
    await page.close();
  });

  test('Pasting valid Okta IdP metadata parses and surfaces issuer + SSO URL', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);

    const idpPaste = page.locator('textarea.paste-area');
    await idpPaste.fill(FIXTURE_OKTA_METADATA);

    const parseResult = page.locator('.parse-result');
    await expect(parseResult).toHaveClass(/ok/);
    await expect(parseResult).toContainText('IdP metadata parsed');
    await expect(parseResult).toContainText('http://www.okta.com/exk1abcdEFGHIJK0L1m2');
    await expect(parseResult).toContainText('https://example.okta.com/app/example_fortimonitor_1/exk1abcdEFGHIJK0L1m2/sso/saml');

    // Continue is still disabled because spEntityId and acsUrl are empty.
    const continueBtn = page.locator('button.primary', { hasText: 'Continue to Review' });
    await expect(continueBtn).toBeDisabled();

    await page.close();
  });

  test('Filling SP fields plus pasting metadata enables Continue', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);

    // Fill SP entity ID and ACS URL via the labeled inputs.
    const spEntityIdInput = page.locator('label.form-row:has-text("SP Entity ID") input');
    await spEntityIdInput.fill('https://acme.fortimonitor.com');
    const acsInput = page.locator('label.form-row:has-text("Assertion Consumer Service") input');
    await acsInput.fill('https://acme.fortimonitor.com/saml/acs');

    // Paste metadata.
    await page.locator('textarea.paste-area').fill(FIXTURE_OKTA_METADATA);

    const continueBtn = page.locator('button.primary', { hasText: 'Continue to Review' });
    await expect(continueBtn).toBeEnabled();

    await page.close();
  });

  test('Invalid IdP metadata XML surfaces a clear error', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);
    await page.locator('textarea.paste-area').fill('not really xml at all');
    const parseResult = page.locator('.parse-result');
    await expect(parseResult).toHaveClass(/error/);
    // Must not contain the success summary.
    await expect(parseResult).not.toContainText('IdP metadata parsed');
    await page.close();
  });
});
