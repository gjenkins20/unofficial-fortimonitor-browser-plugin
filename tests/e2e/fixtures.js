// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Playwright fixtures for the E2E suite (FMN-116).
//
// chromium.launchPersistentContext is the only Playwright launcher that
// supports --load-extension. We launch with the unpacked extension at
// repo-root/extension/ and discover the per-launch extension ID from the
// service worker URL.
//
// Headless does not work for MV3 service workers in current Chromium
// builds: the worker either fails to register or never wakes for
// chrome.runtime.sendMessage. We pin headless=false. CI will need an
// Xvfb-style display when we wire it up.
//
// Per memory playwright_offscreen_window.md, headed extension runs
// must use `--window-position=-32000,-32000 --start-minimized` so the
// Chromium window doesn't visibly intrude on the operator's display
// during local runs. Both args are needed: the offscreen position
// keeps the window off any monitor, the start-minimized flag prevents
// a brief flash on creation.
//
// All extension-bound fixtures are worker-scoped (Playwright forbids
// re-scoping the built-in `context` fixture, so we expose a parallel
// `extensionContext` instead). With workers:1 (set in playwright.config.js)
// the context is shared across the whole run; tests still call
// extensionContext.newPage() / page.close() so pages are isolated.

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
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmtoolkit-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--window-position=-32000,-32000',
        '--start-minimized',
        // Allow ES-module imports between docs/harnesses/*.html and the
        // sibling extension/src/ tree without spinning up an HTTP server
        // (FMN-133 viewer harness Playwright spec).
        '--allow-file-access-from-files'
      ]
    });
    await use(context);
    await context.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  }, { scope: 'worker' }],

  // Discover the extension ID from the service worker URL.
  // serviceWorkers() may be empty on first read if the worker has not
  // yet woken up, so we wait for the event as a fallback.
  extensionId: [async ({ extensionContext }, use) => {
    let sw = extensionContext.serviceWorkers()[0];
    if (!sw) {
      sw = await extensionContext.waitForEvent('serviceworker', { timeout: 10_000 });
    }
    // sw.url() looks like:
    //   chrome-extension://EXT_ID/background/service-worker.js
    const id = sw.url().split('/')[2];
    if (!id) throw new Error(`Could not extract extension ID from service worker URL: ${sw.url()}`);
    await use(id);
  }, { scope: 'worker' }],

  // Convenience: build the find-servers tool URL given the discovered
  // extension ID. Tests use `await page.goto(findServersUrl)`.
  findServersUrl: [async ({ extensionId }, use) => {
    await use(`chrome-extension://${extensionId}/src/ui/server-search/app.html#/start`);
  }, { scope: 'worker' }]
});

export { expect };
