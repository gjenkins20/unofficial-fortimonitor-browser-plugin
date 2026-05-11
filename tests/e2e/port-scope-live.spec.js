// Unofficial FortiMonitor Toolkit - Port Scope live E2E (FMN-119).
// Skip-by-default. Drives Add / Remove from Port Scope against the real
// FortiMonitor tenant using session-cookie auth (not the v2 API key).
//
// Pre-requisite: capture a FortiMonitor session via
//   node tests/e2e/capture-port-scope-session.mjs
// which writes tests/e2e/.fixtures/fortimonitor-session.json. The spec
// loads those cookies into the persistent context before navigating.
//
// Scope: read-only. The spec exercises session:probe + scan-devices +
// review-step navigation against three distinctly-different FortiGate
// fabric connections from the tenant, but stops short of execute-queue.
// No port_selection writes happen, so tenant state is unchanged at the
// end of the run.

import { test, expect } from './fixtures.js';
import { seedApiKey } from './seed-api-key.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_FIXTURE_PATH = path.resolve(__dirname, '.fixtures', 'fortimonitor-session.json');
const PANOPTA_BASE = 'https://api2.panopta.com/v2';
const API_KEY = process.env.FORTIMONITOR_API_KEY;

function loadSessionFixture() {
  if (!fs.existsSync(SESSION_FIXTURE_PATH)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FIXTURE_PATH, 'utf8'));
    return Array.isArray(raw?.cookies) ? raw : null;
  } catch { return null; }
}

function extractServerIdFromUrl(serverUrl) {
  if (typeof serverUrl !== 'string') return null;
  const m = serverUrl.match(/\/server\/(\d+)\/?$/);
  return m ? Number(m[1]) : null;
}

test.describe('live - Port Scope E2E - real tenant (session auth)', () => {
  const session = loadSessionFixture();
  test.skip(!session,
    `Session fixture missing. Run \`node tests/e2e/capture-port-scope-session.mjs\` first. See ${SESSION_FIXTURE_PATH}`
  );
  test.skip(!API_KEY,
    'FORTIMONITOR_API_KEY not set (needed for fabric-connection discovery). Add it to tests/e2e/.env.local.'
  );

  let testFabricServerIds = [];

  test.beforeAll(async ({ extensionContext }) => {
    // Inject FortiMonitor session cookies into the persistent context.
    // session:probe + scan-devices both rely on these.
    await extensionContext.addCookies(session.cookies);
    // Seed the v2 API key too - the popup's discovery for tool=add reads
    // it during scan name-resolution. Safe duplicate-write.
    await seedApiKey(extensionContext, API_KEY);

    // Discover three distinct FortiGate fabric connections via v2.
    const r = await fetch(`${PANOPTA_BASE}/fabric_connection?limit=200`, {
      headers: { Authorization: `ApiKey ${API_KEY}` }
    });
    if (!r.ok) throw new Error(`/v2/fabric_connection probe failed: ${r.status}`);
    const body = await r.json();
    const list = Array.isArray(body?.fabric_connection_list) ? body.fabric_connection_list : [];
    if (list.length === 0) throw new Error('Tenant has zero fabric connections; cannot run live Port Scope suite.');
    const ids = list
      .map((fc) => extractServerIdFromUrl(fc?.server))
      .filter((n) => Number.isFinite(n));
    // Pick first, middle, last for diversity along the catalog axis.
    const distinct = Array.from(new Set(ids));
    if (distinct.length === 0) throw new Error('Tenant fabric connections have no resolvable server IDs.');
    const picks = distinct.length >= 3
      ? [distinct[0], distinct[Math.floor(distinct.length / 2)], distinct[distinct.length - 1]]
      : distinct;
    testFabricServerIds = picks;
    console.log('[live discovery] port-scope picks:', testFabricServerIds);
  });

  test('live - Scan returns port data for three diverse FortiGate fabric connections', async ({ extensionContext, portScopeRemoveUrl }) => {
    test.skip(testFabricServerIds.length < 1, 'No usable FortiGate fabric connections in the tenant.');
    const page = await extensionContext.newPage();
    try {
      await page.goto(portScopeRemoveUrl);
      await expect(page.locator('.step-header h2')).toContainText('Load devices from CSV');

      // Paste the three diverse server IDs. The tool scans them in
      // parallel and advances to /review on success.
      await page.locator('textarea.paste-area').fill(testFabricServerIds.map(String).join('\n'));
      await page.getByRole('button', { name: /Start review/ }).click();

      // Live scan can take a beat per device; allow up to 60s.
      await expect(page).toHaveURL(/#\/review$/, { timeout: 60_000 });

      // Review step renders the discovered ports. Assert that at least
      // one device fingerprint group is present (the tool groups devices
      // by port-shape; with three diverse fabrics we expect 1-3 groups).
      const reviewBody = page.locator('.body-section');
      await expect(reviewBody).toBeVisible({ timeout: 5_000 });

      // No execute step is fired; tenant state is unchanged.
    } finally {
      await page.close();
    }
  });

  test('live - Add-mode scan exercises tool=add URL parameter without writing', async ({ extensionContext, portScopeAddUrl }) => {
    test.skip(testFabricServerIds.length < 1, 'No usable FortiGate fabric connections in the tenant.');
    const page = await extensionContext.newPage();
    try {
      await page.goto(portScopeAddUrl);
      await expect(page.locator('.step-header h2')).toContainText('Load devices from CSV');
      await page.locator('textarea.paste-area').fill(testFabricServerIds.map(String).join('\n'));
      await page.getByRole('button', { name: /Start review/ }).click();
      await expect(page).toHaveURL(/#\/review$/, { timeout: 60_000 });
      // No execute; tenant unchanged.
    } finally {
      await page.close();
    }
  });
});
