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

const COOKIE_STORE = path.resolve(REPO_ROOT, 'tests/e2e/.profile-fmn-live-cookies.json');

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1400, height: 900 },
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    `--remote-debugging-port=${CDP_PORT}`,
  ],
});

// Cookie persistence: Chromium's persistent context preserves cookies
// across SW restarts but session-only cookies (expires=-1) die on
// process death. To survive accidental kills, we mirror FortiMonitor
// cookies to a JSON file and re-inject on startup with an extended
// expiry so the operator does not have to re-authenticate after every
// Chromium restart. Combined with the keepalive below, the result is a
// session that survives both browser exits and server-side TTL.
async function loadPersistedCookies() {
  try {
    if (!fs.existsSync(COOKIE_STORE)) return;
    const raw = fs.readFileSync(COOKIE_STORE, 'utf-8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;
    const now = Math.floor(Date.now() / 1000);
    const usable = list.filter((c) => !c.expires || c.expires === -1 || c.expires > now);
    if (usable.length === 0) return;
    await context.addCookies(usable);
    console.log(`[cookies] restored ${usable.length} from ${COOKIE_STORE}`);
  } catch (e) {
    console.log(`[cookies] restore failed: ${e?.message ?? e}`);
  }
}
async function savePersistedCookies() {
  try {
    const cookies = await context.cookies();
    const interesting = cookies.filter((c) => /fortimonitor|forticloud/.test(c.domain));
    if (interesting.length === 0) return;
    // Extend session-only cookies to 24 hours so they survive a process
    // restart. Server-side validity is still enforced; this only keeps
    // the cookie on disk for re-injection.
    const now = Math.floor(Date.now() / 1000);
    const stamped = interesting.map((c) => ({
      ...c,
      expires: c.expires && c.expires > now ? c.expires : now + 24 * 60 * 60,
    }));
    fs.writeFileSync(COOKIE_STORE, JSON.stringify(stamped, null, 2));
  } catch (e) {
    console.log(`[cookies] save failed: ${e?.message ?? e}`);
  }
}
await loadPersistedCookies();

// Open the All Instances page; the spec will find this tab by URL.
const pages = context.pages();
const page = pages.length > 0 ? pages[0] : await context.newPage();
await page.goto(ALL_INSTANCES_URL, { waitUntil: 'domcontentloaded' });

console.log('Chromium is running. Sign into FortiMonitor if prompted.');
console.log(`Connect via CDP at http://localhost:${CDP_PORT}.`);
console.log('Press Ctrl-C to stop.\n');

// Session keepalive: every 4 minutes, hit a lightweight authenticated
// endpoint in the existing tab to extend the FortiMonitor session cookie.
// FortiMonitor's session TTL appears to be in the 15-30 minute range
// based on observation, so 4 minutes gives generous margin. We hit the
// All Instances page itself (HEAD-style via a no-op script eval) rather
// than the v2 API to avoid mixing API-key auth with the session.
const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000;
const KEEPALIVE_URL = 'https://fortimonitor.forticloud.com/report/ListServers';
setInterval(async () => {
  try {
    const target = context.pages().find((p) => p.url().includes('fortimonitor'));
    if (!target) return;
    // Cheap session-extending fetch from page context. No nav, no full
    // page reload - just a credentialed request to keep the cookie warm.
    const status = await target.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include', cache: 'no-store' });
        return r.status;
      } catch {
        return null;
      }
    }, KEEPALIVE_URL);
    if (status) console.log(`[keepalive] ${new Date().toISOString()} status=${status}`);
    // Snapshot cookies after each successful keepalive so a Chromium
    // crash / accidental kill loses at most one keepalive interval of
    // session state.
    await savePersistedCookies();
  } catch (e) {
    console.log(`[keepalive] failed: ${e?.message ?? e}`);
  }
}, KEEPALIVE_INTERVAL_MS);

// Save cookies once on every successful navigation so the very first
// login is captured before the keepalive interval elapses.
context.on('page', (p) => {
  p.on('load', () => savePersistedCookies());
});

// Hold the process alive indefinitely. context.close() never runs.
await new Promise(() => {});
