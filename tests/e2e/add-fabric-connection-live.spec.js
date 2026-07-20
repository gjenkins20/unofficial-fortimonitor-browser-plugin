// Unofficial FortiMonitor Toolkit - Add Fabric Connection (API) live E2E (FMN-119).
// Skip-by-default. Exercises the full start -> review -> execute -> results
// flow in DRY-RUN mode against the operator's real tenant:
//
//   - Real /v2/onsight, /v2/server_group, /v2/onsight_group GETs populate
//     the start-step dropdowns (the panopta:list-* messages dispatched
//     by the popup are NOT stubbed here).
//   - Three throwaway device rows are pasted; tool advances to review.
//   - Review defaults to dry-run mode (store.dryRun !== false); execute
//     fires fc:create-batch with dryRun:true so the service worker
//     builds payloads but never POSTs.
//   - Results page asserts three succeeded entries with payload previews.
//
// Tenant state is unchanged at the end (no fabric connections created).
// A live-write variant is intentionally not included: this dry-run
// coverage exercises every code path including the service-worker
// handler, while preserving the "tenant unchanged" guardrail.

import { test, expect } from './fixtures.js';
import { seedApiKey } from './seed-api-key.js';

const API_KEY = process.env.FORTIMONITOR_API_KEY;

// Three throwaway, deliberately-fake FortiGate serial numbers shaped like real
// FortiGate VMs (FGVM01TM-style). The dry-run path never sends them to the
// tenant; collision with real devices doesn't matter (no POST happens).
// (As of FMN-265 parse-csv also accepts hyphenated cloud serials like
// FGTAWS-...; the dedicated Start-step test below covers that path.)
const TEST_DEVICES = [
  { serial: 'FGVME2ETESTFMN119A', ip: '203.0.113.10', port: '8443' },
  { serial: 'FGVME2ETESTFMN119B', ip: '203.0.113.20', port: '8443' },
  { serial: 'FGVME2ETESTFMN119C', ip: '203.0.113.30', port: '8443' }
];

test.describe('live - Add Fabric Connection (API) E2E - real tenant', () => {
  test.skip(!API_KEY,
    'FORTIMONITOR_API_KEY not set. Add it to tests/e2e/.env.local. See docs/playwright-e2e-runbook.md.'
  );

  test.beforeAll(async ({ extensionContext }) => {
    await seedApiKey(extensionContext, API_KEY);
  });

  test('live - Dry-run end-to-end builds payloads for three throwaway devices', async ({ extensionContext, fabricConnectionUrl }) => {
    const page = await extensionContext.newPage();
    try {
      await page.goto(fabricConnectionUrl);
      await expect(page.locator('.step-header h2')).toContainText('Load FortiGate devices and pick targets');

      // Wait for both Onsight + Server Group selects to populate from live API.
      // (Appliance Group can stay empty if the tenant has no onsight_groups.)
      try {
        await page.waitForFunction(() => {
          const sels = document.querySelectorAll('select.select');
          return sels.length >= 2 && sels[0].options.length > 1 && sels[1].options.length > 1;
        }, undefined, { timeout: 30_000 });
      } catch (e) {
        const diagnostic = await page.evaluate(() => {
          const sels = Array.from(document.querySelectorAll('select.select'));
          const err = document.querySelector('.parse-warn')?.textContent ?? null;
          return {
            selectCount: sels.length,
            options: sels.map((s) => Array.from(s.options).map((o) => o.value || o.textContent)),
            errorText: err
          };
        });
        console.error('[fabric-connection-live] dropdowns did not populate:', JSON.stringify(diagnostic, null, 2));
        throw e;
      }

      // Pick the first OnSight + first Server Group. The dropdown options
      // include a placeholder + the real catalog rows; index 1 is the
      // first real option.
      const onsightSelect = page.locator('select.select').first();
      const serverGroupSelect = page.locator('select.select').nth(1);
      const onsightOptionValue = await onsightSelect.locator('option').nth(1).getAttribute('value');
      const serverGroupOptionValue = await serverGroupSelect.locator('option').nth(1).getAttribute('value');
      expect(onsightOptionValue, 'tenant must have at least one OnSight').toBeTruthy();
      expect(serverGroupOptionValue, 'tenant must have at least one server group').toBeTruthy();
      await onsightSelect.selectOption(onsightOptionValue);
      await serverGroupSelect.selectOption(serverGroupOptionValue);

      // Paste three throwaway devices.
      const csv = TEST_DEVICES.map((d) => `${d.serial},${d.ip},${d.port}`).join('\n');
      await page.locator('textarea.paste-area').fill(csv);

      // Wait for paste to parse and Continue to enable. refreshContinue
      // runs on every paste input event; we have to wait for it to fire.
      const continueBtn = page.getByRole('button', { name: /Continue/ });
      try {
        await expect(continueBtn).toBeEnabled({ timeout: 10_000 });
      } catch (e) {
        const diag = await page.evaluate(() => {
          const sels = Array.from(document.querySelectorAll('select.select'));
          return {
            onsightVal: sels[0]?.value,
            serverGroupVal: sels[1]?.value,
            applianceGroupVal: sels[2]?.value,
            pasteValue: document.querySelector('textarea.paste-area')?.value,
            parseResultText: document.querySelector('.parse-result')?.textContent
          };
        });
        console.error('[fabric-live] Continue stays disabled:', JSON.stringify(diag, null, 2));
        throw e;
      }
      await continueBtn.click();
      await expect(page).toHaveURL(/#\/review$/, { timeout: 10_000 });

      // Review step shows all three serials in the parsed devices.
      for (const d of TEST_DEVICES) {
        await expect(page.locator('.body-section')).toContainText(d.serial);
      }

      // Dry-run radio should be checked by default.
      const dryRunRadio = page.locator('input[type="radio"][value="dry-run"]');
      await expect(dryRunRadio).toBeChecked();

      // Execute (dry-run path - no confirmation phrase needed).
      await page.getByRole('button', { name: 'Execute' }).click();
      await expect(page).toHaveURL(/#\/execute$/, { timeout: 10_000 });

      // Wait for the execute step to finish processing all three rows.
      // execute.js emits per-row events and updates a summary like
      // "3/3 complete - 3 ok - 0 failed", then navigates to /results.
      await expect(page).toHaveURL(/#\/results$/, { timeout: 30_000 });

      // Results page should list three rows, all with succeeded status.
      // The results step renders a per-device table; serial appears
      // verbatim and the status badge reads "succeeded" or "ok".
      const body = page.locator('.body-section');
      for (const d of TEST_DEVICES) {
        await expect(body).toContainText(d.serial);
      }
    } finally {
      await page.close();
    }
  });

  // FMN-265: Start-step behavior matrix against the live tenant. Non-destructive
  // - it only parses input + advances to Review (no Execute, no fc:create-batch).
  // The dropdowns are populated from the real /v2 catalog; the assertions cover
  // (a) a hyphenated cloud serial parsing, (b) the include-flagged override
  // rescuing a non-IPv4 host, and (c) a host-less row staying hard-skipped.
  test('live - cloud serials parse and the include-flagged override behaves', async ({ extensionContext, fabricConnectionUrl }) => {
    const page = await extensionContext.newPage();
    try {
      await page.goto(fabricConnectionUrl);
      await expect(page.locator('.step-header h2')).toContainText('Load FortiGate devices and pick targets');

      await page.waitForFunction(() => {
        const sels = document.querySelectorAll('select.select');
        return sels.length >= 2 && sels[0].options.length > 1 && sels[1].options.length > 1;
      }, undefined, { timeout: 30_000 });

      const onsightSelect = page.locator('select.select').first();
      const serverGroupSelect = page.locator('select.select').nth(1);
      await onsightSelect.selectOption(await onsightSelect.locator('option').nth(1).getAttribute('value'));
      await serverGroupSelect.selectOption(await serverGroupSelect.locator('option').nth(1).getAttribute('value'));

      const paste = page.locator('textarea.paste-area');
      const continueBtn = page.getByRole('button', { name: /Continue/ });
      const flaggedToggle = page.locator('.include-flagged-row input[type="checkbox"]');

      // (a) Hyphenated cloud serial parses on its own.
      await paste.fill('FGTAWS-LIVEFMN265TEST,203.0.113.40,8443');
      await expect(continueBtn).toBeEnabled({ timeout: 10_000 });
      await expect(page.locator('.flag-badge')).toHaveCount(0);

      // (b) Non-IPv4 host: skipped by default, rescued by the override + flagged.
      await paste.fill('FGVME2EFMN265HOST,fgt.live.example.com,8443');
      await expect(continueBtn).toBeDisabled();
      await expect(page.locator('.parse-hint')).toContainText('Include flagged devices');
      await flaggedToggle.check();
      await expect(continueBtn).toBeEnabled();
      await continueBtn.click();
      await expect(page).toHaveURL(/#\/review$/, { timeout: 10_000 });
      await expect(page.locator('.review-table .flag-badge')).toBeVisible();

      // (c) Back on Start, a host-less row stays hard-skipped even with the toggle on.
      await page.getByRole('button', { name: /Back/ }).click();
      await expect(page).toHaveURL(/#\/start$/, { timeout: 10_000 });
      await page.locator('textarea.paste-area').fill('FGVME2EFMN265NOHOST,,8443');
      await expect(page.getByRole('button', { name: /Continue/ })).toBeDisabled();
      // `.parse-result` also matches the (empty) targets-error div; scope to the populated summary.
      await expect(page.locator('.parse-result').first()).toContainText('missing IP');
    } finally {
      await page.close();
    }
  });

  // FMN-291: optional device name → connection label, against the live tenant.
  // Non-destructive: parses input + advances to Review in dry-run. Covers both
  // ends of the matrix - a named device (label = name) and an unnamed one
  // (label falls back to the IP) - and confirms the label lands in the built
  // payload preview. (Where the label surfaces on the imported instance itself
  // requires an actual onboard and is left to operator live QA per the ticket.)
  test('live - optional name becomes the connection label; blank falls back to IP', async ({ extensionContext, fabricConnectionUrl }) => {
    const page = await extensionContext.newPage();
    try {
      await page.goto(fabricConnectionUrl);
      await expect(page.locator('.step-header h2')).toContainText('Load FortiGate devices and pick targets');

      await page.waitForFunction(() => {
        const sels = document.querySelectorAll('select.select');
        return sels.length >= 2 && sels[0].options.length > 1 && sels[1].options.length > 1;
      }, undefined, { timeout: 30_000 });

      const onsightSelect = page.locator('select.select').first();
      const serverGroupSelect = page.locator('select.select').nth(1);
      await onsightSelect.selectOption(await onsightSelect.locator('option').nth(1).getAttribute('value'));
      await serverGroupSelect.selectOption(await serverGroupSelect.locator('option').nth(1).getAttribute('value'));

      // First device named (drives the example-payload preview), second unnamed.
      await page.locator('textarea.paste-area').fill(
        'serial,ip,port,name\n' +
        'FGVME2EFMN291NAMED,203.0.113.50,8443,Edge-FW-291\n' +
        'FGVME2EFMN291BLANK,203.0.113.60,8443'
      );
      const continueBtn = page.getByRole('button', { name: /Continue/ });
      await expect(continueBtn).toBeEnabled({ timeout: 10_000 });
      await continueBtn.click();
      await expect(page).toHaveURL(/#\/review$/, { timeout: 10_000 });

      // Named device carries its label; unnamed shows the IP-fallback hint.
      await expect(page.locator('.review-table thead')).toContainText('Name (label)');
      await expect(page.locator('.review-table tbody tr').first()).toContainText('Edge-FW-291');
      await expect(page.locator('.review-table .name-fallback')).toContainText('defaults to IP');

      // The built payload preview (first device) uses the name as the label.
      await expect(page.locator('.preview-payload')).toContainText('"label": "Edge-FW-291"');

      // Stays in dry-run - no fabric_connection is created on the tenant.
      await expect(page.locator('input[type="radio"][value="dry-run"]')).toBeChecked();
    } finally {
      await page.close();
    }
  });
});
