// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Generate SSO Configuration popup wiring + wizard smoke test (FMN-139).
//
// Verifies the operator-facing wiring:
//   1. The Generate SSO Configuration tile is [hidden] by default.
//   2. The Settings toggle "Show Generate SSO Configuration" reveals it.
//   3. The Settings toggle copy is scoped correctly.
//   4. Step 1 (Set up Okta) renders the walkthrough + paste field with a
//      disabled Continue button until valid metadata is parsed.
//   5. Pasting a known-good Okta IdP metadata XML enables Continue and
//      surfaces the parsed Entity ID and Login URL.
//   6. Step 2 (Configure FortiMonitor) shows the parsed Okta values
//      read-only and gates Continue on URL Fragment + base URL validity.
//   7. Step 3 (Review) renders both panels; clicking "Generate runbook"
//      navigates to Step 4 (Results) with a runbook preview.
//   8. The 11 FortiMonitor System Roles surface as datalist suggestions.

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

test.describe('Generate SSO Configuration popup wiring (FMN-139)', () => {
  test('Tile is hidden by default; appears when toggle is enabled', async ({ extensionContext, extensionId }) => {
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
    await page.locator('#settings-back').click();
    await expect(tile).toBeVisible();
    await expect(tile.locator('.tool-name')).toContainText('Generate SSO Configuration');

    await page.close();
  });

  test('Settings toggle copy is "Show Generate SSO Configuration"', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();
    const toggleSpan = page.locator('label.toggle-row:has(#sso-config-toggle) span');
    await expect(toggleSpan).toBeAttached();
    const text = (await toggleSpan.textContent())?.trim() ?? '';
    expect(text).toBe('Show Generate SSO Configuration');
    await page.close();
  });

  test('Step 1 (Set up Okta) renders walkthrough + disabled Continue', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);
    await expect(page.locator('.step-header h2')).toContainText('Step 1: Create the Okta SAML application');
    await expect(page.locator('ol.walkthrough-steps > li')).toHaveCount(10);
    const continueBtn = page.locator('button.primary', { hasText: 'Continue to FortiMonitor' });
    await expect(continueBtn).toBeDisabled();
    await page.close();
  });

  test('Pasting valid IdP metadata enables Continue and shows parsed summary', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);

    await page.locator('textarea.paste-area').fill(FIXTURE_OKTA_METADATA);
    const parseResult = page.locator('.parse-result');
    await expect(parseResult).toHaveClass(/ok/);
    await expect(parseResult).toContainText('Okta IdP metadata parsed');
    await expect(parseResult).toContainText('http://www.okta.com/exk1abcdEFGHIJK0L1m2');

    const continueBtn = page.locator('button.primary', { hasText: 'Continue to FortiMonitor' });
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

  test('Step 2 (Configure FortiMonitor) shows Okta values read-only + gates Continue', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);

    // Step 1: paste metadata, advance.
    await page.locator('textarea.paste-area').fill(FIXTURE_OKTA_METADATA);
    await page.locator('button.primary', { hasText: 'Continue to FortiMonitor' }).click();

    // Step 2: read-only Okta panel + tenant + General + User Configuration.
    await expect(page.locator('.step-header h2')).toContainText('Step 2: Configure FortiMonitor');
    const readonly = page.locator('.subhead:has-text("From your Okta IdP metadata")');
    await expect(readonly).toBeVisible();
    await expect(page.locator('table.kv-table').first()).toContainText('http://www.okta.com/exk1abcdEFGHIJK0L1m2');

    const continueBtn = page.locator('button.primary', { hasText: 'Continue to Review' });
    await expect(continueBtn).toBeDisabled();

    await page.locator('input[placeholder="https://my.us01.fortimonitor.com"]').fill('https://my.us01.fortimonitor.com');
    await page.locator('input[placeholder="okta"]').fill('okta');
    await expect(continueBtn).toBeEnabled();

    await page.close();
  });

  test('FortiMonitor System Roles surface as datalist suggestions on Step 2', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);
    await page.locator('textarea.paste-area').fill(FIXTURE_OKTA_METADATA);
    await page.locator('button.primary', { hasText: 'Continue to FortiMonitor' }).click();

    // SAML mode is the default; add a mapping row.
    await page.locator('button', { hasText: '+ Add role mapping' }).click();
    const datalist = page.locator('datalist#fm-role-suggestions');
    await expect(datalist).toBeAttached();
    const optionValues = await datalist.locator('option').evaluateAll((els) => els.map((e) => e.value));
    expect(optionValues).toContain('Account Admin');
    expect(optionValues).toContain('Dashboard Admin');
    expect(optionValues).toContain('Dashboard Viewer');
    expect(optionValues).toContain('Sub-Tenant Read-only');
    expect(optionValues.length).toBe(11);
    await page.close();
  });

  test('Full flow: Okta -> FortiMonitor -> Review -> Results renders runbook preview', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sso-config/app.html`);

    // Step 1
    await page.locator('textarea.paste-area').fill(FIXTURE_OKTA_METADATA);
    await page.locator('button.primary', { hasText: 'Continue to FortiMonitor' }).click();

    // Step 2
    await page.locator('input[placeholder="https://my.us01.fortimonitor.com"]').fill('https://my.us01.fortimonitor.com');
    await page.locator('input[placeholder="okta"]').fill('okta');
    // Switch to manual role mode to avoid needing role mappings for this smoke test.
    await page.locator('input[name="role-mode"][value="manual"]').check();
    await page.locator('button.primary', { hasText: 'Continue to Review' }).click();

    // Step 3 (Review)
    await expect(page.locator('.step-header h2')).toContainText('Step 3: Review the values you will paste');
    await page.locator('button.primary', { hasText: 'Generate runbook' }).click();

    // Step 4 (Results)
    await expect(page.locator('.step-header h2')).toContainText('Runbook ready', { timeout: 5000 });
    const preview = page.locator('pre.runbook-preview');
    await expect(preview).toContainText('# Okta + FortiMonitor SSO setup runbook');
    await expect(preview).toContainText('## Pass 2: Configure FortiMonitor SSO');
    await expect(preview).toContainText('| URL Fragment | `okta` |');
    await expect(preview).toContainText('http://www.okta.com/exk1abcdEFGHIJK0L1m2');

    await page.close();
  });
});
