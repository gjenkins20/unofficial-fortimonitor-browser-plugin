// FMN-127: marketing-asset capture spec.
//
// Each test navigates to a tool's chrome-extension:// URL, optionally
// seeds stub data so the UI renders with realistic content (no tenant
// PII), and writes a PNG to docs/marketing/screenshots/.
//
// Run with: npm run capture:marketing
//
// Output is checked into git so README references are stable; rerun
// when shipping UI changes.

import { test, expect } from './fixtures.js';
import { test as baseTest } from '@playwright/test';
import { chromium } from '@playwright/test';
import { findServersStubScript } from '../e2e/stubs.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.resolve(__dirname, '../../docs/marketing/screenshots');

const FORTIMONITOR_ORIGIN = 'https://fortimonitor.forticloud.com';

function out(name) {
  return path.join(OUT_DIR, name);
}

// Seed a fake XSRF cookie + API keys so the popup renders in its
// configured/signed-in state rather than the "set this up first" state.
// Marketing screenshots should look like normal use, not first-run.
async function seedConfiguredState(extensionContext) {
  await extensionContext.addCookies([{
    name: 'XSRF-TOKEN',
    value: 'marketing-fake-xsrf',
    url: `${FORTIMONITOR_ORIGIN}/`
  }]);
  let sw = extensionContext.serviceWorkers()[0];
  if (!sw) {
    sw = await extensionContext.waitForEvent('serviceworker', { timeout: 10_000 });
  }
  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      'panopta.apiKey': 'marketing-fake-key',
      'claude.apiKey': 'marketing-fake-claude-key'
    });
  });
}

test('popup launcher (configured state)', async ({ extensionContext, extensionId }) => {
  await seedConfiguredState(extensionContext);
  const page = await extensionContext.newPage();
  // Popup CSS pins .popup width to 360px. Use a viewport just wider so
  // there's no horizontal whitespace from the body, and tall enough so
  // all tool cards fit without scroll.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await expect(page.locator('.tool-card').first()).toBeVisible();
  // Wait for the session-strip + guards to settle (sessionActive() and
  // apiKeyConfigured() are async; the popup only flips into configured
  // state after both resolve).
  await expect(page.locator('#session-strip.ok')).toBeVisible();
  await page.waitForTimeout(200);
  // Screenshot just the .popup element so we don't capture the empty
  // body area below the popup content.
  await page.locator('.popup').screenshot({ path: out('popup-launcher.png') });
});

// Per-tool entry-state captures. Entry state is the most universally
// informative shot: shows the tool's shell, purpose, and inputs without
// requiring a full simulated workflow per tool. Later phases can add
// Review / Results captures for tools where the start view isn't enough.
const TOOL_VIEWPORT = { width: 1280, height: 900 };

// Canned v2 API responses keyed by URL path. Tools that auto-load
// reference data on mount (attribute types, templates, OnSight
// instances, etc.) hit these endpoints with the seeded fake API key,
// which would otherwise return 401 and surface as ugly red banners.
// The data here is fake but realistically shaped.
// Each v2 endpoint has its own list-wrapper shape (parseListResponse uses
// `objects`, but listAttributeTypes / listTemplates use endpoint-named
// wrappers with `url` instead of `resource_uri`). Fixtures here mirror
// the shape each endpoint's parser actually expects.
const V2_FIXTURES = {
  '/server_attribute_type': {
    meta: { total_count: 5 },
    server_attribute_type_list: [
      { name: 'Environment',        textkey: 'Environment',  url: 'https://api2.panopta.com/v2/server_attribute_type/1' },
      { name: 'Site',               textkey: 'Site',         url: 'https://api2.panopta.com/v2/server_attribute_type/2' },
      { name: 'Owner',              textkey: 'Owner',        url: 'https://api2.panopta.com/v2/server_attribute_type/3' },
      { name: 'Cost Center',        textkey: 'CostCenter',   url: 'https://api2.panopta.com/v2/server_attribute_type/4' },
      { name: 'Maintenance Window', textkey: 'MaintWindow',  url: 'https://api2.panopta.com/v2/server_attribute_type/5' }
    ]
  },
  '/server_template': {
    meta: { total_count: 4 },
    server_template_list: [
      { name: 'Critical Infra',   template_type: 'standard', url: 'https://api2.panopta.com/v2/server_template/501', applied_servers: [], server_group: null },
      { name: 'Standard Linux',   template_type: 'standard', url: 'https://api2.panopta.com/v2/server_template/502', applied_servers: [], server_group: null },
      { name: 'Standard Windows', template_type: 'standard', url: 'https://api2.panopta.com/v2/server_template/503', applied_servers: [], server_group: null },
      { name: 'Network Edge',     template_type: 'standard', url: 'https://api2.panopta.com/v2/server_template/504', applied_servers: [], server_group: null }
    ]
  },
  '/onsight': {
    objects: [
      { id: 11, name: 'OnSight - HQ',      resource_uri: '/v2/onsight/11' },
      { id: 12, name: 'OnSight - DC East', resource_uri: '/v2/onsight/12' },
      { id: 13, name: 'OnSight - DC West', resource_uri: '/v2/onsight/13' }
    ]
  },
  '/server_group': {
    objects: [
      { id: 21, name: 'Production - WAN edges',   resource_uri: '/v2/server_group/21' },
      { id: 22, name: 'Production - Datacenter',  resource_uri: '/v2/server_group/22' },
      { id: 23, name: 'Staging',                  resource_uri: '/v2/server_group/23' }
    ]
  },
  '/appliance_group': {
    objects: [
      { id: 31, name: 'HA Pair - East', resource_uri: '/v2/appliance_group/31' },
      { id: 32, name: 'HA Pair - West', resource_uri: '/v2/appliance_group/32' }
    ]
  }
};

async function stubV2Api(context) {
  await context.route('https://api2.panopta.com/v2/**', async (route) => {
    const url = new URL(route.request().url());
    // Strip the /v2 prefix to match V2_FIXTURES keys.
    const path = url.pathname.replace(/^\/v2/, '');
    // First try an exact match, then a prefix match (e.g. /server_template/501).
    const fixture = V2_FIXTURES[path] ?? Object.entries(V2_FIXTURES)
      .find(([k]) => path.startsWith(k + '/'))?.[1];
    if (fixture) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture)
      });
    } else {
      // Default: empty list shape so unknown endpoints don't error.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ objects: [] })
      });
    }
  });
}

const TOOLS = [
  { name: 'remove-port-scope',     path: 'src/ui/app.html',                            ready: '#app-root *' },
  { name: 'add-port-scope',        path: 'src/ui/app.html?tool=add',                   ready: '#app-root *' },
  { name: 'add-fabric-connection', path: 'src/ui/fabric-connection/app.html',          ready: '#app-root *' },
  { name: 'manage-attributes',     path: 'src/ui/attribute-management/app.html',       ready: '#app-root *' },
  { name: 'manage-templates',      path: 'src/ui/template-management/app.html',        ready: '#app-root *' },
  { name: 'server-id-lookup',      path: 'src/ui/server-lookup/app.html',              ready: '#app-root *' }
  // Ask AI and Find Servers are captured separately below:
  //   - Ask AI: needs a sample conversation injected (empty chat is a
  //     weak marketing shot).
  //   - Find Servers: the default criterion row is field-type=attribute,
  //     and the suggestions-loaded subscriber doesn't refresh existing
  //     rows, so the first row stays in "Loading attribute names…" state.
  //     We change the criterion to a clean Name=value pair before capture.
];

for (const tool of TOOLS) {
  test(`tool entry: ${tool.name}`, async ({ extensionContext, extensionId }) => {
    await seedConfiguredState(extensionContext);
    await stubV2Api(extensionContext);
    const page = await extensionContext.newPage();
    await page.setViewportSize(TOOL_VIEWPORT);
    await page.goto(`chrome-extension://${extensionId}/${tool.path}`);
    await expect(page.locator(tool.ready).first()).toBeVisible({ timeout: 10_000 });
    // Give async API loads a beat to populate dropdowns before capture.
    await page.waitForTimeout(800);
    await page.screenshot({
      path: out(`tool-${tool.name}.png`),
      fullPage: true
    });
  });
}

// Ask AI: inject a sample conversation directly into #messages so the
// chat looks lived-in. DOM structure mirrors appendMessage() and
// appendToolCallEl() in extension/src/ui/ask-claude/app.js.
test('tool entry: ask-ai (with sample conversation)', async ({ extensionContext, extensionId }) => {
  await seedConfiguredState(extensionContext);
  await stubV2Api(extensionContext);
  const page = await extensionContext.newPage();
  await page.setViewportSize(TOOL_VIEWPORT);
  await page.goto(`chrome-extension://${extensionId}/src/ui/ask-claude/app.html`);
  await expect(page.locator('#composer-input')).toBeVisible({ timeout: 10_000 });

  // Inject a 3-turn conversation: user question -> tool call -> assistant answer.
  await page.evaluate(() => {
    const messages = document.getElementById('messages');
    if (!messages) return;
    messages.innerHTML = '';

    const addMsg = (kind, text) => {
      const el = document.createElement('div');
      el.className = `msg ${kind}`;
      el.textContent = text;
      messages.appendChild(el);
    };
    const addToolCall = (name, input, resultText) => {
      const el = document.createElement('div');
      el.className = 'msg tool';
      const header = document.createElement('div');
      header.innerHTML = `<span class="tool-name">⚙ ${name}</span>`;
      el.appendChild(header);
      const det = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = 'input';
      det.appendChild(sum);
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(input, null, 2);
      det.appendChild(pre);
      el.appendChild(det);
      if (resultText) {
        const det2 = document.createElement('details');
        const sum2 = document.createElement('summary');
        sum2.textContent = 'result';
        det2.appendChild(sum2);
        const pre2 = document.createElement('pre');
        pre2.textContent = resultText;
        det2.appendChild(pre2);
        el.appendChild(det2);
      }
      const statusLine = document.createElement('div');
      statusLine.className = 'tool-status';
      statusLine.textContent = 'done';
      el.appendChild(statusLine);
      messages.appendChild(el);
    };

    addMsg('user', 'What outages are active right now? Give me the top 3 by duration.');
    addToolCall(
      'list_outages',
      { active: true, limit: 50 },
      JSON.stringify({
        outages: [
          { server_name: 'edge-fgt-04', started_at: '2026-04-30T11:42:00Z', duration_min: 78, severity: 'critical', service: 'ICMP' },
          { server_name: 'dc-east-router-02', started_at: '2026-04-30T12:15:00Z', duration_min: 45, severity: 'high', service: 'BGP peer' },
          { server_name: 'staging-lnx-01', started_at: '2026-04-30T12:38:00Z', duration_min: 22, severity: 'medium', service: 'SSH' }
        ],
        total: 7
      }, null, 2)
    );
    addMsg('assistant',
      "There are 7 active outages right now. The longest-running three:\n\n" +
      "  1. edge-fgt-04 - 78 min - ICMP unreachable (critical)\n" +
      "  2. dc-east-router-02 - 45 min - BGP peer down (high)\n" +
      "  3. staging-lnx-01 - 22 min - SSH probe failing (medium)\n\n" +
      "edge-fgt-04 has been down longest. Want me to pull its recent agent_resource history or check related fabric connections?"
    );
  });

  await page.waitForTimeout(300);
  await page.screenshot({
    path: out('tool-ask-ai.png'),
    fullPage: true
  });
});

// Find Servers: change the default attribute criterion to a Name=value
// pair so the screenshot doesn't show "Loading attribute names…" (the
// suggestions-loaded subscriber in start.js doesn't refresh existing
// criterion rows). Pre-fill identifiers to make the shot lived-in.
test('tool entry: find-servers (populated query)', async ({ extensionContext, extensionId }) => {
  await seedConfiguredState(extensionContext);
  await stubV2Api(extensionContext);
  const page = await extensionContext.newPage();
  await page.setViewportSize(TOOL_VIEWPORT);
  await page.goto(`chrome-extension://${extensionId}/src/ui/server-search/app.html`);
  await expect(page.locator('#app-root *').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);

  // Pre-fill identifiers paste area.
  await page.locator('textarea.paste-area').first().fill(
    'FGVM01TM24006844\n' +
    'FGVM02TM24006845\n' +
    'edge-fgt-04'
  );

  // Switch the default criterion's field type from "attribute" to "name"
  // so we get a clean string-comparison row instead of the stale
  // "Loading attribute names…" combobox.
  const fieldSelect = page.locator('.criterion-row select.select').first();
  await fieldSelect.selectOption('name');
  await page.waitForTimeout(150);

  // Fill the value input on the rebuilt criterion row.
  const valueInput = page.locator('.criterion-row input.paste-area');
  await valueInput.fill('edge-');

  await page.waitForTimeout(200);
  await page.screenshot({ path: out('tool-find-servers.png'), fullPage: true });
});

// Social preview: 1280x640 OpenGraph card. Self-contained HTML/CSS so
// the design stays sharp at GitHub's social-preview crop. Output goes
// to docs/marketing/social-preview.png; set via repo settings ->
// Social preview -> Upload an image.
//
// This test does NOT need the extension, so it runs in true headless
// (no visible window, no focus stealing) instead of the headed-but-
// offscreen extension context used by the rest of the spec.
baseTest('social preview (OpenGraph card)', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 640 } });
    const page = await ctx.newPage();
    const fileUrl = 'file://' + path.resolve(__dirname, 'social-preview.html');
    await page.goto(fileUrl);
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(200);
    await page.screenshot({
      path: path.resolve(__dirname, '../../docs/marketing/social-preview.png'),
      clip: { x: 0, y: 0, width: 1280, height: 640 }
    });
  } finally {
    await browser.close();
  }
});

// Hero flow: Add Fabric Connection 4-step flow, captured as key frames.
// Frames feed into ffmpeg post-process (see scripts/build-hero-gif.sh)
// to produce docs/marketing/hero.gif.
const FRAMES_DIR = path.resolve(__dirname, '../../docs/marketing/frames');
function frame(name) {
  return path.join(FRAMES_DIR, name);
}

// Stub the fabric_connection POST so live mode could complete without
// hitting api2 - and so dry-run, which does NOT POST, is unaffected.
async function stubFabricCreate(context) {
  await context.route('https://api2.panopta.com/v2/fabric_connection', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 17000 + Math.floor(Math.random() * 1000),
        url: 'https://api2.panopta.com/v2/fabric_connection/17042'
      })
    });
  });
}

test('hero flow: add fabric connection (4 frames)', async ({ extensionContext, extensionId }) => {
  await seedConfiguredState(extensionContext);
  await stubV2Api(extensionContext);
  await stubFabricCreate(extensionContext);

  // ---- Frame 1: Popup launcher ----
  // Render the popup at hero viewport so the @media (min-width: 500px) rule
  // engages: popup centers as a card on the backdrop, matching the wizard
  // frames' visual language. Captures all tool tiles in one shot.
  const popupPage = await extensionContext.newPage();
  await popupPage.setViewportSize(TOOL_VIEWPORT);
  await popupPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await expect(popupPage.locator('.tool-card').first()).toBeVisible();
  await expect(popupPage.locator('#session-strip.ok')).toBeVisible();
  await popupPage.waitForTimeout(300);
  await popupPage.screenshot({ path: frame('01-popup.png'), fullPage: true });
  await popupPage.close();

  const page = await extensionContext.newPage();
  await page.setViewportSize(TOOL_VIEWPORT);
  await page.goto(`chrome-extension://${extensionId}/src/ui/fabric-connection/app.html`);

  // ---- Frame 2: Load devices (wizard step 1, filled) ----
  // Wait for the dropdowns to populate (via stubbed list endpoints).
  await expect(page.locator('select.select').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const opts = document.querySelectorAll('select.select option');
    return Array.from(opts).some((o) => o.textContent && !o.textContent.includes('Loading'));
  }, { timeout: 10_000 });

  // Fill paste area with 3 sample devices (matches real CSV format).
  await page.locator('textarea.paste-area').fill(
    'serial,ip,port\n' +
    'FGVM01TM24006844,10.0.0.94,8013\n' +
    'FGVM02TM24006845,10.0.0.95,8013\n' +
    'FGVM03TM24006846,10.0.0.96,8013'
  );
  await page.waitForTimeout(300);

  // Pick first OnSight (skip "- Select -" placeholder option).
  const onsight = page.locator('select.select').nth(0);
  await onsight.selectOption({ index: 1 });
  // Pick first Server group.
  const sg = page.locator('select.select').nth(1);
  await sg.selectOption({ index: 1 });
  await page.waitForTimeout(300);

  await page.screenshot({ path: frame('02-load.png'), fullPage: true });

  // ---- Frame 3: Review ----
  await page.locator('button.btn-primary', { hasText: 'Continue' }).click();
  await expect(page.locator('table.review-table')).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: frame('03-review.png'), fullPage: true });

  // ---- Frame 4: Results ----
  // The Execute step auto-runs fc:create-batch on entry; dry-run is
  // synchronous (no per-device delay) so the wizard auto-advances to
  // Results faster than we can reliably capture an in-progress state.
  // The hero shows the user-meaningful before/after instead.
  await page.locator('button.btn-primary', { hasText: 'Execute' }).click();
  // Detect Results step via its title, since both Review and Results
  // render a .review-table - waiting on the table alone is ambiguous.
  await expect(page.locator('.title-bar .subtitle', { hasText: /Results/ })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: frame('04-results.png'), fullPage: true });
});
