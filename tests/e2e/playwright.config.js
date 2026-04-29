// Unofficial FortiMonitor Toolkit - Playwright config (FMN-116).

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // Each test launches its own Chromium with the unpacked extension.
  // 30s leaves room for slow first-launch service-worker registration
  // on cold caches; tests themselves are sub-second once warm.
  timeout: 30_000,
  // Extension launches are heavy (full Chromium per worker, can't
  // headless-share). Serialize.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    actionTimeout: 5_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
