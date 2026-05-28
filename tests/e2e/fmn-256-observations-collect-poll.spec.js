// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-256: Tenant Observations Collect step polls a DETACHED run.
//
// The fix moved the crawl off the single sendMessage round-trip (which MV3
// killed the worker under on large tenants, surfacing "the message channel
// closed before a response was received"). run-audit now returns
// immediately; the Collect step polls observations:get-run-status until a
// terminal state, then pulls the full payload via get-run-result.
//
// These specs drive the REAL Collect step in the extension page, with the
// service worker stubbed at chrome.runtime.sendMessage so we can script the
// status sequence (running -> done), and the error / lost terminal states,
// without a live tenant. The Collect step page only uses
// chrome.runtime.sendMessage + onMessage, so a minimal window.chrome stub
// is safe here (no real chrome.tabs/storage is exercised on this page).

import { test, expect } from './fixtures.js';

// Built as a string so page.addInitScript can run it before the app's
// modules evaluate. `scenario` controls the terminal state get-run-status
// eventually reports.
function makeStubScript(scenario) {
  return `(() => {
    const SCENARIO = ${JSON.stringify(scenario)};
    const RUNNING_POLLS = 1; // one 'running' poll, then the terminal state
    const RESULT_KEY = 'observations.lastResult';
    const RUN_KEY = 'observations.lastRun';
    window.__obsStub = { runAudit: 0, status: 0, getResult: 0, abort: 0, storageGet: 0, storageRemove: 0 };
    // Backing store for the staged result, read DIRECTLY by the page.
    const localData = { [RESULT_KEY]: { inventory: {}, analysis: {}, deep: false } };
    const listeners = new Set();
    function respond(callback, obj) { setTimeout(() => { try { callback && callback(obj); } catch (e) {} }, 0); }
    window.chrome = {
      runtime: {
        id: 'fmn256-e2e-stub',
        lastError: null,
        getURL: (p) => p,
        sendMessage: (message, callback) => {
          const type = message && message.type;
          if (type === 'observations:run-audit') {
            window.__obsStub.runAudit++;
            return respond(callback, { ok: true, result: { runKey: RUN_KEY, resultKey: RESULT_KEY, status: 'started', started_at: new Date().toISOString() } });
          }
          if (type === 'observations:get-run-status') {
            window.__obsStub.status++;
            if (window.__obsStub.status <= RUNNING_POLLS) {
              return respond(callback, { ok: true, result: { status: 'running', started_at: 'x' } });
            }
            if (SCENARIO === 'done')  return respond(callback, { ok: true, result: { status: 'done', summary: { counts: {} } } });
            if (SCENARIO === 'error') return respond(callback, { ok: true, result: { status: 'error', error: 'simulated crawl failure' } });
            if (SCENARIO === 'lost')  return respond(callback, { ok: true, result: { status: 'lost', started_at: 'x' } });
            return respond(callback, { ok: true, result: { status: 'none' } });
          }
          if (type === 'observations:get-run-result') {
            // Fallback path only; the page should read storage directly.
            window.__obsStub.getResult++;
            return respond(callback, { ok: true, result: localData[RESULT_KEY] });
          }
          if (type === 'observations:abort') {
            window.__obsStub.abort++;
            return respond(callback, { ok: true, result: { aborted: true } });
          }
          // Anything else (e.g. update-check on page open): benign no-op.
          return respond(callback, { ok: true, result: null });
        },
        onMessage: {
          addListener: (fn) => listeners.add(fn),
          removeListener: (fn) => listeners.delete(fn)
        }
      },
      storage: {
        local: {
          get: async (key) => {
            window.__obsStub.storageGet++;
            if (typeof key === 'string') return { [key]: localData[key] };
            if (Array.isArray(key)) { const o = {}; for (const k of key) o[k] = localData[k]; return o; }
            return { ...localData };
          },
          remove: async (keys) => {
            window.__obsStub.storageRemove++;
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) delete localData[k];
          }
        }
      }
    };
  })();`;
}

const COLLECT_URL = (id) => `chrome-extension://${id}/src/ui/tenant-observations/app.html#/collect`;

test.describe('Tenant Observations Collect polling (FMN-256)', () => {
  test('done: run-audit -> poll running -> done -> get-run-result -> navigate to /analyze', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.addInitScript(makeStubScript('done'));
    await page.goto(COLLECT_URL(extensionId));

    // The Collect step starts the detached run and polls. FMN-257 replaced
    // the old single flashing phase-label with a persistent phase stepper.
    await expect(page.locator('[data-test="phase-stepper"]')).toBeVisible();

    // Terminal: the step pulled the result and navigated to /analyze.
    await expect(page).toHaveURL(/#\/analyze$/, { timeout: 15000 });
    await expect(page.getByRole('heading', { name: /Analysis ready/i })).toBeVisible();

    // The full sequence ran: start, >=2 status polls, and the result was
    // read DIRECTLY from chrome.storage.local (not over sendMessage).
    const stub = await page.evaluate(() => window.__obsStub);
    expect(stub.runAudit).toBe(1);
    expect(stub.status).toBeGreaterThanOrEqual(2);
    expect(stub.storageGet).toBeGreaterThanOrEqual(1);
    expect(stub.storageRemove).toBeGreaterThanOrEqual(1);
    expect(stub.getResult).toBe(0); // never used the sendMessage fallback

    await page.close();
  });

  test('error: terminal error status surfaces the message and a Back-to-start button, no result pull', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.addInitScript(makeStubScript('error'));
    await page.goto(COLLECT_URL(extensionId));

    const state = page.locator('.execute-state');
    await expect(state).toHaveText(/Error:.*simulated crawl failure/, { timeout: 15000 });
    await expect(state).toHaveClass(/error/);
    await expect(page.getByRole('button', { name: /Back to start/ })).toBeVisible();
    // Stays on /collect (no navigation on error).
    await expect(page).toHaveURL(/#\/collect$/);

    const stub = await page.evaluate(() => window.__obsStub);
    expect(stub.getResult).toBe(0); // never pulled a result for a failed run

    await page.close();
  });

  test('lost: orphaned run (worker died) surfaces a reload-and-retry message', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await page.addInitScript(makeStubScript('lost'));
    await page.goto(COLLECT_URL(extensionId));

    const state = page.locator('.execute-state');
    await expect(state).toHaveText(/background worker stopped|Reload/i, { timeout: 15000 });
    await expect(state).toHaveClass(/error/);
    await expect(page).toHaveURL(/#\/collect$/);

    await page.close();
  });
});
