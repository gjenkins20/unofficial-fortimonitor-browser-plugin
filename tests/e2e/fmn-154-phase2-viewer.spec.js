// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-154 Phase 2.3 + 2.4: Playwright spec for the snapshot picker
// dropdowns + multi-tab diff viewer. Same harness pattern as
// fmn-161-snapshot-export-import.spec.js: routed URL, inlined HTML, the
// SW handler surface stubbed in-page.
//
// Run: npx playwright test tests/e2e/fmn-154-phase2-viewer.spec.js

import { test as base, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML = path.resolve(__dirname, '../../extension/src/ui/tenant-observations-diff/app.html');
const APP_JS = path.resolve(__dirname, '../../extension/src/ui/tenant-observations-diff/app.js');
const ROUTED_URL = 'https://harness.test/observations-diff-phase2/';

const test = base.extend({
  ctx: [async ({}, use) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await use(context);
    await context.close();
    await browser.close();
  }, { scope: 'worker' }],
});

function buildPageHtml({ snapshots, diffsById }) {
  const html = fs.readFileSync(APP_HTML, 'utf-8');
  const appJs = fs.readFileSync(APP_JS, 'utf-8');
  const inlinedHtml = html
    .replace(/<link rel="stylesheet"[^>]*>/, '')
    .replace(/<script src="app\.js" type="module"><\/script>/, `<script>${appJs}<\/script>`);
  const shim = `
    <script>
      const __snapshots = ${JSON.stringify(snapshots)};
      const __diffs = ${JSON.stringify(diffsById)};
      let __diffCalls = [];
      const empty = { added: [], removed: [], modified: [] };
      const handlers = {
        'observations-snapshots:list': async () => ({ ok: true, items: __snapshots }),
        'observations-snapshots:diff': async (payload) => {
          __diffCalls.push(payload);
          const key = (payload && payload.baselineId && payload.currentId)
            ? payload.baselineId + '|' + payload.currentId
            : '__default__';
          const sections = __diffs[key] || {
            servers: empty, users: empty, server_templates: empty, server_groups: empty,
          };
          const counts = {
            added: sections.servers.added.length,
            removed: sections.servers.removed.length,
            modified: sections.servers.modified.length,
          };
          const baseline = __snapshots.find((s) => s.id === payload?.baselineId);
          const current = __snapshots.find((s) => s.id === payload?.currentId);
          return {
            ok: true,
            prevTakenAt: baseline?.takenAt ?? __snapshots[1]?.takenAt ?? null,
            currTakenAt: current?.takenAt ?? __snapshots[0]?.takenAt ?? null,
            servers: sections.servers,
            counts,
            sections,
          };
        },
        // The phase-1 viewer also calls :status / :export on render;
        // stub them so they don't error out the page.
        'observations-snapshots:status': async () => ({
          hasCurrent: __snapshots.length >= 1,
          hasPrevious: __snapshots.length >= 2,
          currentTakenAt: __snapshots[0]?.takenAt ?? null,
          previousTakenAt: __snapshots[1]?.takenAt ?? null,
          runInFlight: false,
          runStartedAt: null,
        }),
        'observations-snapshots:export': async () => ({ ok: false, reason: 'empty-slot', message: 'no' }),
      };
      window.chrome = {
        runtime: {
          getManifest: () => ({ version: '1.6.3-test' }),
          sendMessage: (msg, cb) => {
            const fn = handlers[msg.type];
            if (!fn) { cb({ ok: false, error: 'no handler: ' + msg.type }); return; }
            Promise.resolve()
              .then(() => fn(msg.payload))
              .then((result) => cb({ ok: true, result }))
              .catch((err) => cb({ ok: false, error: err?.message || String(err) }));
          },
          lastError: null,
        },
      };
      window.__diffCalls = () => __diffCalls;
    </script>
  `;
  return inlinedHtml.replace('</head>', shim + '</head>');
}

async function gotoApp(ctx, { snapshots, diffsById }) {
  const page = await ctx.newPage();
  await page.route(ROUTED_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: buildPageHtml({ snapshots, diffsById }),
    });
  });
  await page.goto(ROUTED_URL);
  await page.waitForSelector('#baseline-select', { timeout: 5_000 });
  return page;
}

function snapshotSummary(id, takenAt, slot, counts = {}) {
  return {
    id,
    takenAt,
    customer: { id: 1, name: 'Acme Co', subdomain: 'acme' },
    durationMs: 60_000,
    counts: { servers: 0, users: 0, server_templates: 0, server_groups: 0, ...counts },
    slot,
  };
}

test.describe('FMN-154 Phase 2: picker + multi-tab viewer', () => {

  test('picker dropdowns list all stored snapshots; defaults to current+previous', async ({ ctx }) => {
    const page = await gotoApp(ctx, {
      snapshots: [
        snapshotSummary('snap-c', '2026-05-12T00:00:00.000Z', 'current'),
        snapshotSummary('snap-p', '2026-05-11T00:00:00.000Z', 'previous'),
        snapshotSummary('snap-h0', '2026-05-10T00:00:00.000Z', 'history-0'),
      ],
      diffsById: {
        'snap-p|snap-c': {
          servers: { added: [], removed: [], modified: [] },
          users: { added: [], removed: [], modified: [] },
          server_templates: { added: [], removed: [], modified: [] },
          server_groups: { added: [], removed: [], modified: [] },
        },
      },
    });
    // Both selects exist and carry 3 options.
    await expect(page.locator('#baseline-select option')).toHaveCount(3);
    await expect(page.locator('#current-select option')).toHaveCount(3);
    // Defaults: current = newest, baseline = previous.
    await expect(page.locator('#current-select')).toHaveValue('snap-c');
    await expect(page.locator('#baseline-select')).toHaveValue('snap-p');
  });

  test('changing the baseline dropdown triggers a fresh diff with the new pair', async ({ ctx }) => {
    const page = await gotoApp(ctx, {
      snapshots: [
        snapshotSummary('snap-c', '2026-05-12T00:00:00.000Z', 'current'),
        snapshotSummary('snap-p', '2026-05-11T00:00:00.000Z', 'previous'),
        snapshotSummary('snap-h0', '2026-05-10T00:00:00.000Z', 'history-0'),
      ],
      diffsById: {
        'snap-p|snap-c': {
          servers: { added: [], removed: [], modified: [] },
          users: { added: [], removed: [], modified: [] },
          server_templates: { added: [], removed: [], modified: [] },
          server_groups: { added: [], removed: [], modified: [] },
        },
        'snap-h0|snap-c': {
          servers: { added: [{ id: 99, change: 'added', current: { name: 'new-fw', fqdn: '10.0.0.99' } }], removed: [], modified: [] },
          users: { added: [], removed: [], modified: [] },
          server_templates: { added: [], removed: [], modified: [] },
          server_groups: { added: [], removed: [], modified: [] },
        },
      },
    });
    await page.locator('#baseline-select').selectOption('snap-h0');
    // Wait for the diff to repaint with the new pair (the table row for 'new-fw' is unique to the second diff).
    await expect(page.locator('table.diff tbody tr')).toContainText('new-fw');
    const calls = await page.evaluate(() => window.__diffCalls());
    // Final call should be for the new pair.
    const last = calls[calls.length - 1];
    expect(last).toEqual({ baselineId: 'snap-h0', currentId: 'snap-c' });
  });

  test('tab strip exposes all four sections with per-section change counts', async ({ ctx }) => {
    const page = await gotoApp(ctx, {
      snapshots: [
        snapshotSummary('snap-c', '2026-05-12T00:00:00.000Z', 'current'),
        snapshotSummary('snap-p', '2026-05-11T00:00:00.000Z', 'previous'),
      ],
      diffsById: {
        'snap-p|snap-c': {
          servers: { added: [{ id: 1, change: 'added', current: { name: 's1' } }], removed: [], modified: [] },
          users: { added: [], removed: [{ id: 2, change: 'removed', previous: { username: 'u' } }], modified: [] },
          server_templates: { added: [], removed: [], modified: [] },
          server_groups: { added: [], removed: [], modified: [{ id: 3, change: 'modified', previous: { name: 'A' }, current: { name: 'B' }, fields: [{ name: 'name', prev: 'A', next: 'B' }] }] },
        },
      },
    });
    const tabs = page.locator('.tab-strip button.tab');
    await expect(tabs).toHaveCount(4);
    // Each tab shows its section's total change count.
    await expect(tabs.nth(0)).toContainText('Instances');
    await expect(tabs.nth(0).locator('.tab-count')).toHaveText('1');
    await expect(tabs.nth(1)).toContainText('Templates');
    await expect(tabs.nth(1).locator('.tab-count')).toHaveText('0');
    await expect(tabs.nth(2)).toContainText('Users');
    await expect(tabs.nth(2).locator('.tab-count')).toHaveText('1');
    await expect(tabs.nth(3)).toContainText('Server Groups');
    await expect(tabs.nth(3).locator('.tab-count')).toHaveText('1');
  });

  test('clicking a non-Instances tab switches the visible diff to that section', async ({ ctx }) => {
    const page = await gotoApp(ctx, {
      snapshots: [
        snapshotSummary('snap-c', '2026-05-12T00:00:00.000Z', 'current'),
        snapshotSummary('snap-p', '2026-05-11T00:00:00.000Z', 'previous'),
      ],
      diffsById: {
        'snap-p|snap-c': {
          servers: { added: [{ id: 1, change: 'added', current: { name: 'just-a-server' } }], removed: [], modified: [] },
          users: { added: [{ id: 7, change: 'added', current: { first_name: 'Ada', last_name: 'Lovelace', username: 'alove' } }], removed: [], modified: [] },
          server_templates: { added: [], removed: [], modified: [] },
          server_groups: { added: [], removed: [], modified: [] },
        },
      },
    });
    // Instances tab is active on first paint; user row should not be in the table.
    await expect(page.locator('table.diff')).toContainText('just-a-server');
    await expect(page.locator('table.diff')).not.toContainText('Ada Lovelace');
    await page.locator('.tab-strip button.tab', { hasText: 'Users' }).click();
    await expect(page.locator('table.diff th').nth(1)).toHaveText('User');
    await expect(page.locator('table.diff')).toContainText('Ada Lovelace');
  });

  test('section with zero changes renders the appropriate empty-state copy', async ({ ctx }) => {
    const page = await gotoApp(ctx, {
      snapshots: [
        snapshotSummary('snap-c', '2026-05-12T00:00:00.000Z', 'current'),
        snapshotSummary('snap-p', '2026-05-11T00:00:00.000Z', 'previous'),
      ],
      diffsById: {
        'snap-p|snap-c': {
          servers: { added: [], removed: [], modified: [] },
          users: { added: [], removed: [], modified: [] },
          server_templates: { added: [], removed: [], modified: [] },
          server_groups: { added: [], removed: [], modified: [] },
        },
      },
    });
    await page.locator('.tab-strip button.tab', { hasText: 'Templates' }).click();
    await expect(page.locator('table.diff')).toContainText('No templates changes');
  });

  test('one-snapshot store renders the no-diff empty-state, no tab strip', async ({ ctx }) => {
    const page = await gotoApp(ctx, {
      snapshots: [snapshotSummary('snap-only', '2026-05-12T00:00:00.000Z', 'current')],
      diffsById: {},
    });
    await expect(page.locator('#content')).toContainText('Only one snapshot stored');
    await expect(page.locator('.tab-strip')).toHaveCount(0);
  });
});
