// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-154 Phase 2.5: Playwright spec for popup Settings rotation knob +
// Clear all snapshots button. Uses the loaded extension fixture so the
// real SW handles observations-snapshots:get-config / set-max / clear-all.
//
// Run: npx playwright test tests/e2e/fmn-154-phase2-settings.spec.js

import { test, expect } from './fixtures.js';

test.describe('FMN-154 Phase 2.5: snapshot-diff settings controls', () => {

  test('controls are hidden when the parent toggle is off; visible when on', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.setViewportSize({ width: 420, height: 640 });
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    await page.locator('#settings-toggle').click();

    // Toggle starts off by default (per FMN-154 commit 64c0670).
    const toggle = page.locator('#snapshot-diff-toggle');
    await expect(toggle).toBeAttached();
    await expect(toggle).not.toBeChecked();

    // Controls hidden when toggle is off.
    const controls = page.locator('[data-snapshot-diff-controls]');
    await expect(controls).toBeHidden();

    // Flip on -> controls revealed, rotation input populated by SW.
    await toggle.check();
    await expect(controls).toBeVisible();
    const rotationInput = page.locator('#snapshot-rotation-input');
    await expect(rotationInput).toBeVisible();
    // The SW defaults to 10 on first read.
    await expect(rotationInput).toHaveValue('10');

    // Flip off again -> controls hidden.
    await toggle.uncheck();
    await expect(controls).toBeHidden();

    await page.close();
  });

  test('changing rotation input persists; bad input shows an error', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.setViewportSize({ width: 420, height: 640 });
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    await page.locator('#settings-toggle').click();
    await page.locator('#snapshot-diff-toggle').check();
    const rotationInput = page.locator('#snapshot-rotation-input');

    // Happy path: change 10 -> 5 inside the [2, 50] range.
    await rotationInput.fill('5');
    await rotationInput.dispatchEvent('change');
    await expect(page.locator('#snapshot-rotation-status.ok')).toContainText('Saved.');

    // Out-of-range: SW clamps to 50. The status surfaces the clamped value.
    await rotationInput.fill('999');
    await rotationInput.dispatchEvent('change');
    await expect(page.locator('#snapshot-rotation-status.ok')).toContainText('Clamped to 50');
    await expect(rotationInput).toHaveValue('50');

    // Closing + re-opening Settings should keep the persisted value (50).
    await page.locator('#settings-back').click();
    await page.locator('#settings-toggle').click();
    await expect(rotationInput).toHaveValue('50');

    await page.close();
  });

  test('Clear all snapshots: confirm-accept clears; confirm-dismiss no-ops', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.setViewportSize({ width: 420, height: 640 });
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    await page.locator('#settings-toggle').click();
    await page.locator('#snapshot-diff-toggle').check();
    const clearBtn = page.locator('#snapshot-clear-all');

    // Dismiss the confirm -> button stays idle, no status update.
    page.once('dialog', (d) => d.dismiss().catch(() => {}));
    await clearBtn.click();
    await expect(page.locator('#snapshot-clear-status')).toHaveText('');

    // Accept the confirm -> SW clears; UI surfaces the ok status.
    page.once('dialog', (d) => d.accept().catch(() => {}));
    await clearBtn.click();
    await expect(page.locator('#snapshot-clear-status.ok')).toContainText('All snapshots cleared');

    await page.close();
  });
});
