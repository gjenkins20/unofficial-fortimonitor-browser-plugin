// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-206 follow-up: Bulk Composer commit step must surface row-level
// failure reasons on screen.
//
// Pre-fix bug: commit.js stored detailEl as detailCell.firstChild AFTER
// the span had been moved into detailTr (h(td, ..., span) appends the
// span to the new td, leaving detailCell.firstChild === null). Rows
// that failed showed the original desc.note ("Server tag list not in
// cache; commit will read-modify-write") instead of the real error.
//
// Verification approach: install an addInitScript that captures every
// chrome.runtime.onMessage listener so the test can synthesize row-done
// events. Then drive /commit, click Apply (with a sendMessage stub that
// returns a synthetic result), fire failure events, and assert the
// detail row shows the error text.
//
// Run: npx playwright test tests/e2e/fmn-206-commit-error-display.spec.js

import { test, expect } from './fixtures.js';

test.describe('FMN-206 follow-up: commit step surfaces row errors', () => {
  test('Failed rows display error text from row-done events', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();

    // Capture chrome.runtime.onMessage listeners as they're registered.
    // The popup's messaging.js registers one inside onEvent() at module
    // load; we need to grab it before that import runs.
    await page.addInitScript(() => {
      window.__fmn206Listeners = [];
      const tryInstall = () => {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
          const orig = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
          chrome.runtime.onMessage.addListener = (cb) => {
            window.__fmn206Listeners.push(cb);
            return orig(cb);
          };
          return true;
        }
        return false;
      };
      if (!tryInstall()) {
        Object.defineProperty(window, 'chrome', {
          configurable: true,
          set(v) {
            Object.defineProperty(window, 'chrome', { configurable: true, writable: true, value: v });
            tryInstall();
          }
        });
      }
    });

    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    // Stub sendMessage so bulk-composer:commit returns a deterministic
    // result without hitting the SW. The result shape mirrors what the
    // real handler returns.
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = function (msg, cb) {
        const type = msg && msg.type;
        if (type === 'bulk-composer:commit') {
          const result = {
            actionId: 'remove-tag',
            params: { tag: 'doomed' },
            rows: [
              { id: 100, name: 's100', status: 'failed', error: 'GET /server/100 failed: HTTP 404', errorStatus: 404 },
              { id: 101, name: 's101', status: 'succeeded', noop: false }
            ],
            startedAt: new Date(Date.now() - 4000).toISOString(),
            finishedAt: new Date().toISOString(),
            aborted: false,
            succeeded: 1,
            failed: 1,
            noops: 0
          };
          if (typeof cb === 'function') cb({ ok: true, result });
          return undefined;
        }
        // omni-search:lookup-by-ids / list-tags-batch from the configure
        // step won't reach this page since we navigate directly to
        // /commit, but stub them defensively to avoid SW round-trips.
        if (type === 'omni-search:lookup-by-ids' || type === 'bulk-composer:list-tags-batch') {
          if (typeof cb === 'function') cb({ ok: true, result: { byServerId: {} } });
          return undefined;
        }
        return original(msg, cb);
      };
    });

    // Seed targets + action and navigate to /commit.
    // Row 100: no tags field -> describe returns note "Server tag list
    //          not in cache; commit will read-modify-write." Detail row
    //          starts visible with that text; commit-time failure
    //          replaces it with the error.
    // Row 101: tags includes 'doomed' -> describe returns willChange=true
    //          with no note. Detail row starts hidden and stays hidden
    //          on success.
    await page.evaluate(async () => {
      const mod = await import('./app.js');
      mod.store.targets = [
        { id: 100, name: 's100' },
        { id: 101, name: 's101', tags: ['doomed', 'keep'] }
      ];
      mod.store.actionId = 'remove-tag';
      mod.store.params = { tag: 'doomed' };
      window.location.hash = '#/commit';
    });

    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('4. Preview', { timeout: 5000 });
    await expect(page.locator('[data-test="bulk-preview-row"]')).toHaveCount(2);

    // Both detail rows are mounted; row 100's is visible (carries note),
    // row 101's is hidden (no note).
    const detailRows = page.locator('[data-test="bulk-preview-detail"]');
    await expect(detailRows).toHaveCount(2);
    await expect(detailRows.nth(0)).toBeVisible();
    await expect(detailRows.nth(1)).toBeHidden();

    // Click Apply. The stub returns the result synchronously via cb,
    // but the event-driven per-row UI updates rely on row-done events.
    // We synthesize those next.
    await page.locator('[data-test="apply-btn"]').click();

    // Fire row events through the captured listener.
    await page.evaluate(() => {
      const fire = (event, payload) => {
        for (const cb of window.__fmn206Listeners) {
          cb({ type: '__event__', event, payload });
        }
      };
      fire('bulk-composer:row-start', { index: 0, id: 100, name: 's100' });
      fire('bulk-composer:row-done', {
        index: 0, id: 100, name: 's100',
        status: 'failed',
        error: 'GET /server/100 failed: HTTP 404',
        errorStatus: 404,
        retryable: false
      });
      fire('bulk-composer:row-start', { index: 1, id: 101, name: 's101' });
      fire('bulk-composer:row-done', {
        index: 1, id: 101, name: 's101',
        status: 'succeeded',
        noop: false
      });
    });

    // Status pills updated.
    const statuses = page.locator('[data-test="preview-status"]');
    await expect(statuses.nth(0)).toContainText('failed');
    await expect(statuses.nth(1)).toContainText('committed');

    // Detail row for row #1 now shows the error text + HTTP status.
    const detailTexts = page.locator('[data-test="bulk-preview-detail-text"]');
    await expect(detailTexts.nth(0)).toContainText('GET /server/100 failed: HTTP 404');
    await expect(detailTexts.nth(0)).toContainText('(HTTP 404)');
    // The corresponding detail row is now visible.
    await expect(detailRows.nth(0)).toBeVisible();
    // Row #1's detail row stays hidden (no error, no note).
    await expect(detailRows.nth(1)).toBeHidden();

    // Run summary reflects the mix.
    await expect(page.locator('[data-test="bulk-run-summary"]')).toContainText('1 committed');
    await expect(page.locator('[data-test="bulk-run-summary"]')).toContainText('1 failed');

    await page.close();
  });

  test('Detail row falls back to a placeholder when SW emits no error text', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();

    await page.addInitScript(() => {
      window.__fmn206Listeners = [];
      const tryInstall = () => {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
          const orig = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
          chrome.runtime.onMessage.addListener = (cb) => {
            window.__fmn206Listeners.push(cb);
            return orig(cb);
          };
          return true;
        }
        return false;
      };
      if (!tryInstall()) {
        Object.defineProperty(window, 'chrome', {
          configurable: true,
          set(v) {
            Object.defineProperty(window, 'chrome', { configurable: true, writable: true, value: v });
            tryInstall();
          }
        });
      }
    });

    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = function (msg, cb) {
        const type = msg && msg.type;
        if (type === 'bulk-composer:commit') {
          if (typeof cb === 'function') cb({ ok: true, result: {
            actionId: 'remove-tag', params: { tag: 'x' }, rows: [],
            startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
            aborted: false, succeeded: 0, failed: 1, noops: 0
          } });
          return undefined;
        }
        if (type === 'omni-search:lookup-by-ids' || type === 'bulk-composer:list-tags-batch') {
          if (typeof cb === 'function') cb({ ok: true, result: { byServerId: {} } });
          return undefined;
        }
        return original(msg, cb);
      };
    });

    await page.evaluate(async () => {
      const mod = await import('./app.js');
      mod.store.targets = [{ id: 200, name: 's200' }];
      mod.store.actionId = 'remove-tag';
      mod.store.params = { tag: 'x' };
      window.location.hash = '#/commit';
    });

    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('4. Preview', { timeout: 5000 });
    await page.locator('[data-test="apply-btn"]').click();

    await page.evaluate(() => {
      for (const cb of window.__fmn206Listeners) {
        cb({ type: '__event__', event: 'bulk-composer:row-done', payload: {
          index: 0, id: 200, name: 's200', status: 'failed'
          // intentionally no error / errorStatus
        }});
      }
    });

    await expect(page.locator('[data-test="bulk-preview-detail-text"]').first())
      .toContainText('(no error message returned)');

    await page.close();
  });
});
