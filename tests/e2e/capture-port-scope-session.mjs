// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-119 Phase 4 - one-time session cookie capture for port-scope live spec.
//
// Port Scope tools (Add / Remove from Port Scope - Fabric) use FortiMonitor
// session-cookie auth, not the v2 API key the other tools use. This script
// opens a headed Chromium with the extension loaded, lets the operator log
// in normally, then exports the FortiMonitor session cookies to a JSON
// fixture that the live spec can re-inject into its own context.
//
// Usage:
//   node tests/e2e/capture-port-scope-session.mjs
//
// Operator: a Chromium window opens to https://fortimonitor.forticloud.com.
// Log in normally (SSO bounces resolve transparently). When you land on a
// FortiMonitor page that has loaded successfully, press Enter in the
// terminal to capture and exit.
//
// The captured fixture lives at tests/e2e/.fixtures/fortimonitor-session.json
// (gitignored). Re-run when the session expires (the spec will skip
// itself if the fixture is missing).

import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXTENSION_PATH = path.resolve(__dirname, '../../extension');
const FIXTURE_DIR = path.resolve(__dirname, '.fixtures');
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'fortimonitor-session.json');

const TARGET = 'https://fortimonitor.forticloud.com/report/ListServers';

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmtoolkit-capture-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`
  ]
});

const page = context.pages()[0] ?? (await context.newPage());

console.log(`[capture] opening ${TARGET}`);
console.log('[capture] log in normally; press Enter here when the FortiMonitor UI has loaded.');
await page.goto(TARGET, { waitUntil: 'domcontentloaded' });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((resolve) => rl.question('[capture] Press Enter to capture cookies and exit. ', () => {
  rl.close();
  resolve();
}));

// Pull cookies for fortimonitor.forticloud.com. Drop anything that
// doesn't belong to that domain so we don't accidentally store
// unrelated third-party cookies in the fixture.
const allCookies = await context.cookies();
const fmCookies = allCookies.filter((c) =>
  typeof c.domain === 'string' && /fortimonitor\.forticloud\.com$/i.test(c.domain.replace(/^\./, ''))
);

if (fmCookies.length === 0) {
  console.error('[capture] No fortimonitor.forticloud.com cookies found. Did you authenticate?');
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  process.exit(1);
}

fs.mkdirSync(FIXTURE_DIR, { recursive: true });
const fixture = {
  capturedAt: new Date().toISOString(),
  origin: TARGET,
  cookies: fmCookies
};
fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
console.log(`[capture] wrote ${fmCookies.length} cookies to ${FIXTURE_PATH}`);

await context.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
process.exit(0);
