// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-257: stubbed Playwright spec for the Tenant Observations Collect
// step's persistent phase stepper. Pure headless Chromium, no live FM, no
// extension fixture. The harness uses ES-module imports (it loads the REAL
// component), which the browser blocks over file:// (CORS origin null), so
// a tiny static HTTP server fronts the worktree root and the harness loads
// over http://127.0.0.1. The spec then drives it through every stepper
// state via window.__stepperHarness.
//
// Run: npx playwright test tests/e2e/fmn-257-collect-stepper.spec.js

import { test as base, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const test = base.extend({
  server: [async ({}, use) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const filePath = path.join(ROOT, urlPath);
      if (!filePath.startsWith(ROOT)) { res.statusCode = 403; return res.end('forbidden'); }
      fs.readFile(filePath, (err, buf) => {
        if (err) { res.statusCode = 404; return res.end('not found'); }
        res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
        res.end(buf);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    await use(`http://127.0.0.1:${port}`);
    server.close();
  }, { scope: 'worker' }],
  ctx: [async ({}, use) => {
    // Pure headless per playwright_offscreen_window.md - this harness does
    // NOT need the MV3 extension loaded, so no offscreen-window dance.
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await use(context);
    await context.close();
    await browser.close();
  }, { scope: 'worker' }],
});

async function gotoHarness(ctx, server) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.goto(`${server}/docs/harnesses/fmn-257-collect-stepper.html`);
  // Wait for the module to load and auto-mount the default scenario.
  await page.waitForFunction(() => window.__stepperHarness && typeof window.__stepperHarness.mount === 'function', { timeout: 5_000 });
  await page.waitForSelector('.phase-stepper', { timeout: 5_000 });
  return { page, errors };
}

function snapshot(page) {
  return page.evaluate(() => window.__stepperHarness.snapshotPhases());
}

test.describe('FMN-257: Collect phase stepper', () => {

  test('full deep run renders all five phases, initially pending', async ({ ctx, server }) => {
    const { page, errors } = await gotoHarness(ctx, server);
    await page.evaluate(() => window.__stepperHarness.mount({ deep: true, sections: ['all'] }));
    const phases = await snapshot(page);
    expect(phases.map((p) => p.id)).toEqual([
      'collect', 'deep', 'frontend-users', 'frontend-templates', 'analyze'
    ]);
    // Nothing entered yet: every phase pending, numbered markers, no spinner.
    for (const p of phases) {
      expect(p.state).toBe('pending');
      expect(p.hasSpinner).toBe(false);
    }
    expect(errors).toEqual([]);
  });

  test('non-deep run drops the deep-dive phase', async ({ ctx, server }) => {
    const { page } = await gotoHarness(ctx, server);
    await page.evaluate(() => window.__stepperHarness.mount({ deep: false, sections: ['all'] }));
    const ids = (await snapshot(page)).map((p) => p.id);
    expect(ids).toEqual(['collect', 'frontend-users', 'frontend-templates', 'analyze']);
  });

  test('scoped Incidents selection shows only collect + analyze', async ({ ctx, server }) => {
    const { page } = await gotoHarness(ctx, server);
    await page.evaluate(() => window.__stepperHarness.mount({ deep: true, sections: ['incidents'] }));
    const ids = (await snapshot(page)).map((p) => p.id);
    expect(ids).toEqual(['collect', 'analyze']);
  });

  test('mid-run: active phase shows spinner + nested detail, earlier phases done', async ({ ctx, server }) => {
    const { page, errors } = await gotoHarness(ctx, server);
    await page.evaluate(() => {
      const H = window.__stepperHarness;
      H.mount({ deep: true, sections: ['all'] });
      H.emitProgress({ phase: 'collect:start', deep: true });
      H.emitProgress({ phase: 'collect:event', type: 'endpoint-start', name: 'server' });
      H.emitProgress({ phase: 'collect:event', type: 'endpoint-done', name: 'server', count: 42 });
      // Move into the deep phase.
      H.emitProgress({ phase: 'collect:event', type: 'deep-server', index: 88, total: 140 });
    });
    const phases = await snapshot(page);
    const byId = Object.fromEntries(phases.map((p) => [p.id, p]));
    // collect is done (earlier than active), with a summary count.
    expect(byId.collect.state).toBe('done');
    expect(byId.collect.marker).toBe('✓');
    expect(byId.collect.summary).toMatch(/endpoint/i);
    // deep is active, spinner showing, nested detail names the server.
    expect(byId.deep.state).toBe('active');
    expect(byId.deep.hasSpinner).toBe(true);
    expect(byId.deep.detail).toMatch(/server 88 of 140/);
    // later phases still pending.
    expect(byId['frontend-users'].state).toBe('pending');
    expect(byId.analyze.state).toBe('pending');
    expect(errors).toEqual([]);
  });

  test('all done: every phase checked, navigates onward', async ({ ctx, server }) => {
    const { page, errors } = await gotoHarness(ctx, server);
    await page.evaluate(() => {
      const H = window.__stepperHarness;
      H.mount({ deep: true, sections: ['all'] });
      H.emitProgress({ phase: 'collect:start', deep: true });
      H.emitProgress({ phase: 'analyze:start' });
      // Terminal: the poll now reports done.
      H.setStatus({ status: 'done', phase: 'analyze' });
    });
    // Wait for the poll loop to observe 'done' and mark everything done.
    await page.waitForFunction(() => {
      const rows = window.__stepperHarness.snapshotPhases();
      return rows.length > 0 && rows.every((r) => r.state === 'done');
    }, { timeout: 5_000 });
    const phases = await snapshot(page);
    for (const p of phases) {
      expect(p.state).toBe('done');
      expect(p.marker).toBe('✓');
      expect(p.hasSpinner).toBe(false);
    }
    // navigate('/analyze') was invoked.
    await page.waitForFunction(() => window.__lastNavigate === '/analyze', { timeout: 5_000 });
    expect(errors).toEqual([]);
  });

  test('error: the in-flight phase is marked failed, earlier stay done, run-error banner shows', async ({ ctx, server }) => {
    const { page } = await gotoHarness(ctx, server);
    await page.evaluate(() => {
      const H = window.__stepperHarness;
      H.mount({ deep: true, sections: ['all'] });
      H.emitProgress({ phase: 'collect:start', deep: true });
      H.emitProgress({ phase: 'collect:event', type: 'endpoint-done', name: 'server', count: 1 });
      H.emitProgress({ phase: 'collect:event', type: 'deep-server', index: 88, total: 140 });
      // Poll reports a hard error in the deep phase.
      H.setStatus({ status: 'error', error: 'boom', phase: 'deep' });
    });
    await page.waitForFunction(() => {
      const rows = window.__stepperHarness.snapshotPhases();
      const deep = rows.find((r) => r.id === 'deep');
      return deep && deep.state === 'error';
    }, { timeout: 5_000 });
    const phases = await snapshot(page);
    const byId = Object.fromEntries(phases.map((p) => [p.id, p]));
    expect(byId.collect.state).toBe('done');
    expect(byId.deep.state).toBe('error');
    expect(byId.deep.marker).toBe('✗');
    expect(byId['frontend-users'].state).toBe('pending');
    const banner = await page.evaluate(() => window.__stepperHarness.runError());
    expect(banner).toBeTruthy();
  });

  test('worker lost (SW-idle eviction): poll lost marks the persisted phase failed', async ({ ctx, server }) => {
    const { page } = await gotoHarness(ctx, server);
    await page.evaluate(() => {
      const H = window.__stepperHarness;
      H.mount({ deep: true, sections: ['all'] });
      H.emitProgress({ phase: 'collect:start', deep: true });
      H.emitProgress({ phase: 'collect:event', type: 'deep-server', index: 50, total: 140 });
      // Worker died: the orphan-detection path returns 'lost' with the last
      // persisted phase. The page never received the deep event via
      // broadcast in the real eviction case, so we also exercise the
      // poll-driven advance by mounting fresh and only feeding the poll.
      H.setStatus({ status: 'lost', phase: 'deep' });
    });
    await page.waitForFunction(() => {
      const rows = window.__stepperHarness.snapshotPhases();
      const deep = rows.find((r) => r.id === 'deep');
      return deep && deep.state === 'error';
    }, { timeout: 5_000 });
    const byId = Object.fromEntries((await snapshot(page)).map((p) => [p.id, p]));
    expect(byId.deep.state).toBe('error');
    const banner = await page.evaluate(() => window.__stepperHarness.runError());
    expect(banner).toMatch(/worker stopped/i);
  });

  test('poll-driven advance: stepper moves even with NO broadcast progress events', async ({ ctx, server }) => {
    // The fragile-broadcast recovery path: the page gets nothing over the
    // event bus and learns the phase only from the poll record's `phase`.
    const { page } = await gotoHarness(ctx, server);
    await page.evaluate(() => {
      const H = window.__stepperHarness;
      H.mount({ deep: true, sections: ['all'] });
      // No emitProgress at all - only the poll knows the phase.
      H.setStatus({ status: 'running', phase: 'frontend-users' });
    });
    await page.waitForFunction(() => {
      const rows = window.__stepperHarness.snapshotPhases();
      const fu = rows.find((r) => r.id === 'frontend-users');
      return fu && fu.state === 'active';
    }, { timeout: 5_000 });
    const byId = Object.fromEntries((await snapshot(page)).map((p) => [p.id, p]));
    expect(byId.collect.state).toBe('done');
    expect(byId.deep.state).toBe('done');
    expect(byId['frontend-users'].state).toBe('active');
    expect(byId['frontend-users'].hasSpinner).toBe(true);
    expect(byId['frontend-templates'].state).toBe('pending');
  });

  test('cancelled: the in-flight phase reverts to pending, earlier stay done', async ({ ctx, server }) => {
    const { page } = await gotoHarness(ctx, server);
    await page.evaluate(() => {
      const H = window.__stepperHarness;
      H.mount({ deep: true, sections: ['all'] });
      H.emitProgress({ phase: 'collect:start', deep: true });
      H.emitProgress({ phase: 'collect:event', type: 'endpoint-done', name: 'server', count: 1 });
      H.emitProgress({ phase: 'collect:event', type: 'deep-server', index: 10, total: 140 });
      H.setStatus({ status: 'cancelled', error: 'tenant observations cancelled', phase: 'deep' });
    });
    await page.waitForFunction(() => {
      const rows = window.__stepperHarness.snapshotPhases();
      const deep = rows.find((r) => r.id === 'deep');
      return deep && deep.state === 'pending';
    }, { timeout: 5_000 });
    const byId = Object.fromEntries((await snapshot(page)).map((p) => [p.id, p]));
    expect(byId.collect.state).toBe('done');
    expect(byId.deep.state).toBe('pending');
  });

});
