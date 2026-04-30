// FMN-127: marketing capture fixtures. Mirrors tests/e2e/fixtures.js
// but launches Chromium offscreen so the operator's focus is not
// stolen during capture runs (memory: playwright_offscreen_window).

import { test as base, chromium, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXTENSION_PATH = path.resolve(__dirname, '../../extension');

export const test = base.extend({
  extensionContext: [async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmtoolkit-marketing-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        // Far-offscreen + minimized + no-first-run combo so the headed
        // window never visibly intrudes on the operator's display.
        // (MV3 service workers don't register reliably under classic
        // headless; --headless=new is the eventual move once we
        // confirm it on this project's chrome version.)
        '--window-position=-32000,-32000',
        '--window-size=1280,800',
        '--start-minimized',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync'
      ]
    });
    await use(context);
    await context.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  }, { scope: 'worker' }],

  extensionId: [async ({ extensionContext }, use) => {
    let sw = extensionContext.serviceWorkers()[0];
    if (!sw) {
      sw = await extensionContext.waitForEvent('serviceworker', { timeout: 10_000 });
    }
    const id = sw.url().split('/')[2];
    if (!id) throw new Error(`Could not extract extension ID from service worker URL: ${sw.url()}`);
    await use(id);
  }, { scope: 'worker' }]
});

export { expect };
