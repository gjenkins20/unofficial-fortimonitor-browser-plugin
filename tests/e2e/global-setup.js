// FMN-120 Phase 2: globalSetup hook for the live-Ollama matrix.
//
// Runs ONCE per `npm run test:e2e:ollama-live` invocation, in the
// Playwright parent process before any worker spawns. The matrix-rows
// JSONL file is cleared here so a fresh run never inherits stale rows
// from a prior invocation. Worker-level beforeAll hooks cannot do this
// safely because Playwright restarts workers when tests fail, and a
// worker-level clear would wipe rows that earlier workers had already
// persisted.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function globalSetup() {
  const jsonlPath = path.resolve(__dirname, '.artifacts/matrix-rows.jsonl');
  if (fs.existsSync(jsonlPath)) {
    fs.unlinkSync(jsonlPath);
    console.log(`[global-setup] cleared ${jsonlPath}`);
  }
}
