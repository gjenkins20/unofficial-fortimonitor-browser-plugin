// Unofficial FortiMonitor Toolkit - Ask Claude tier toggle E2E (FMN-97 / FMN-94 epic).
//
// Verifies the Settings tier toggle landed by FMN-97: the radio renders,
// the default is 'readonly', changes persist to chrome.storage.local,
// the section is gated by the Ask-Claude-enabled toggle, and the
// cost-warning prose (FMN-109) is present on both surfaces.
//
// ---------------------------------------------------------------
// Verification plan for the FMN-94 epic (recorded here for traceability)
// ---------------------------------------------------------------
//
// What this Playwright spec covers (stubbed, no API keys):
//   1. Popup loads after the epic merge without service-worker errors
//      (sanity check that the new codegen + hand-port imports parse).
//   2. Settings -> Ask Claude tier radio renders three options with the
//      default 'readonly' selected on a fresh install.
//   3. Selecting a tier writes fm:askClaudeToolTier to chrome.storage.local
//      and survives a popup reload.
//   4. Tier section is hidden when Ask Claude is toggled off and reappears
//      when toggled back on.
//   5. FMN-109 cost-warning prose: tile subtitle includes the cost mention,
//      tier-section help text describes the trade-off.
//
// What this spec does NOT cover (operator-verified or unit-tested elsewhere):
//   - Tier filter behavior at runtime (which tools actually get sent to
//     Anthropic per tier). Covered by extension/tests/claude-tools-merge.test.js
//     in the unit suite.
//   - Live Anthropic call with each tier (would need ANTHROPIC_API_KEY plus
//     a tenant). A future tests/e2e/ask-claude-tier-live.spec.js can add
//     this once the operator wires the secret; out of scope for stubbed.
//   - End-to-end chat turn through the codegen dispatcher to the v2 API.
//     The dispatcher is unit-tested at extension/tests/codegen-dispatcher.test.js;
//     real-tenant verification is gated on the operator running an Ask
//     Claude session with each tier and confirming tool counts in the
//     network tab.

import { test as base, chromium, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');

// Local fixture so this spec can install a fresh persistent context per
// run (Settings + storage assertions need a clean profile).
//
// Window placement: pin to far-offscreen coordinates so the Chromium
// window doesn't steal focus during local runs. Headless was tried but
// MV3 service workers don't reliably register under headless Chromium
// (see fixtures.js for the find-servers suite); offscreen-headed is the
// best stopgap until the suite runs under Xvfb in CI.
const test = base.extend({
  extensionContext: [async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmtoolkit-tier-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--window-position=-2400,-2400',
        '--window-size=1280,800'
      ]
    });
    await use(context);
    await context.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }, { scope: 'worker' }],

  extensionId: [async ({ extensionContext }, use) => {
    let sw = extensionContext.serviceWorkers()[0];
    if (!sw) {
      sw = await extensionContext.waitForEvent('serviceworker', { timeout: 10_000 });
    }
    const id = sw.url().split('/')[2];
    if (!id) throw new Error(`Could not extract extension ID from: ${sw.url()}`);
    await use(id);
  }, { scope: 'worker' }],

  popupUrl: [async ({ extensionId }, use) => {
    await use(`chrome-extension://${extensionId}/src/popup/popup.html`);
  }, { scope: 'worker' }]
});

// Helper: open Settings and wait for the radios to render.
async function openSettings(page) {
  await page.locator('#settings-toggle').click();
  await expect(page.locator('#settings-view')).toBeVisible();
}

// Helper: read a single key from chrome.storage.local in the page context.
async function readStorage(page, key) {
  return await page.evaluate(async (k) => {
    const data = await chrome.storage.local.get(k);
    return data[k];
  }, key);
}

test('popup loads cleanly after the FMN-94 epic merge (no service-worker errors)', async ({ extensionContext, popupUrl }) => {
  const consoleErrors = [];
  const page = await extensionContext.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await page.goto(popupUrl);
  // The Ask Claude tile should be visible once the popup mounts.
  await expect(page.locator('.tool-card', { hasText: 'Ask AI' })).toBeVisible();
  await page.close();
  expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([]);
});

test('Ask AI tile description carries the tier prose (FMN-109 / FMN-120)', async ({ extensionContext, popupUrl }) => {
  // popup.js refreshGuards swaps the visible .tool-desc text when auth
  // is missing (e.g. "Set a FortiMonitor v2 API key in Settings"). The
  // data-default-desc attribute is the source of truth for the live
  // prose and is preserved regardless of guard state, so this test
  // asserts on the attribute rather than the rendered text.
  // FMN-120: the tile description is now provider-generic. The cost
  // warning lives on the Anthropic-specific surfaces (Settings key
  // section, chat-page warning); the tile only references tokens-per-turn.
  const page = await extensionContext.newPage();
  await page.goto(popupUrl);
  const desc = page.locator('.tool-card', { hasText: 'Ask AI' }).locator('.tool-desc');
  const defaultDesc = await desc.getAttribute('data-default-desc');
  expect(defaultDesc, 'tile data-default-desc must mention bigger tool tiers').toMatch(/bigger tool tiers/i);
  expect(defaultDesc, 'tile data-default-desc must mention tokens per turn').toMatch(/tokens per turn/i);
  expect(defaultDesc, 'tile data-default-desc should name the available providers').toMatch(/anthropic/i);
  expect(defaultDesc, 'tile data-default-desc should name the available providers').toMatch(/ollama/i);
  await page.close();
});

test('Settings tier radio renders with readonly selected by default (FMN-97)', async ({ extensionContext, popupUrl }) => {
  const page = await extensionContext.newPage();
  await page.goto(popupUrl);
  await openSettings(page);
  const tierSection = page.locator('#ask-claude-tier-section');
  await expect(tierSection).toBeVisible();
  // All three radios present in document order: readonly / readwrite / all.
  const radios = tierSection.locator('input[name="ask-claude-tool-tier"]');
  await expect(radios).toHaveCount(3);
  await expect(radios.nth(0)).toHaveAttribute('value', 'readonly');
  await expect(radios.nth(1)).toHaveAttribute('value', 'readwrite');
  await expect(radios.nth(2)).toHaveAttribute('value', 'all');
  // Default selection: readonly. (chrome.storage.local empty -> default applied.)
  await expect(radios.nth(0)).toBeChecked();
  await expect(radios.nth(1)).not.toBeChecked();
  await expect(radios.nth(2)).not.toBeChecked();
  // Storage key is unset on a fresh profile; getter returns 'readonly'.
  const stored = await readStorage(page, 'fm:askClaudeToolTier');
  expect(stored === undefined || stored === 'readonly').toBe(true);
  await page.close();
});

test('Tier section help text spells out the trade-off (FMN-109)', async ({ extensionContext, popupUrl }) => {
  const page = await extensionContext.newPage();
  await page.goto(popupUrl);
  await openSettings(page);
  const help = page.locator('#ask-claude-tier-section .settings-help').first();
  // Case-insensitive: the live copy says "Bigger tier" with a capital B.
  await expect(help).toHaveText(/bigger tier/i);
  await expect(help).toHaveText(/more tokens/i);
  // Per FMN-94 decision 6: no specific dollar figures.
  const text = (await help.textContent()) ?? '';
  expect(text).not.toMatch(/\$/);
  await page.close();
});

test('selecting readwrite persists to chrome.storage.local and survives a reload (FMN-97)', async ({ extensionContext, popupUrl }) => {
  const page = await extensionContext.newPage();
  await page.goto(popupUrl);
  await openSettings(page);
  await page.locator('input[name="ask-claude-tool-tier"][value="readwrite"]').check();
  // Storage write happens in the change handler; allow a tick.
  await expect.poll(async () => await readStorage(page, 'fm:askClaudeToolTier'),
    { timeout: 2000 }).toBe('readwrite');
  // Reload the popup; stored tier reads back.
  await page.reload();
  await openSettings(page);
  await expect(page.locator('input[name="ask-claude-tool-tier"][value="readwrite"]')).toBeChecked();
  await page.close();
});

test('selecting all persists and survives reload (FMN-97)', async ({ extensionContext, popupUrl }) => {
  const page = await extensionContext.newPage();
  await page.goto(popupUrl);
  await openSettings(page);
  await page.locator('input[name="ask-claude-tool-tier"][value="all"]').check();
  await expect.poll(async () => await readStorage(page, 'fm:askClaudeToolTier'),
    { timeout: 2000 }).toBe('all');
  await page.reload();
  await openSettings(page);
  await expect(page.locator('input[name="ask-claude-tool-tier"][value="all"]')).toBeChecked();
  await page.close();
});

test('tier section hides when Ask Claude is toggled off and reappears when toggled back on (FMN-97)', async ({ extensionContext, popupUrl }) => {
  const page = await extensionContext.newPage();
  await page.goto(popupUrl);
  await openSettings(page);
  const tierSection = page.locator('#ask-claude-tier-section');
  await expect(tierSection).toBeVisible();
  // Toggle Ask Claude off; tier section follows.
  await page.locator('#ask-claude-toggle').uncheck();
  await expect(tierSection).toBeHidden();
  // Toggle back on; tier section returns.
  await page.locator('#ask-claude-toggle').check();
  await expect(tierSection).toBeVisible();
  await page.close();
});
