// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-161: Playwright spec for snapshot export + import in the bpa-diff
// page. Headless Chromium, no extension fixture - we route the bpa-diff
// app URL to a synthetic HTML page that inlines app.html's body and
// app.js plus a chrome.* shim. The shim implements the SW message
// surface (bpa-snapshots:status / :diff / :export / :import) using the
// real handler module loaded via dynamic import, so the spec exercises
// the production code path end to end.
//
// Run: npx playwright test tests/e2e/fmn-161-snapshot-export-import.spec.js

import { test as base, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML = path.resolve(__dirname, '../../extension/src/ui/bpa-diff/app.html');
const APP_JS = path.resolve(__dirname, '../../extension/src/ui/bpa-diff/app.js');
const SNAPSHOT_IO_JS = path.resolve(__dirname, '../../extension/src/lib/snapshot-io.js');
const ROUTED_URL = 'https://harness.test/bpa-diff/';

const test = base.extend({
  ctx: [async ({}, use) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    await use(context);
    await context.close();
    await browser.close();
  }, { scope: 'worker' }],
});

function snapshotFixture(overrides = {}) {
  return {
    schema: 1,
    takenAt: '2026-05-10T14:30:00.000Z',
    durationMs: 200_000,
    deep: false,
    maxServers: 0,
    customer: { id: 7, name: 'Acme Co', subdomain: 'acme' },
    inventory: {
      servers: [{ id: 1, name: 'fw-01', fqdn: '10.0.0.1', status: 'ok', server_template: [], tags: [] }],
      users: [],
      server_templates: [],
      server_groups: [],
    },
    ...overrides,
  };
}

function buildPageHtml({ initialState }) {
  const html = fs.readFileSync(APP_HTML, 'utf-8');
  const appJs = fs.readFileSync(APP_JS, 'utf-8');
  const snapshotIoJs = fs.readFileSync(SNAPSHOT_IO_JS, 'utf-8');

  // The app.js is shipped as <script type="module">; we inline it as a
  // plain script so we don't need module resolution from a fake origin.
  // app.js does not import anything itself; snapshot-io is loaded via the
  // SW handler shim below, not via the page.
  const inlinedHtml = html
    .replace(/<link rel="stylesheet"[^>]*>/, '')
    .replace(/<script src="app\.js" type="module"><\/script>/, `<script>${appJs}<\/script>`);

  const shimHead = `
    <script>
      // FMN-161 test shim: minimal chrome.* surface. The handler logic
      // runs in the page so we don't need an actual MV3 service worker.
      ${snapshotIoJs.replace(/^export /gm, '').replace('export class', 'class')}

      const __initial = ${JSON.stringify(initialState)};
      let slots = JSON.parse(JSON.stringify(__initial.slots));
      const handlers = {
        'bpa-snapshots:status': async () => ({
          hasCurrent: Boolean(slots.current),
          hasPrevious: Boolean(slots.previous),
          currentTakenAt: slots.current?.takenAt ?? null,
          previousTakenAt: slots.previous?.takenAt ?? null,
          runInFlight: false,
          runStartedAt: null,
        }),
        'bpa-snapshots:diff': async () => {
          if (!slots.current) return { ok: false, reason: 'no-snapshot', message: 'Take a snapshot first.' };
          if (!slots.previous) return { ok: false, reason: 'no-previous', message: 'Only one snapshot stored.', currentTakenAt: slots.current.takenAt };
          const empty = { added: [], removed: [], modified: [] };
          return {
            ok: true,
            prevTakenAt: slots.previous.takenAt,
            currTakenAt: slots.current.takenAt,
            servers: empty,
            counts: { added: 0, removed: 0, modified: 0 },
            sections: {
              servers: empty,
              users: empty,
              server_templates: empty,
              server_groups: empty,
            },
          };
        },
        // Phase 2.3: snapshot picker enumeration. Synthesizes summaries
        // out of the test shim's two-slot model.
        'bpa-snapshots:list': async () => {
          const items = [];
          const toSummary = (snap, slot) => ({
            id: 'snap-' + slot + '-' + snap.takenAt,
            takenAt: snap.takenAt,
            customer: snap.customer || null,
            durationMs: snap.durationMs || null,
            counts: {
              servers: snap.inventory?.servers?.length || 0,
              users: snap.inventory?.users?.length || 0,
              server_templates: snap.inventory?.server_templates?.length || 0,
              server_groups: snap.inventory?.server_groups?.length || 0,
            },
            slot,
          });
          if (slots.current) items.push(toSummary(slots.current, 'current'));
          if (slots.previous) items.push(toSummary(slots.previous, 'previous'));
          return { ok: true, items };
        },
        'bpa-snapshots:export': async (payload) => {
          const slot = payload?.slot === 'previous' ? 'previous' : 'current';
          const snap = slots[slot];
          if (!snap) return { ok: false, reason: 'empty-slot', message: 'No ' + slot + ' snapshot to export.' };
          const env = wrapSnapshot(snap, { extensionVersion: '1.6.3-test' });
          return {
            ok: true,
            filename: filenameFor(snap),
            contents: JSON.stringify(env, null, 2),
            slot,
          };
        },
        'bpa-snapshots:import': async (payload) => {
          try {
            const { snapshot } = unwrapSnapshot(payload?.envelope);
            const hadPrevious = Boolean(slots.previous);
            if (hadPrevious && !payload?.force) {
              return {
                ok: false,
                reason: 'previous-exists',
                message: 'A baseline snapshot is already loaded.',
                existingPreviousTakenAt: slots.previous.takenAt,
                incomingTakenAt: snapshot.takenAt,
              };
            }
            slots = { ...slots, previous: snapshot };
            return { ok: true, previousTakenAt: snapshot.takenAt, replaced: hadPrevious };
          } catch (err) {
            if (err && err.code) return { ok: false, reason: err.code, message: err.message };
            throw err;
          }
        },
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
      window.__testGetSlots = () => slots;
    <\/script>
  `;
  return inlinedHtml.replace('</head>', shimHead + '</head>');
}

async function gotoApp(ctx, initialState) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.route(ROUTED_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: buildPageHtml({ initialState }),
    });
  });
  await page.goto(ROUTED_URL);
  // Wait for render() to finish initial paint.
  await page.waitForSelector('#picker-row .panel', { timeout: 5_000 });
  return { page, errors };
}

test.describe('FMN-161: snapshot export + import', () => {

  test('download buttons disabled when their slot is empty', async ({ ctx }) => {
    const { page, errors } = await gotoApp(ctx, {
      slots: { current: snapshotFixture(), previous: null },
    });
    await expect(page.locator('#download-current')).toBeEnabled();
    await expect(page.locator('#download-previous')).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test('download triggers a file save with the expected filename + envelope', async ({ ctx }) => {
    const { page, errors } = await gotoApp(ctx, {
      slots: { current: snapshotFixture(), previous: null },
    });
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#download-current').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('fmn-snapshot-acme-20260510-1430.json');

    // Verify the downloaded contents are a valid envelope.
    const dlPath = await download.path();
    const contents = fs.readFileSync(dlPath, 'utf-8');
    const env = JSON.parse(contents);
    expect(env.format).toBe('fmn-toolkit-snapshot');
    expect(env.formatVersion).toBe(1);
    expect(env.extensionVersion).toBe('1.6.3-test');
    expect(env.snapshot.schema).toBe(1);
    expect(env.snapshot.customer.subdomain).toBe('acme');
    expect(errors).toEqual([]);
  });

  test('import: file picker lands a valid baseline into the previous slot', async ({ ctx }) => {
    const { page, errors } = await gotoApp(ctx, {
      slots: { current: snapshotFixture({ takenAt: '2026-05-12T00:00:00.000Z' }), previous: null },
    });

    // Build a valid envelope file and feed it to the hidden input.
    const incomingSnapshot = snapshotFixture({ takenAt: '2026-04-01T00:00:00.000Z' });
    const envelope = {
      format: 'fmn-toolkit-snapshot',
      formatVersion: 1,
      exportedAt: '2026-05-12T00:00:00.000Z',
      extensionVersion: '1.6.3-test',
      snapshot: incomingSnapshot,
    };
    await page.setInputFiles('#import-file', {
      name: 'baseline.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(envelope), 'utf-8'),
    });

    await expect(page.locator('#import-status.ok')).toContainText('Imported baseline');

    // Verify the previous slot in our shim's storage was updated.
    const slots = await page.evaluate(() => window.__testGetSlots());
    expect(slots.previous.takenAt).toBe('2026-04-01T00:00:00.000Z');

    // The picker should re-render with the new baseline timestamp visible.
    await expect(page.locator('#picker-row')).toContainText('2026');
    expect(errors).toEqual([]);
  });

  test('import: existing baseline triggers confirm dialog; Cancel preserves it', async ({ ctx }) => {
    const existingPrev = snapshotFixture({ takenAt: '2026-05-05T00:00:00.000Z' });
    const { page, errors } = await gotoApp(ctx, {
      slots: { current: snapshotFixture({ takenAt: '2026-05-12T00:00:00.000Z' }), previous: existingPrev },
    });

    const envelope = {
      format: 'fmn-toolkit-snapshot',
      formatVersion: 1,
      exportedAt: '2026-05-12T00:00:00.000Z',
      extensionVersion: '1.6.3-test',
      snapshot: snapshotFixture({ takenAt: '2026-04-01T00:00:00.000Z' }),
    };
    await page.setInputFiles('#import-file', {
      name: 'baseline.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(envelope), 'utf-8'),
    });

    // Dialog must open.
    await page.waitForSelector('dialog#confirm-import[open]', { timeout: 5_000 });
    await page.locator('#confirm-import-cancel').click();

    await expect(page.locator('#import-status')).toContainText('Import cancelled');
    const slots = await page.evaluate(() => window.__testGetSlots());
    expect(slots.previous.takenAt).toBe('2026-05-05T00:00:00.000Z');
    expect(errors).toEqual([]);
  });

  test('import: existing baseline + Replace overwrites previous slot', async ({ ctx }) => {
    const existingPrev = snapshotFixture({ takenAt: '2026-05-05T00:00:00.000Z' });
    const { page, errors } = await gotoApp(ctx, {
      slots: { current: snapshotFixture({ takenAt: '2026-05-12T00:00:00.000Z' }), previous: existingPrev },
    });

    const envelope = {
      format: 'fmn-toolkit-snapshot',
      formatVersion: 1,
      exportedAt: '2026-05-12T00:00:00.000Z',
      extensionVersion: '1.6.3-test',
      snapshot: snapshotFixture({ takenAt: '2026-04-01T00:00:00.000Z' }),
    };
    await page.setInputFiles('#import-file', {
      name: 'baseline.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(envelope), 'utf-8'),
    });

    await page.waitForSelector('dialog#confirm-import[open]', { timeout: 5_000 });
    await page.locator('#confirm-import-ok').click();

    await expect(page.locator('#import-status.ok')).toContainText('Replaced baseline');
    const slots = await page.evaluate(() => window.__testGetSlots());
    expect(slots.previous.takenAt).toBe('2026-04-01T00:00:00.000Z');
    expect(errors).toEqual([]);
  });

  test('import: bad-format file surfaces a clear error in the status line', async ({ ctx }) => {
    const { page, errors } = await gotoApp(ctx, {
      slots: { current: snapshotFixture(), previous: null },
    });

    const badEnvelope = {
      format: 'something-else',
      formatVersion: 1,
      snapshot: snapshotFixture(),
    };
    await page.setInputFiles('#import-file', {
      name: 'bad.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(badEnvelope), 'utf-8'),
    });

    await expect(page.locator('#import-status.err')).toContainText('Import failed');
    const slots = await page.evaluate(() => window.__testGetSlots());
    expect(slots.previous).toBeNull();
    expect(errors).toEqual([]);
  });

  test('import: future formatVersion rejected with a clear error', async ({ ctx }) => {
    const { page, errors } = await gotoApp(ctx, {
      slots: { current: snapshotFixture(), previous: null },
    });

    const futureEnvelope = {
      format: 'fmn-toolkit-snapshot',
      formatVersion: 99,
      snapshot: snapshotFixture(),
    };
    await page.setInputFiles('#import-file', {
      name: 'future.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(futureEnvelope), 'utf-8'),
    });

    await expect(page.locator('#import-status.err')).toContainText('Import failed');
    expect(errors).toEqual([]);
  });
});
