// Unofficial FortiMonitor Toolkit - Playwright config (FMN-116, FMN-117).

import { defineConfig } from '@playwright/test';
import { loadEnv } from './load-env.js';

// Populate process.env from tests/e2e/.env.local before tests run, so the
// live suite (FMN-117) can read FORTIMONITOR_API_KEY without a manual
// shell export. Stubbed scenarios are unaffected; they ignore env.
loadEnv();

// FMN-120 Phase 2: when running the Ollama live matrix
// (OLLAMA_LIVE=1), small-model first-load latency dominates each test
// AND back-to-back model swaps on a single worker can take >2 min
// (Apple Silicon Metal VRAM swap between e.g. qwen3:8b and qwen2.5:14b).
// Bump per-test timeout so the first call into a freshly-swapped model
// has headroom.
const IS_OLLAMA_LIVE = process.env.OLLAMA_LIVE === '1';
const PER_TEST_TIMEOUT = IS_OLLAMA_LIVE ? 360_000 : 60_000;

export default defineConfig({
  testDir: '.',
  // Each test launches its own Chromium with the unpacked extension.
  // 30s leaves room for slow first-launch service-worker registration
  // on cold caches; tests themselves are sub-second once warm.
  // Live tenant scenarios talk to api2.panopta.com; bumped to 60s to
  // tolerate slower /server pagination on large tenants. Ollama live
  // bumps further (see PER_TEST_TIMEOUT above).
  timeout: PER_TEST_TIMEOUT,
  // Extension launches are heavy (full Chromium per worker, can't
  // headless-share). Serialize.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    actionTimeout: 5_000,
    // Live matrix: tracing the long-running chat turns produces
    // multi-MB trace files that race with worker-scoped persistent-
    // context cleanup, surfacing as ENOENT on .playwright-artifacts
    // paths. We have the matrix report as the durable artifact, so
    // disable trace + screenshot in live mode.
    trace: IS_OLLAMA_LIVE ? 'off' : 'retain-on-failure',
    screenshot: IS_OLLAMA_LIVE ? 'off' : 'only-on-failure'
  }
});
