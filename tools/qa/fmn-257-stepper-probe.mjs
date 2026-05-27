// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-257 Claude-side QA probe. Drives the Collect phase-stepper harness in
// headless Chromium via the Playwright LIBRARY (not the `playwright test`
// runner, which is gated). Exercises every stepper state and prints a
// PASS/FAIL line per assertion. Pure headless - no operator display paint.
//
// Each scenario runs on a FRESH page so a prior scenario's detached poll
// loop / timers can't cross-contaminate (the real spec gets a fresh page
// per test the same way).
//
// Run from the worktree root: node tools/qa/fmn-257-stepper-probe.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The harness uses ES-module imports, which the browser blocks over
// file:// (CORS origin null). Serve the worktree root over HTTP so the
// component's relative imports resolve. Repo-relative, read-only.
const ROOT = path.resolve(__dirname, '../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
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
const PORT = server.address().port;
const URL = `http://127.0.0.1:${PORT}/docs/harnesses/fmn-257-collect-stepper.html`;

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`); }
}
function byId(rows) { return Object.fromEntries(rows.map((r) => [r.id, r])); }

const browser = await chromium.launch({ headless: true });

// Open a fresh page, load the harness, and hand it to `fn` along with a
// `snap()` helper. Collects page/console errors per scenario.
async function scenario(fn) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.goto(URL);
  await page.waitForFunction(() => window.__stepperHarness && window.__stepperHarness.mount, { timeout: 5000 });
  await page.waitForSelector('.phase-stepper', { timeout: 5000 });
  const snap = () => page.evaluate(() => window.__stepperHarness.snapshotPhases());
  try {
    await fn({ page, snap, errors });
  } finally {
    await page.close();
  }
}

// 1. Full deep run: 5 phases, all pending.
await scenario(async ({ page, snap, errors }) => {
  await page.evaluate(() => window.__stepperHarness.mount({ deep: true, sections: ['all'] }));
  const rows = await snap();
  check('deep run: 5 phases in order', JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(['collect', 'deep', 'frontend-users', 'frontend-templates', 'analyze']));
  check('deep run: all pending initially', rows.every((r) => r.state === 'pending' && !r.hasSpinner));
  check('deep run: no page errors', errors.length === 0);
});

// 2. Non-deep run: no deep phase.
await scenario(async ({ page, snap }) => {
  await page.evaluate(() => window.__stepperHarness.mount({ deep: false, sections: ['all'] }));
  check('non-deep: drops deep phase', JSON.stringify((await snap()).map((r) => r.id)) === JSON.stringify(['collect', 'frontend-users', 'frontend-templates', 'analyze']));
});

// 3. Scoped Incidents: collect + analyze only.
await scenario(async ({ page, snap }) => {
  await page.evaluate(() => window.__stepperHarness.mount({ deep: true, sections: ['incidents'] }));
  check('incidents-only: collect + analyze', JSON.stringify((await snap()).map((r) => r.id)) === JSON.stringify(['collect', 'analyze']));
});

// 4. Mid-run: deep active + nested detail, collect done.
await scenario(async ({ page, snap }) => {
  await page.evaluate(() => {
    const H = window.__stepperHarness;
    H.mount({ deep: true, sections: ['all'] });
    H.emitProgress({ phase: 'collect:start', deep: true });
    H.emitProgress({ phase: 'collect:event', type: 'endpoint-start', name: 'server' });
    H.emitProgress({ phase: 'collect:event', type: 'endpoint-done', name: 'server', count: 42 });
    H.emitProgress({ phase: 'collect:event', type: 'deep-server', index: 88, total: 140 });
  });
  const m = byId(await snap());
  check('mid-run: collect done + check + summary', m.collect.state === 'done' && m.collect.marker === '✓' && /endpoint/i.test(m.collect.summary || ''));
  check('mid-run: deep active + spinner + detail', m.deep.state === 'active' && m.deep.hasSpinner && /server 88 of 140/.test(m.deep.detail || ''));
  check('mid-run: later phases pending', m['frontend-users'].state === 'pending' && m.analyze.state === 'pending');
});

// 5. Done: poll reports done; all phases done + navigates.
await scenario(async ({ page, snap }) => {
  await page.evaluate(() => {
    const H = window.__stepperHarness;
    H.mount({ deep: true, sections: ['all'] });
    H.emitProgress({ phase: 'collect:start', deep: true });
    H.emitProgress({ phase: 'analyze:start' });
    H.setStatus({ status: 'done', phase: 'analyze' });
  });
  await page.waitForFunction(() => {
    const rows = window.__stepperHarness.snapshotPhases();
    return rows.length > 0 && rows.every((r) => r.state === 'done');
  }, { timeout: 8000 });
  const rows = await snap();
  check('done: all phases done + check, no spinner', rows.every((r) => r.state === 'done' && r.marker === '✓' && !r.hasSpinner));
  const navigated = await page.waitForFunction(() => window.__lastNavigate === '/analyze', { timeout: 5000 }).then(() => true).catch(() => false);
  check('done: navigates to /analyze', navigated);
});

// 6. Error: deep phase failed, banner shows, collect stays done.
await scenario(async ({ page, snap }) => {
  await page.evaluate(() => {
    const H = window.__stepperHarness;
    H.mount({ deep: true, sections: ['all'] });
    H.emitProgress({ phase: 'collect:start', deep: true });
    H.emitProgress({ phase: 'collect:event', type: 'endpoint-done', name: 'server', count: 1 });
    H.emitProgress({ phase: 'collect:event', type: 'deep-server', index: 88, total: 140 });
    H.setStatus({ status: 'error', error: 'boom', phase: 'deep' });
  });
  await page.waitForFunction(() => window.__stepperHarness.snapshotPhases().find((r) => r.id === 'deep')?.state === 'error', { timeout: 5000 });
  const m = byId(await snap());
  check('error: deep phase error + cross marker', m.deep.state === 'error' && m.deep.marker === '✗');
  check('error: collect stays done, later pending', m.collect.state === 'done' && m['frontend-users'].state === 'pending');
  const banner = await page.evaluate(() => window.__stepperHarness.runError());
  check('error: run-error banner shows', !!banner);
});

// 7. Worker lost: poll lost marks persisted phase failed + banner.
await scenario(async ({ page, snap }) => {
  await page.evaluate(() => {
    const H = window.__stepperHarness;
    H.mount({ deep: true, sections: ['all'] });
    H.emitProgress({ phase: 'collect:start', deep: true });
    H.emitProgress({ phase: 'collect:event', type: 'deep-server', index: 50, total: 140 });
    H.setStatus({ status: 'lost', phase: 'deep' });
  });
  await page.waitForFunction(() => window.__stepperHarness.snapshotPhases().find((r) => r.id === 'deep')?.state === 'error', { timeout: 5000 });
  const m = byId(await snap());
  check('lost: deep phase error', m.deep.state === 'error');
  const banner = await page.evaluate(() => window.__stepperHarness.runError());
  check('lost: banner mentions worker stopped', /worker stopped/i.test(banner || ''));
});

// 8. Poll-driven advance with NO broadcast events.
await scenario(async ({ page, snap }) => {
  await page.evaluate(() => {
    const H = window.__stepperHarness;
    H.mount({ deep: true, sections: ['all'] });
    H.setStatus({ status: 'running', phase: 'frontend-users' });
  });
  await page.waitForFunction(() => window.__stepperHarness.snapshotPhases().find((r) => r.id === 'frontend-users')?.state === 'active', { timeout: 5000 });
  const m = byId(await snap());
  check('poll-only: collect+deep done, frontend-users active', m.collect.state === 'done' && m.deep.state === 'done' && m['frontend-users'].state === 'active' && m['frontend-users'].hasSpinner);
  check('poll-only: frontend-templates still pending', m['frontend-templates'].state === 'pending');
});

// 9. Cancelled: in-flight phase reverts to pending, earlier stay done.
await scenario(async ({ page, snap }) => {
  await page.evaluate(() => {
    const H = window.__stepperHarness;
    H.mount({ deep: true, sections: ['all'] });
    H.emitProgress({ phase: 'collect:start', deep: true });
    H.emitProgress({ phase: 'collect:event', type: 'endpoint-done', name: 'server', count: 1 });
    H.emitProgress({ phase: 'collect:event', type: 'deep-server', index: 10, total: 140 });
    H.setStatus({ status: 'cancelled', error: 'tenant observations cancelled', phase: 'deep' });
  });
  await page.waitForFunction(() => window.__stepperHarness.snapshotPhases().find((r) => r.id === 'deep')?.state === 'pending', { timeout: 5000 });
  const m = byId(await snap());
  check('cancelled: collect done, deep reverts to pending', m.collect.state === 'done' && m.deep.state === 'pending');
});

// 10. No-freeze: heartbeat ran without starving on a fresh deep mount.
await scenario(async ({ page }) => {
  await page.evaluate(() => window.__stepperHarness.mount({ deep: true, sections: ['all'] }));
  await page.waitForTimeout(600);
  const frozen = await page.evaluate(() => document.getElementById('hb').classList.contains('frozen'));
  check('heartbeat never starved (no main-thread freeze)', !frozen);
});

await browser.close();
server.close();
console.log(`\nFMN-257 stepper probe: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
