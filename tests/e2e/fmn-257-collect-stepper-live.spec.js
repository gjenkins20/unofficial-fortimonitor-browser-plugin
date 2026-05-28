// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-257 LIVE spec: the Tenant Observations Collect step's PERSISTENT
// phase stepper, exercised against a real authenticated FortiMonitor
// tenant over CDP (no headless harness, no synthetic events). This is the
// live counterpart to fmn-257-collect-stepper.spec.js, which drives the
// component in isolation via window.__stepperHarness.
//
// Fixture mirrors fmn-155-bulk-composer-live.spec.js: connect to the
// pre-provisioned Chromium over CDP, find the extension service worker,
// and skip cleanly when prerequisites (SW present, v2 API key seeded) are
// not met. extensionId is derived from sw.url().
//
// BEHAVIOR MATRIX (FMN-257 reliability hardening). Each case below is its
// own test so a partial failure pinpoints the broken contract:
//
//   (a) up-front render - all of the run's phases render as a persistent
//       stepper, every row pending before anything moves (the full expected
//       sequence is visible immediately, not flashed one label at a time).
//   (b) advance-to-done - a scoped run (Incidents) produces a real
//       pending -> active -> done transition; a done phase shows the
//       persistent checkmark marker and no spinner.
//   (c) abort/error terminal - start a run, fire observations:abort, and
//       assert the stepper reaches a COHERENT TERMINAL state (state-label
//       resolves to Cancelled/Done/Error/Stalled, NO phase is left frozen
//       spinning, done phases precede non-done phases). This is the key
//       reliability case: the old behavior would leave a label spinning
//       forever on a stopped run.
//   (d) scope-differs - the rendered up-front stepper for an Incidents
//       scope (collect, analyze) differs from an Instance-Analysis scope
//       (collect, deep, analyze): derivePhases drops the deep-dive phase
//       when the selected sections don't consume deep-dive data. Asserted
//       by reading the rendered rows for both scopes - no multi-minute
//       crawl needed (snapshot the stepper at run start, then abort).
//
// SKIP conditions (not a failure - prerequisites unmet):
//   - No SW connected / extension build lacks the run-audit handler.
//   - No v2 API key seeded (the run can't start without one).
//   - FortiMonitor session is at a login screen.
//
// Run: npx playwright test --config tests/e2e/playwright.config.js \
//        tests/e2e/fmn-257-collect-stepper-live.spec.js --grep "live -" --reporter=line

import { test as base, expect, chromium } from '@playwright/test';

const FM = 'https://fortimonitor.forticloud.com';
const CDP_PORT = process.env.FMN_CDP_PORT || '9333';
const CDP_URL = `http://localhost:${CDP_PORT}`;

const test = base.extend({
  liveCtx: [async ({}, use) => {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
    } catch (e) {
      throw new Error(
        `Could not connect to Chromium at ${CDP_URL}. ` +
        `A pre-provisioned authenticated Chromium with the extension loaded ` +
        `must be running at that CDP port. Underlying error: ${e.message}`
      );
    }
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('CDP browser has no contexts');

    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);

    // Keep the live FortiMonitor session warm (refresh_live_session memory):
    // if a FM tab exists and is sitting on a login screen, surface that as a
    // skip rather than a confusing failure deep in the run.
    let fmPage = ctx.pages().find((p) => p.url().startsWith(FM));
    let atLogin = false;
    if (fmPage) {
      atLogin = (await fmPage.locator('input[type="password"]').count()) > 0;
    }

    await use({ ctx, sw, browser, fmPage, atLogin });
    await browser.close();
  }, { scope: 'worker' }]
});

// Generous per-test timeout: a real tenant crawl plus the frontend walks
// can run for minutes. We don't wait for full completion, but advancement
// detection needs headroom across the SW's poll cadence + MV3 idleness.
test.setTimeout(240_000);

async function hasRunAuditHandler(sw) {
  if (!sw) return false;
  return await sw.evaluate(() => {
    const keys = globalThis.__fmDebugHandlerKeys || [];
    return keys.includes('observations:run-audit');
  });
}

async function apiKeyConfigured(sw) {
  if (!sw) return false;
  return await sw.evaluate(async () => {
    const d = await chrome.storage.local.get('panopta.apiKey');
    return Boolean(d?.['panopta.apiKey']);
  });
}

function appUrl(extensionId, hash = '/start') {
  return `chrome-extension://${extensionId}/src/ui/tenant-observations/app.html#${hash}`;
}

// Best-effort: abort any in-flight run from a real extension-page context
// (the SW cannot message itself). A prior orphaned run would make
// observations:run-audit throw "already in progress" (single-flight). This
// is read-mostly cleanup; with no active run the abort is a no-op.
async function abortAnyActiveRun(ctx, extensionId) {
  const p = await ctx.newPage();
  try {
    await p.goto(appUrl(extensionId, '/start'), { waitUntil: 'domcontentloaded' });
    await p.evaluate(async () => {
      try { await chrome.runtime.sendMessage({ type: 'observations:abort', payload: {} }); } catch { /* none */ }
    });
  } finally {
    await p.close().catch(() => {});
  }
}

// Read the live stepper structure straight off the page DOM. This is the
// same shape the synthetic harness's snapshotPhases() returns, but read
// directly from the rendered collect.js component (no harness present on a
// real extension page).
async function snapshotStepper(page) {
  return page.evaluate(() => {
    const stepper = document.querySelector('ul.phase-stepper[data-test="phase-stepper"]');
    if (!stepper) return null;
    const rows = Array.from(stepper.querySelectorAll('li.phase-step'));
    return rows.map((li) => {
      const cls = li.className.split(/\s+/);
      const state = ['pending', 'active', 'done', 'error'].find((s) => cls.includes(s)) || 'unknown';
      const marker = li.querySelector('.phase-marker');
      return {
        id: li.getAttribute('data-phase'),
        state,
        marker: (marker?.textContent || '').trim(),
        hasSpinner: Boolean(li.querySelector('.phase-spinner'))
      };
    });
  });
}

// Scope a run to a single analyzer section by plain-clicking its pill, kick
// off the run, and wait for the persistent stepper to render. Returns the
// run page. The pill ids come from section-selection.js (incidents,
// instance-analysis, user-activity, template-recommendations,
// monitoring-policy); plain-click replaces the selection with [that pill].
async function startScopedRun(ctx, extensionId, sectionId) {
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

  await page.goto(appUrl(extensionId, '/start'), { waitUntil: 'domcontentloaded' });

  const runBtn = page.locator('.action-bar .btn.btn-primary');
  await expect(runBtn).toBeVisible({ timeout: 10_000 });
  await expect(runBtn).toHaveText(/Run assessment/i);

  const pill = page.locator(`[data-test="tenant-observations-section-pill-${sectionId}"]`);
  await expect(pill).toBeVisible({ timeout: 5_000 });
  await pill.click();
  await expect(pill).toHaveAttribute('aria-pressed', 'true');

  await runBtn.click();

  // FMN-257's whole point: the persistent stepper renders immediately with
  // the full expected sequence shown up front, not flashed one at a time.
  await page.waitForSelector('ul.phase-stepper[data-test="phase-stepper"]', { timeout: 15_000 });

  return { page, pageErrors };
}

// Cancel the run from its own action bar (best-effort) so we don't leave a
// long crawl churning in the provisioned worker after an assertion passes.
async function cancelRun(page) {
  const cancelBtn = page.locator('.action-bar button').filter({ hasText: /Cancel/i });
  if (await cancelBtn.count() && await cancelBtn.first().isEnabled().catch(() => false)) {
    await cancelBtn.first().click().catch(() => {});
  }
}

test.describe('live - FMN-257 Collect phase stepper', () => {

  // ---------------------------------------------------------------------------
  // (a) UP-FRONT RENDER + (b) ADVANCE-TO-DONE
  // ---------------------------------------------------------------------------
  // One Incidents-scoped run exercises both: it renders the full sequence up
  // front (every row pending), then advances pending -> active -> done. An
  // incidents-only run has just two phases (collect = outage-trending block
  // only, light; analyze), so the crawl finishes in seconds even on a large
  // tenant - well within the window, without the minutes-long ["all"] collect
  // + frontend walks.
  test('live - persistent stepper renders all phases up front, then advances to done (incidents scope)', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;

    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen; cannot run an assessment.');
    test.skip(!(await hasRunAuditHandler(sw)),
      'Provisioned extension build lacks the observations:run-audit handler ' +
      '(does not carry the FMN-257 stepper wiring). Reload the extension and re-run.');
    test.skip(!(await apiKeyConfigured(sw)),
      'No FortiMonitor v2 API key seeded (panopta.apiKey); the assessment cannot start.');

    const extensionId = sw.url().split('/')[2];
    await abortAnyActiveRun(ctx, extensionId);

    const { page, pageErrors } = await startScopedRun(ctx, extensionId, 'incidents');

    // ---- (a) UP-FRONT RENDER -----------------------------------------------
    const initial = await snapshotStepper(page);
    expect(initial, 'a persistent ul.phase-stepper must render').toBeTruthy();
    expect(initial.length, 'the stepper must list more than one phase up front').toBeGreaterThan(1);
    for (const row of initial) {
      expect(row.id, 'each phase row must carry a stable data-phase id').toBeTruthy();
    }
    // The incidents-scope sequence is exactly collect -> analyze (no deep,
    // no frontend phases): derivePhases gates them out.
    expect(initial.map((r) => r.id)).toEqual(['collect', 'analyze']);
    // CRITICAL up-front contract: every row is pending before anything moves.
    // (Snapshotted the instant the stepper appears - the run has been kicked
    // off but the first progress tick / poll hasn't advanced it yet. If the
    // first phase has already gone active by the time we snapshot, that's
    // still a valid persistent stepper, so we assert "no row is done yet"
    // rather than "all pending" to avoid a benign race flake.)
    expect(initial.every((r) => r.state === 'pending' || r.state === 'active'),
      'no phase may be done/errored before the run advances').toBe(true);
    expect(initial.some((r) => r.state === 'done' || r.state === 'error'),
      'nothing may be terminal in the up-front snapshot').toBe(false);

    // ---- (b) ADVANCE TO DONE -----------------------------------------------
    // Success is ANY of: some phase reaches 'done'; or a phase is active while
    // another already finished; or the run reaches a terminal state-label.
    // The OLD flashing-label behavior would never produce a persistent 'done'
    // row, so this distinguishes the new stepper from the regression.
    const advanced = await page.waitForFunction(() => {
      const stepper = document.querySelector('ul.phase-stepper[data-test="phase-stepper"]');
      if (!stepper) return false;
      const rows = Array.from(stepper.querySelectorAll('li.phase-step'));
      const states = rows.map((li) => {
        const cls = li.className.split(/\s+/);
        return ['pending', 'active', 'done', 'error'].find((s) => cls.includes(s)) || 'unknown';
      });
      const anyDone = states.includes('done');
      const anyError = states.includes('error');
      const anyActive = states.includes('active');
      const labelText = (document.querySelector('[data-test="state-label"]')?.textContent || '').trim();
      const terminalLabel = /Done in|Error:|Cancelled|Stalled/i.test(labelText);
      if (anyDone || anyError || terminalLabel) return true;
      if (anyActive && states.filter((s) => s !== 'pending').length > 1) return true;
      return false;
    }, undefined, { timeout: 210_000, polling: 1_000 }).catch(() => null);

    const finalSnap = await snapshotStepper(page);
    const stateLabel = await page.locator('[data-test="state-label"]').textContent().catch(() => '');

    expect(finalSnap, 'the stepper must remain a persistent phase list').toBeTruthy();
    expect(finalSnap.length).toBeGreaterThan(1);

    if (!advanced) {
      throw new Error(
        `FMN-257 stepper did not advance within the timeout and the run did ` +
        `not reach a terminal state. Final phase states: ` +
        `${JSON.stringify(finalSnap)}; state-label: ${JSON.stringify(stateLabel)}. ` +
        `A persistent stepper must transition at least one phase ` +
        `pending -> active -> done (or surface a terminal/error state).`
      );
    }

    const states = finalSnap.map((r) => r.state);
    expect(states.filter((s) => s !== 'pending').length,
      'at least one phase must have left the pending state').toBeGreaterThan(0);

    // A done phase shows the persistent checkmark marker and no spinner; an
    // active phase shows its spinner. These are the structural differences
    // from the old flashing-label behavior.
    const doneRow = finalSnap.find((r) => r.state === 'done');
    if (doneRow) {
      expect(doneRow.marker, 'a done phase must show the checkmark marker').toBe('✓');
      expect(doneRow.hasSpinner, 'a done phase must not show a spinner').toBe(false);
    }
    const activeRow = finalSnap.find((r) => r.state === 'active');
    if (activeRow) {
      expect(activeRow.hasSpinner, 'an active phase must show its spinner').toBe(true);
    }

    expect(pageErrors, `page errors during the live run: ${pageErrors.join(' | ')}`).toEqual([]);

    await cancelRun(page);
    await page.close();
  });

  // ---------------------------------------------------------------------------
  // (c) ABORT / TERMINAL STATE - the key reliability case
  // ---------------------------------------------------------------------------
  // Start a run, fire observations:abort while it is in flight, and assert the
  // stepper reaches a COHERENT TERMINAL state instead of a frozen spinner.
  //
  // The real cancel contract (collect.js + collect-phases.derivePhaseStates):
  //   - state-label resolves to "Cancelled." (or, if the run happened to
  //     finish before the abort landed, "Done in ..." - also a clean
  //     terminal, never a frozen spinner).
  //   - the in-flight phase reverts to pending (work stopped) and its spinner
  //     is gone; earlier phases stay done. So after a terminal state NO phase
  //     row may be left spinning.
  //   - the action button flips to a "Back to start" primary button.
  // We scope to instance-analysis (collect -> deep -> analyze) because the
  // deep-dive phase gives a window to abort mid-flight on a tenant with
  // servers; on a tiny/empty tenant the run may finish first, which we accept
  // as a clean terminal too.
  test('live - aborting a run drives the stepper to a coherent terminal state, no frozen spinner', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;

    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen; cannot run an assessment.');
    test.skip(!(await hasRunAuditHandler(sw)),
      'Provisioned extension build lacks the observations:run-audit handler.');
    test.skip(!(await apiKeyConfigured(sw)),
      'No FortiMonitor v2 API key seeded (panopta.apiKey); the assessment cannot start.');

    const extensionId = sw.url().split('/')[2];
    await abortAnyActiveRun(ctx, extensionId);

    const { page, pageErrors } = await startScopedRun(ctx, extensionId, 'instance-analysis');

    // Up-front sanity: instance-analysis scope renders collect -> deep ->
    // analyze (deep IS present because the section consumes deep-dive data).
    const initial = await snapshotStepper(page);
    expect(initial.map((r) => r.id)).toEqual(['collect', 'deep', 'analyze']);

    // Let the run actually start moving so the abort hits an in-flight phase
    // (rather than racing the very first request). Wait until SOME phase is
    // active OR the run has already reached a terminal label.
    await page.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll('ul.phase-stepper li.phase-step'));
      const states = rows.map((li) => {
        const cls = li.className.split(/\s+/);
        return ['pending', 'active', 'done', 'error'].find((s) => cls.includes(s)) || 'unknown';
      });
      const labelText = (document.querySelector('[data-test="state-label"]')?.textContent || '').trim();
      return states.includes('active') || states.includes('done') ||
        /Done in|Error:|Cancelled|Stalled/i.test(labelText);
    }, undefined, { timeout: 60_000, polling: 500 });

    // Fire the abort straight at the SW from the run page's context.
    await page.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'observations:abort', payload: {} });
    });

    // The page's poll loop sees status:'cancelled' and resolves the stepper.
    // Wait for a COHERENT TERMINAL: the state-label resolves AND no phase is
    // left spinning.
    const terminal = await page.waitForFunction(() => {
      const labelText = (document.querySelector('[data-test="state-label"]')?.textContent || '').trim();
      const resolved = /Cancelled|Done in|Error:|Stalled/i.test(labelText);
      if (!resolved) return false;
      const rows = Array.from(document.querySelectorAll('ul.phase-stepper li.phase-step'));
      const anySpinning = rows.some((li) => li.querySelector('.phase-spinner'));
      return !anySpinning;  // terminal AND nothing frozen spinning
    }, undefined, { timeout: 60_000, polling: 500 }).catch(() => null);

    const finalSnap = await snapshotStepper(page);
    const stateLabel = (await page.locator('[data-test="state-label"]').textContent().catch(() => '')) || '';

    if (!terminal) {
      throw new Error(
        `Aborted run did not reach a coherent terminal state. ` +
        `state-label: ${JSON.stringify(stateLabel)}; phases: ${JSON.stringify(finalSnap)}. ` +
        `After an abort the stepper must resolve (Cancelled/Done/Error/Stalled) ` +
        `and leave NO phase spinning.`
      );
    }

    // Assert the specific terminal contract.
    expect(finalSnap, 'the stepper must remain a persistent phase list after abort').toBeTruthy();
    // The reliability invariant: NO phase row is frozen spinning.
    expect(finalSnap.some((r) => r.hasSpinner),
      'no phase may be left spinning after a terminal state').toBe(false);
    // No active phase remains - the run has stopped.
    expect(finalSnap.some((r) => r.state === 'active'),
      'no phase may remain active after a terminal state').toBe(false);
    // The state-label reflects a terminal outcome.
    expect(stateLabel).toMatch(/Cancelled|Done in|Error:|Stalled/i);

    // Structural coherence: the stepper never reorders. Every 'done' phase
    // must precede every 'pending' phase (a cancel reverts only the in-flight
    // phase to pending; earlier phases stay done - it never jumps backwards
    // past a completed phase).
    const idxFirstPending = finalSnap.findIndex((r) => r.state === 'pending');
    const idxLastDone = finalSnap.map((r) => r.state).lastIndexOf('done');
    if (idxFirstPending !== -1 && idxLastDone !== -1) {
      expect(idxLastDone, 'a done phase must not appear after a pending phase').toBeLessThan(idxFirstPending);
    }

    // The action button flips to "Back to start" once the run is terminal.
    const backBtn = page.locator('.action-bar button').filter({ hasText: /Back to start/i });
    expect(await backBtn.count(), 'a terminal run must offer "Back to start"').toBeGreaterThan(0);

    expect(pageErrors, `page errors during the abort run: ${pageErrors.join(' | ')}`).toEqual([]);

    await page.close();
  });

  // ---------------------------------------------------------------------------
  // (d) SCOPE-DIFFERS - derivePhases drops deep-dive when the scope doesn't
  //     consume it. Read the rendered up-front stepper rows for two scopes and
  //     assert the deep-dive phase appears only for instance-analysis.
  // ---------------------------------------------------------------------------
  // Fast: snapshot each scope's stepper the instant it renders (before any
  // crawl progress), then abort. No multi-minute wait.
  test('live - the rendered phase set differs by scope (deep-dive only when the scope needs it)', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;

    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen; cannot run an assessment.');
    test.skip(!(await hasRunAuditHandler(sw)),
      'Provisioned extension build lacks the observations:run-audit handler.');
    test.skip(!(await apiKeyConfigured(sw)),
      'No FortiMonitor v2 API key seeded (panopta.apiKey); the assessment cannot start.');

    const extensionId = sw.url().split('/')[2];

    // Scope 1: incidents -> collect, analyze (no deep).
    await abortAnyActiveRun(ctx, extensionId);
    const incidents = await startScopedRun(ctx, extensionId, 'incidents');
    const incidentsRows = await snapshotStepper(incidents.page);
    const incidentsIds = incidentsRows.map((r) => r.id);
    // Stop this run before starting the next (single-flight guard) and let the
    // SW settle so the next run-audit isn't rejected as already-in-progress.
    await incidents.page.evaluate(async () => {
      try { await chrome.runtime.sendMessage({ type: 'observations:abort', payload: {} }); } catch { /* none */ }
    });
    await incidents.page.close();
    await abortAnyActiveRun(ctx, extensionId);

    // Scope 2: instance-analysis -> collect, deep, analyze (deep present).
    const instances = await startScopedRun(ctx, extensionId, 'instance-analysis');
    const instancesRows = await snapshotStepper(instances.page);
    const instancesIds = instancesRows.map((r) => r.id);
    await instances.page.evaluate(async () => {
      try { await chrome.runtime.sendMessage({ type: 'observations:abort', payload: {} }); } catch { /* none */ }
    });
    await instances.page.close();
    await abortAnyActiveRun(ctx, extensionId);

    // The two phase sequences must differ, and SPECIFICALLY: the deep-dive
    // phase is present for instance-analysis (which consumes deep-dive data)
    // and absent for incidents (which does not). This is derivePhases gating
    // the deep phase by needsDeepDive(sections), verified end-to-end.
    expect(incidentsIds, 'incidents scope is collect -> analyze').toEqual(['collect', 'analyze']);
    expect(instancesIds, 'instance-analysis scope is collect -> deep -> analyze')
      .toEqual(['collect', 'deep', 'analyze']);
    expect(incidentsIds).not.toEqual(instancesIds);
    expect(incidentsIds, 'incidents scope must not render the deep-dive phase').not.toContain('deep');
    expect(instancesIds, 'instance-analysis scope must render the deep-dive phase').toContain('deep');
  });
});
