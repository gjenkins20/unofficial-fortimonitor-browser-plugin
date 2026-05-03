// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SSO Configuration popup wiring + wizard smoke test (FMN-139).
//
// Verifies the operator-facing wiring:
//   1. The SSO Configuration tile is [hidden] by default in the popup.
//   2. Toggling "Show SSO Configuration" in Settings makes the tile visible.
//   3. The Settings toggle copy is scoped to SSO Configuration only.
//   4. The wizard app loads on Step 1 (Configure) with the expected
//      sections matching FortiMonitor's actual Edit SSO Configuration form
//      (FortiMonitor tenant, General, Okta IdP metadata XML, User
//      Configuration) and a disabled Continue button.
//   5. Pasting a known-good Okta IdP metadata XML parses successfully and
//      surfaces the Entity ID + Login URL in the parse-result panel.
//   6. Filling the FortiMonitor SP-side fields plus pasting valid metadata
//      enables the Continue button.
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
    await expect(tile.locator('.tool-desc')).toHaveAttribute('data-default-desc', /Edit SSO Configuration/);
    await page.close();
  });

  test('SSO Config app loads on Configure (start) step with expected sections and disabled Continue', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);
    await expect(page.locator('.step-header h2')).toContainText('Build the FortiMonitor SSO config');
    const subheads = page.locator('.subhead');
    await expect(subheads).toContainText(['FortiMonitor tenant']);
    await expect(subheads).toContainText(['General']);
    await expect(subheads).toContainText(['Okta IdP metadata XML']);
    await expect(subheads).toContainText(['User Configuration']);
    const continueBtn = page.locator('button.primary', { hasText: 'Continue to Review' });
    await expect(continueBtn).toBeDisabled();
    await page.close();
  });

  test('Pasting valid Okta IdP metadata parses and surfaces Entity ID + Login URL', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);

    const idpPaste = page.locator('textarea.paste-area');
    await idpPaste.fill(FIXTURE_OKTA_METADATA);

    const parseResult = page.locator('.parse-result');
    await expect(parseResult).toHaveClass(/ok/);
    await expect(parseResult).toContainText('IdP metadata parsed');
    await expect(parseResult).toContainText('http://www.okta.com/exk1abcdEFGHIJK0L1m2');
    await expect(parseResult).toContainText('https://example.okta.com/app/example_fortimonitor_1/exk1abcdEFGHIJK0L1m2/sso/saml');

    // Continue still disabled because base URL and URL Fragment are empty.
    const continueBtn = page.locator('button.primary', { hasText: 'Continue to Review' });
    await expect(continueBtn).toBeDisabled();

    await page.close();
  });

  test('Filling FortiMonitor base URL + URL Fragment plus pasting metadata enables Continue', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);

    await page.locator('input[placeholder="https://my.us01.fortimonitor.com"]').fill('https://my.us01.fortimonitor.com');
    await page.locator('input[placeholder="okta"]').fill('okta');
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
    await expect(parseResult).not.toContainText('IdP metadata parsed');
    await page.close();
  });

  test('FortiMonitor System Roles surface as datalist suggestions for FortiMonitor role inputs', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);
    // Ensure the SAML role mode is selected (default, but be explicit).
    await page.locator('input[name="role-mode"][value="saml"]').check();
    // Add a mapping row.
    await page.locator('button', { hasText: '+ Add role mapping' }).click();
    // Verify the datalist has the 11 System Roles.
    const datalist = page.locator('datalist#fm-role-suggestions');
    await expect(datalist).toBeAttached();
    const optionValues = await datalist.locator('option').evaluateAll((els) => els.map((e) => e.value));
    expect(optionValues).toContain('Account Admin');
    expect(optionValues).toContain('Dashboard Admin');
    expect(optionValues).toContain('Dashboard Viewer');
    expect(optionValues).toContain('No Access');
    expect(optionValues).toContain('Sub-Tenant Read-only');
    expect(optionValues.length).toBe(11);
    await page.close();
  });

  test('Full flow: Configure -> Review -> Generate -> Results renders runbook preview', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);

    await page.locator('input[placeholder="https://my.us01.fortimonitor.com"]').fill('https://my.us01.fortimonitor.com');
    await page.locator('input[placeholder="okta"]').fill('okta');
    await page.locator('textarea.paste-area').fill(FIXTURE_OKTA_METADATA);

    await page.locator('button.primary', { hasText: 'Continue to Review' }).click();
    await expect(page.locator('.step-header h2')).toContainText('Review the values you will paste');

    await page.locator('button.primary', { hasText: 'Generate runbook' }).click();
    // Execute is brief; results either renders directly, or the user lands on /execute then auto-routes.
    await expect(page.locator('.step-header h2')).toContainText('Runbook ready', { timeout: 5000 });

    const preview = page.locator('pre.runbook-preview');
    await expect(preview).toContainText('# Okta + FortiMonitor SSO setup runbook');
    await expect(preview).toContainText('## Pass 2: Configure FortiMonitor SSO');
    await expect(preview).toContainText('| URL Fragment | `okta` |');
    await expect(preview).toContainText('http://www.okta.com/exk1abcdEFGHIJK0L1m2');

    await page.close();
  });
});
