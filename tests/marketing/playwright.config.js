// Marketing capture config (FMN-127). Separate from the e2e suite so
// `npm test` and `npm run test:e2e` never trigger captures, and so
// `npm run capture:marketing` runs only the capture specs.
//
// Reuses the same headed-Chromium-with-extension launch model as the
// e2e suite (fixtures.js imported from ../e2e/fixtures.js). Captures
// land in docs/marketing/screenshots/ via per-spec page.screenshot()
// calls.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    actionTimeout: 5_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off'
  }
});
