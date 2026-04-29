// Unofficial FortiMonitor Toolkit - Playwright config (FMN-116, FMN-117).

import { defineConfig } from '@playwright/test';
import { loadEnv } from './load-env.js';

// Populate process.env from tests/e2e/.env.local before tests run, so the
// live suite (FMN-117) can read FORTIMONITOR_API_KEY without a manual
// shell export. Stubbed scenarios are unaffected; they ignore env.
loadEnv();

export default defineConfig({
  testDir: '.',
  // Each test launches its own Chromium with the unpacked extension.
  // 30s leaves room for slow first-launch service-worker registration
  // on cold caches; tests themselves are sub-second once warm.
  // Live tenant scenarios talk to api2.panopta.com; bumped to 60s to
  // tolerate slower /server pagination on large tenants.
  timeout: 60_000,
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
