// FMN-120: Playwright spec covering the Ask Claude provider radio
// (Anthropic / Ollama / LM Studio) and the per-provider URL/model/key
// fields. Stubbed: the spec exercises the Settings UI and verifies
// chrome.storage.local writes; live calls to a local Ollama / LM Studio
// instance are operator-driven and out of scope here.

import { test as base, chromium, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');

const test = base.extend({
  extensionContext: [async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmtoolkit-provider-e2e-'));
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

async function openSettings(page) {
  await page.locator('#settings-toggle').click();
  await expect(page.locator('#settings-view')).toBeVisible();
}

async function readStorage(page, key) {
  return await page.evaluate(async (k) => {
    const data = await chrome.storage.local.get(k);
    return data[k];
  }, key);
}

test('provider radio renders with three options and Anthropic selected by default (FMN-120)', async ({ extensionContext, popupUrl }) => {
  const page = await extensionContext.newPage();
  await page.goto(popupUrl);
  await openSettings(page);
  const radios = page.locator('input[name="ask-claude-provider"]');
  await expect(radios).toHaveCount(3);
  await expect(radios.nth(0)).toHaveAttribute('value', 'anthropic');
  await expect(radios.nth(1)).toHaveAttribute('value', 'ollama');
  await expect(radios.nth(2)).toHaveAttribute('value', 'lmstudio');
  await expect(radios.nth(0)).toBeChecked();
  const stored = await readStorage(page, 'fm:askClaudeProvider');
  expect(stored === undefined || stored === 'anthropic').toBe(true);
  await page.close();
});

test('selecting Ollama hides the Anthropic key section and reveals Ollama URL/model/key fields (FMN-120)', async ({ extensionContext, popupUrl }) => {
  const page = await extensionContext.newPage();
  await page.goto(popupUrl);
  await openSettings(page);
  // Anthropic key section visible by default.
  const anthropicSection = page.locator('[data-ask-claude-provider="anthropic"]');
  const ollamaSection = page.locator('[data-ask-claude-provider="ollama"]');
  const lmstudioSection = page.locator('[data-ask-claude-provider="lmstudio"]');
  await expect(anthropicSection).toBeVisible();
  await expect(ollamaSection).toBeHidden();
  await expect(lmstudioSection).toBeHidden();
  // Switch to Ollama.
  await page.locator('input[name="ask-claude-provider"][value="ollama"]').check();
  await expect(ollamaSection).toBeVisible();
  await expect(anthropicSection).toBeHidden();
  await expect(lmstudioSection).toBeHidden();
  // URL field is pre-populated with the default Ollama URL.
  await expect(page.locator('#ollama-url-input')).toHaveValue('http://localhost:11434/v1');
  // Storage write happens in the change handler.
  await expect.poll(async () => await readStorage(page, 'fm:askClaudeProvider'),
    { timeout: 2000 }).toBe('ollama');
  await page.close();
});

test('selecting LM Studio reveals only the LM Studio fields (FMN-120)', async ({ extensionContext, popupUrl }) => {
  const page = await extensionContext.newPage();
  await page.goto(popupUrl);
  await openSettings(page);
  await page.locator('input[name="ask-claude-provider"][value="lmstudio"]').check();
  await expect(page.locator('[data-ask-claude-provider="lmstudio"]')).toBeVisible();
  await expect(page.locator('[data-ask-claude-provider="anthropic"]')).toBeHidden();
  await expect(page.locator('[data-ask-claude-provider="ollama"]')).toBeHidden();
  await expect(page.locator('#lmstudio-url-input')).toHaveValue('http://localhost:1234/v1');
  await page.close();
});

test('provider selection persists to chrome.storage.local and survives a popup reload (FMN-120)', async ({ extensionContext, popupUrl }) => {
  const page = await extensionContext.newPage();
  await page.goto(popupUrl);
  await openSettings(page);
  await page.locator('input[name="ask-claude-provider"][value="ollama"]').check();
  await expect.poll(async () => await readStorage(page, 'fm:askClaudeProvider'),
    { timeout: 2000 }).toBe('ollama');
  await page.reload();
  await openSettings(page);
  await expect(page.locator('input[name="ask-claude-provider"][value="ollama"]')).toBeChecked();
  await expect(page.locator('[data-ask-claude-provider="ollama"]')).toBeVisible();
  await page.close();
});

test('Saving Ollama URL+model writes to chrome.storage.local (FMN-120)', async ({ extensionContext, popupUrl }) => {
  const page = await extensionContext.newPage();
  await page.goto(popupUrl);
  await openSettings(page);
  await page.locator('input[name="ask-claude-provider"][value="ollama"]').check();
  // Override defaults and save.
  await page.locator('#ollama-url-input').fill('http://10.0.0.5:11434/v1');
  await page.locator('#ollama-model-input').fill('qwen2.5:7b');
  // The Save button triggers a permissions request via chrome.permissions.request;
  // we intercept it on the page side so the click resolves cleanly without
  // showing a Chrome consent dialog (which would block the test).
  await page.evaluate(() => {
    const realRequest = chrome.permissions.request;
    chrome.permissions.request = async () => true;
    window.__realPermsRequest = realRequest;
  });
  await page.locator('#ollama-save').click();
  await expect.poll(async () => await readStorage(page, 'fm:askClaudeOllamaUrl'),
    { timeout: 2000 }).toBe('http://10.0.0.5:11434/v1');
  await expect.poll(async () => await readStorage(page, 'fm:askClaudeOllamaModel'),
    { timeout: 2000 }).toBe('qwen2.5:7b');
  await page.close();
});

test('provider sections are hidden when Ask Claude is toggled off (FMN-120)', async ({ extensionContext, popupUrl }) => {
  const page = await extensionContext.newPage();
  await page.goto(popupUrl);
  await openSettings(page);
  await page.locator('input[name="ask-claude-provider"][value="ollama"]').check();
  await expect(page.locator('[data-ask-claude-provider="ollama"]')).toBeVisible();
  await page.locator('#ask-claude-toggle').uncheck();
  await expect(page.locator('[data-ask-claude-provider="ollama"]')).toBeHidden();
  await expect(page.locator('[data-ask-claude-provider="anthropic"]')).toBeHidden();
  await page.locator('#ask-claude-toggle').check();
  // Provider state preserved; only the active provider's section returns.
  await expect(page.locator('[data-ask-claude-provider="ollama"]')).toBeVisible();
  await expect(page.locator('[data-ask-claude-provider="anthropic"]')).toBeHidden();
  await page.close();
});
