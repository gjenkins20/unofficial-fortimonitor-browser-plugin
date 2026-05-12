#!/usr/bin/env node
// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
//
// Persistent Dev Launcher.
//
// Single long-lived Chromium with the toolkit extension loaded, a persistent
// profile under tests/e2e/.profile-fmn-live/, and a CDP remote-debugging port
// on 9222. Start it once at the beginning of a work session; sign into
// FortiMonitor in the opened window; leave it running. Specs and ad-hoc
// scripts connect via CDP and reuse the existing tab, so authentication
// survives across fix-and-retest iterations.
//
// Memory rules this enforces:
//   - keep_authenticated_chromium_alive_during_ticket
//   - refresh_live_session_proactively
//
// Usage:
//   node tools/dev/launcher.mjs
//   node tools/dev/launcher.mjs --target /report/Reports
//   FMN_TARGET_URL=/report/Reports node tools/dev/launcher.mjs
//   FMN_CDP_PORT=9333 node tools/dev/launcher.mjs   (run alongside another launcher)
//
// Press Ctrl-C to stop.

import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const EXTENSION_PATH = path.resolve(REPO_ROOT, 'extension');
const PROFILE_DIR = path.resolve(REPO_ROOT, 'tests/e2e/.profile-fmn-live');
const COOKIE_STORE = path.resolve(REPO_ROOT, 'tests/e2e/.profile-fmn-live-cookies.json');
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const FM_ORIGIN = 'https://fortimonitor.forticloud.com';

function parseTarget() {
  const flagIdx = process.argv.indexOf('--target');
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) return process.argv[flagIdx + 1];
  if (process.env.FMN_TARGET_URL) return process.env.FMN_TARGET_URL;
  return '/report/ListServers';
}

function resolveTargetUrl(target) {
  if (/^https?:\/\//i.test(target)) return target;
  return FM_ORIGIN + (target.startsWith('/') ? target : '/' + target);
}

const TARGET_URL = resolveTargetUrl(parseTarget());

fs.mkdirSync(PROFILE_DIR, { recursive: true });

console.log('\nFortiMonitor Toolkit dev launcher starting...');
console.log(`  Extension:   ${EXTENSION_PATH}`);
console.log(`  Profile:     ${PROFILE_DIR}`);
console.log(`  CDP port:    ${CDP_PORT}`);
console.log(`  Target URL:  ${TARGET_URL}\n`);

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1400, height: 900 },
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    `--remote-debugging-port=${CDP_PORT}`,
    // Extension tests cannot use true headless mode (the extension's
    // content scripts only run in a real browser). Keep the window offscreen
    // + minimized so the operator's display stays clean.
    '--window-position=-32000,-32000',
    '--start-minimized',
  ],
});

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

const pages = context.pages();
const page = pages.length > 0 ? pages[0] : await context.newPage();
await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' }).catch((e) => {
  console.log(`[nav] initial nav failed (likely auth gate, harmless): ${e?.message ?? e}`);
});

console.log('Chromium is running. Sign into FortiMonitor if prompted.');
console.log(`Connect via CDP at http://localhost:${CDP_PORT}.`);
console.log('Press Ctrl-C to stop.\n');

const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000;
const KEEPALIVE_URL = FM_ORIGIN + '/report/ListServers';
setInterval(async () => {
  try {
    const target = context.pages().find((p) => p.url().includes('fortimonitor'));
    if (!target) return;
    const status = await target.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include', cache: 'no-store' });
        return r.status;
      } catch {
        return null;
      }
    }, KEEPALIVE_URL);
    if (status) console.log(`[keepalive] ${new Date().toISOString()} status=${status}`);
    await savePersistedCookies();
  } catch (e) {
    console.log(`[keepalive] failed: ${e?.message ?? e}`);
  }
}, KEEPALIVE_INTERVAL_MS);

context.on('page', (p) => {
  p.on('load', () => savePersistedCookies());
});

await new Promise(() => {});
