#!/usr/bin/env node
// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-151: long-lived Chromium for live column-alignment iteration.
//
// Run this once at the start of an FMN-151 session:
//   node tools/dev/fmn-151-browser.mjs
//
// It launches Chromium with the toolkit extension loaded, the persistent
// profile under tests/e2e/.profile-fmn-live/, and a CDP remote-debugging
// port. The window stays open until you Ctrl-C this process. Sign into
// FortiMonitor once in the opened window; subsequent runs of
// tests/e2e/columns-alignment-live.spec.js connect to this same browser
// via CDP and reuse the existing tab, so the operator never has to
// re-authenticate between fix-and-retest iterations (per memory rule
// keep_authenticated_chromium_alive_during_ticket).

import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const EXTENSION_PATH = path.resolve(REPO_ROOT, 'extension');
const PROFILE_DIR = path.resolve(REPO_ROOT, 'tests/e2e/.profile-fmn-live');
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const ALL_INSTANCES_URL = 'https://fortimonitor.forticloud.com/report/ListServers';

fs.mkdirSync(PROFILE_DIR, { recursive: true });

console.log(`\nFMN-151 dev browser launching...`);
console.log(`  Extension:  ${EXTENSION_PATH}`);
console.log(`  Profile:    ${PROFILE_DIR}`);
console.log(`  CDP port:   ${CDP_PORT}`);
console.log(`  Target URL: ${ALL_INSTANCES_URL}\n`);

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1400, height: 900 },
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    `--remote-debugging-port=${CDP_PORT}`,
  ],
});

// Open the All Instances page; the spec will find this tab by URL.
const pages = context.pages();
const page = pages.length > 0 ? pages[0] : await context.newPage();
await page.goto(ALL_INSTANCES_URL, { waitUntil: 'domcontentloaded' });

console.log('Chromium is running. Sign into FortiMonitor if prompted.');
console.log(`Connect via CDP at http://localhost:${CDP_PORT}.`);
console.log('Press Ctrl-C to stop.\n');

// Hold the process alive indefinitely. context.close() never runs.
await new Promise(() => {});
