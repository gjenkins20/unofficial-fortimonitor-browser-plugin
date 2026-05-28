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
// What this asserts (vs the OLD flashing-label behavior FMN-257 replaced):
//   - The run's phases render UP FRONT as a persistent stepper
//     (ul.phase-stepper with li.phase-step rows), every row pending before
//     anything moves - the full expected sequence is visible immediately.
//   - At least one phase transitions pending -> active -> done as the run
//     advances (driven by broadcast progress events AND/OR the poll
//     record's `phase` field). We assert MEANINGFUL ADVANCEMENT within a
//     generous timeout rather than waiting for the whole tenant crawl to
//     finish, because a deep run on a large tenant can take minutes.
//   - A terminal/error/lost state also counts as a valid stepper outcome
//     (the stepper is still structurally correct; the run just ended).
//
// FAIL conditions (the stepper is structurally wrong):
//   - No persistent ul.phase-stepper / li.phase-step rows render.
//   - The stepper never advances at all within the generous timeout AND
//     the run never reaches a terminal state.
//
// SKIP conditions (not a failure - prerequisites unmet):
//   - No SW connected / extension build lacks the run-audit handler.
//   - No v2 API key seeded (the run can't start without one).
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

test.describe('live - FMN-257 Collect phase stepper', () => {

  test('live - the persistent phase stepper renders up front and advances on a real run', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;

    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen; cannot run an assessment.');

    const hasHandler = await hasRunAuditHandler(sw);
    test.skip(!hasHandler,
      'Provisioned extension build lacks the observations:run-audit handler ' +
      '(does not carry the FMN-257 stepper wiring). Reload the extension and re-run.');

    const hasKey = await apiKeyConfigured(sw);
    test.skip(!hasKey,
      'No FortiMonitor v2 API key seeded (panopta.apiKey); the assessment cannot start.');

    const extensionId = sw.url().split('/')[2];

    // A prior orphaned run would make observations:run-audit throw
    // "already in progress" (single-flight). Best-effort abort any active
    // run before we start ours, from a real extension-page context (the SW
    // cannot message itself). This is read-mostly cleanup, not a state
    // mutation the test depends on - if there is no active run the abort is
    // a no-op.
    {
      const cleanupPage = await ctx.newPage();
      await cleanupPage.goto(appUrl(extensionId, '/start'), { waitUntil: 'domcontentloaded' });
      await cleanupPage.evaluate(async () => {
        try { await chrome.runtime.sendMessage({ type: 'observations:abort', payload: {} }); } catch { /* no active run */ }
      });
      await cleanupPage.close();
    }

    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

    // ---- Configure step: scope the run so a phase finishes fast ------------
    // Scope to the Incidents section (plain-click the pill). Per
    // collect-phases.derivePhases, an incidents-only run has just two
    // phases: collect (outage-trending block only - light) and analyze.
    // The collect crawl finishes in seconds even on a large tenant, so we
    // observe a real pending -> active -> done transition well within the
    // window, without the minutes-long ["all"] collect + frontend-users
    // walk (confirmed slow on this tenant during FMN-257 live QA). Deep is
    // off by default and irrelevant to the incidents scope.
    await page.goto(appUrl(extensionId, '/start'), { waitUntil: 'domcontentloaded' });

    const runBtn = page.locator('.action-bar .btn.btn-primary');
    await expect(runBtn).toBeVisible({ timeout: 10_000 });
    await expect(runBtn).toHaveText(/Run assessment/i);

    const incidentsPill = page.locator('[data-test="tenant-observations-section-pill-incidents"]');
    await expect(incidentsPill).toBeVisible({ timeout: 5_000 });
    await incidentsPill.click();
    await expect(incidentsPill).toHaveAttribute('aria-pressed', 'true');

    // ---- Kick off the run; land on the Collect step ------------------------
    await runBtn.click();

    // The Collect step's title bar reads "Assessing…"; the persistent
    // stepper must render immediately (FMN-257's whole point - phases shown
    // up front, not flashed one at a time).
    await page.waitForSelector('ul.phase-stepper[data-test="phase-stepper"]', { timeout: 15_000 });

    const initial = await snapshotStepper(page);
    expect(initial, 'a persistent ul.phase-stepper must render').toBeTruthy();
    expect(initial.length, 'the stepper must list more than one phase up front').toBeGreaterThan(1);
    // Every phase row carries a stable phase id (persistent structure, not
    // an ephemeral now-fetching label).
    for (const row of initial) {
      expect(row.id, 'each phase row must carry a data-phase id').toBeTruthy();
    }
    // The sequence must match the incidents-scope derivation: collect
    // (outage trending) then analyze. No deep / frontend phases for this
    // scope (collect-phases.derivePhases gates them out).
    expect(initial.map((r) => r.id)).toEqual(['collect', 'analyze']);

    // ---- Assert MEANINGFUL ADVANCEMENT -------------------------------------
    // We do NOT require the entire crawl to finish. Success is ANY of:
    //   (a) some phase reaches 'done', OR
    //   (b) some phase becomes 'active' AND a later/earlier phase is 'done'
    //       (i.e. the stepper has genuinely progressed past the first row),
    //       OR
    //   (c) the run reaches a terminal state (state-label reflects Done /
    //       Error / Cancelled / Stalled, or a phase shows 'error').
    // The OLD flashing-label behavior would never produce a persistent
    // 'done' row, so this assertion specifically distinguishes the new
    // stepper from the regression.
    const advanced = await page.waitForFunction(() => {
      const stepper = document.querySelector('ul.phase-stepper[data-test="phase-stepper"]');
      if (!stepper) return false;
      const rows = Array.from(stepper.querySelectorAll('li.phase-step'));
      const states = rows.map((li) => {
        const cls = li.className.split(/\s+/);
        return ['pending', 'active', 'done', 'error'].find((s) => cls.includes(s)) || 'unknown';
      });
      const anyDone = states.includes('done');
      const anyActive = states.includes('active');
      const anyError = states.includes('error');

      // Terminal state-label resolution (Done / Error / Cancelled / Stalled).
      const stateLabel = document.querySelector('[data-test="state-label"]');
      const labelText = (stateLabel?.textContent || '').trim();
      const terminalLabel = /Done in|Error:|Cancelled|Stalled/i.test(labelText);

      // Meaningful advancement: a phase finished, OR a phase is active while
      // another already finished (progressed past row 1), OR an error/done
      // terminal occurred.
      if (anyDone) return true;
      if (anyError) return true;
      if (terminalLabel) return true;
      if (anyActive && states.filter((s) => s !== 'pending').length > 1) return true;
      return false;
    }, undefined, { timeout: 210_000, polling: 1_000 }).catch(() => null);

    const finalSnap = await snapshotStepper(page);
    const stateLabel = await page.locator('[data-test="state-label"]').textContent().catch(() => '');

    // Structural sanity: the stepper is still a persistent list of phases
    // (it never collapsed into a single flashing label).
    expect(finalSnap, 'the stepper must remain a persistent phase list').toBeTruthy();
    expect(finalSnap.length).toBeGreaterThan(1);

    if (!advanced) {
      // No advancement AND no terminal state within the generous window.
      // If the run cleanly reached a terminal state the waitForFunction
      // would have resolved, so this branch means the stepper genuinely
      // failed to progress - that is the FMN-257 regression we guard
      // against, so FAIL with diagnostics.
      throw new Error(
        `FMN-257 stepper did not advance within the timeout and the run did ` +
        `not reach a terminal state. Final phase states: ` +
        `${JSON.stringify(finalSnap)}; state-label: ${JSON.stringify(stateLabel)}. ` +
        `A persistent stepper must transition at least one phase ` +
        `pending -> active -> done (or surface a terminal/error state).`
      );
    }

    // Advancement confirmed. Assert the SPECIFIC stepper contract:
    // at least one phase is in a non-pending state, and the progression is
    // coherent (a 'done' phase implies the stepper advanced persistently;
    // 'active' alongside a 'done'/'error' confirms it moved past row 1).
    const states = finalSnap.map((r) => r.state);
    const nonPending = states.filter((s) => s !== 'pending').length;
    expect(nonPending,
      'at least one phase must have left the pending state').toBeGreaterThan(0);

    // If a phase reached done, its marker must be the checkmark (persistent
    // done indicator), not a flashing label - this is the structural
    // difference from the old behavior.
    const doneRow = finalSnap.find((r) => r.state === 'done');
    if (doneRow) {
      expect(doneRow.marker, 'a done phase must show the checkmark marker').toBe('✓');
      expect(doneRow.hasSpinner, 'a done phase must not show a spinner').toBe(false);
    }
    const activeRow = finalSnap.find((r) => r.state === 'active');
    if (activeRow) {
      expect(activeRow.hasSpinner, 'an active phase must show its spinner').toBe(true);
    }

    // The collect.js page must not have thrown while wiring the stepper.
    expect(pageErrors, `page errors during the live run: ${pageErrors.join(' | ')}`).toEqual([]);

    // Best-effort: cancel the run so we don't leave a long crawl churning
    // in the provisioned worker after the assertion passed.
    const cancelBtn = page.locator('.action-bar button').filter({ hasText: /Cancel/i });
    if (await cancelBtn.count() && await cancelBtn.first().isEnabled().catch(() => false)) {
      await cancelBtn.first().click().catch(() => {});
    }

    await page.close();
  });
});
