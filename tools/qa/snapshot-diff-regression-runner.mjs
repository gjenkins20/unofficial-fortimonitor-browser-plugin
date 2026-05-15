#!/usr/bin/env node
// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-222: thin wrapper that runs tests/e2e/snapshot-diff-regression.spec.js,
// captures stdout/stderr to a timestamped log file, and exits with the
// spec's exit code so a scheduler can surface failures.
//
// Usage:
//   node tools/qa/snapshot-diff-regression-runner.mjs
//   FMN_QA_TEST_TEMPLATE_ID=12345 node tools/qa/snapshot-diff-regression-runner.mjs
//
// Pre-reqs (operator-managed, one-time):
//   1. The persistent dev launcher must be running:
//        node tools/dev/launcher.mjs
//      Sign into FortiMonitor in the launcher window once. Cookies persist
//      under tests/e2e/.profile-fmn-live-cookies.json.
//   2. The toolkit must have a FortiMonitor RW API key stored in
//      chrome.storage.local under "panopta.apiKey". The spec bails with
//      test.skip if missing.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const LOGS_DIR = path.resolve(__dirname, 'logs');
const SPEC = 'tests/e2e/snapshot-diff-regression.spec.js';

fs.mkdirSync(LOGS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_FILE = path.join(LOGS_DIR, `snapshot-diff-regression-${stamp}.log`);

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
const startedAt = new Date().toISOString();
logStream.write(`# FMN-222 regression run started at ${startedAt}\n`);
logStream.write(`# repo: ${REPO_ROOT}\n`);
logStream.write(`# spec: ${SPEC}\n`);
for (const k of ['FMN_QA_TEST_SERVER_ID', 'FMN_QA_TEST_TEMPLATE_TARGET_SERVER_ID', 'FMN_QA_TEST_TEMPLATE_ID', 'FMN_CDP_PORT']) {
  logStream.write(`# env ${k}=${process.env[k] || '(unset)'}\n`);
}
logStream.write('\n');

const child = spawn('npx', ['playwright', 'test', SPEC], {
  cwd: REPO_ROOT,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.pipe(process.stdout);
child.stdout.pipe(logStream);
child.stderr.pipe(process.stderr);
child.stderr.pipe(logStream);

child.on('exit', (code, signal) => {
  const finishedAt = new Date().toISOString();
  const summary = signal
    ? `\n# Killed by signal ${signal} at ${finishedAt}\n`
    : `\n# Exit ${code} at ${finishedAt}\n`;
  logStream.write(summary);
  logStream.end(() => {
    console.error(`[fmn-222] log: ${LOG_FILE}`);
    process.exit(code ?? 1);
  });
});
