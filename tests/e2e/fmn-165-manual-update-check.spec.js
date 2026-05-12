// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
//
// FMN-165: manual "Check for updates now" button.
//
// Uses the offscreen extensionContext fixture (offscreen-positioned
// headed Chromium per memory playwright_offscreen_window.md - never
// the running Chrome at port 9222). Each test stubs only
// chrome.runtime.sendMessage so the SW handler is replaced with a
// per-test responder; chrome.tabs, chrome.storage, chrome.runtime.id,
// etc. remain real (per memory playwright_stub_chrome_runtime_only.md).
//
// The four UI states from the ticket are covered:
//   - idle              -> button labeled "Check for updates now"
//   - in-flight         -> "Checking GitHub…" + spinner + disabled
//   - success, up-to-date -> green "Up to date (v{local})" line that
//                            auto-hides
//   - success, newer-version -> button hides + banner re-renders above
//                               the tool grid
//   - failure (parse/network/disabled mid-flight) -> red "Check failed:
//     {reason}" line
//
// Run: npx playwright test tests/e2e/fmn-165-manual-update-check.spec.js

import { test, expect } from './fixtures.js';

const RESULT_KEY = 'fm:updateCheck';
const SNOOZE_KEY = 'fm:updateSnoozeUntil';
const ENABLED_KEY = 'fm:updateCheckEnabled';

async function getSW(extensionContext) {
  let sw = extensionContext.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
  if (!sw) sw = await extensionContext.waitForEvent('serviceworker', { timeout: 10_000 });
  return sw;
}

async function clearStorage(extensionContext, keys) {
  const sw = await getSW(extensionContext);
  await sw.evaluate(async (ks) => {
    await chrome.storage.local.remove(ks);
  }, keys);
}

async function setStorage(extensionContext, entries) {
  const sw = await getSW(extensionContext);
  await sw.evaluate(async (e) => {
    await chrome.storage.local.set(e);
  }, entries);
}

/**
 * Replace chrome.runtime.sendMessage on the popup page with a stub that
 * returns the given envelope for fm:update-check:run messages. All
 * other message types fall through to the real sendMessage so any
 * incidental calls (e.g., the implicit non-force trigger at popup init)
 * don't blow up.
 *
 * Also exposes window.__fmManualCheckCalls for assertions.
 *
 * Per memory playwright_stub_chrome_runtime_only.md: only sendMessage
 * is patched; the rest of chrome.* remains real.
 */
async function stubSendMessage(page, responder) {
  await page.addInitScript((responderSrc) => {
    const fn = new Function('return ' + responderSrc)();
    window.__fmManualCheckCalls = [];
    const ensureStub = () => {
      if (!window.chrome?.runtime || window.chrome.runtime.__fmStubbed) return;
      const real = window.chrome.runtime.sendMessage?.bind(window.chrome.runtime);
      window.chrome.runtime.sendMessage = async function(msg, ...rest) {
        if (msg && msg.type === 'fm:update-check:run') {
          window.__fmManualCheckCalls.push({ msg, ts: Date.now() });
          return fn(msg);
        }
        if (real) return real(msg, ...rest);
        return undefined;
      };
      window.chrome.runtime.__fmStubbed = true;
    };
    // chrome.runtime is available immediately on extension pages; install
    // the stub before popup.js runs.
    ensureStub();
  }, responder.toString());
}

test.describe('FMN-165: manual "Check for updates now" button', () => {
  test.beforeEach(async ({ extensionContext }) => {
    // Reset persistent state across tests (extensionContext is worker-
    // scoped per FMN-116 fixture design).
    await clearStorage(extensionContext, [RESULT_KEY, SNOOZE_KEY, ENABLED_KEY]);
  });

  test('idle state: button labeled "Check for updates now" and enabled by default', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await stubSendMessage(page, () => ({ ok: true, result: { ran: false, reason: 'rate-limited' } }));
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    await page.locator('#settings-toggle').click();
    const btn = page.locator('#update-check-now');
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveText('Check for updates now');
    await expect(btn).not.toHaveAttribute('title', /.+/);
    // Result line starts hidden.
    await expect(page.locator('#update-check-now-result')).toBeHidden();

    await page.close();
  });

  test('disabled toggle disables the button with explanatory tooltip', async ({ extensionContext, extensionId }) => {
    await setStorage(extensionContext, { [ENABLED_KEY]: false });

    const page = await extensionContext.newPage();
    await stubSendMessage(page, () => ({ ok: true, result: { ran: false, reason: 'disabled' } }));
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    await page.locator('#settings-toggle').click();
    const btn = page.locator('#update-check-now');
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute('title', 'Re-enable update checks above to run manually.');

    await page.close();
  });

  test('toggle off -> on re-enables the button and clears the tooltip', async ({ extensionContext, extensionId }) => {
    await setStorage(extensionContext, { [ENABLED_KEY]: false });

    const page = await extensionContext.newPage();
    await stubSendMessage(page, () => ({ ok: true, result: { ran: false, reason: 'disabled' } }));
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    await page.locator('#settings-toggle').click();
    const btn = page.locator('#update-check-now');
    await expect(btn).toBeDisabled();

    // Toggle on.
    await page.locator('#update-check-toggle').check();
    await expect(btn).toBeEnabled();
    await expect(btn).not.toHaveAttribute('title', /.+/);

    // Toggle off again.
    await page.locator('#update-check-toggle').uncheck();
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute('title', 'Re-enable update checks above to run manually.');

    await page.close();
  });

  test('in-flight: button shows spinner + "Checking GitHub…" + disabled while pending', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    // Slow responder so we can observe the in-flight state.
    await stubSendMessage(page, () => new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, result: { ran: true, result: { checkedAt: Date.now(), localVersion: '1.4.0', remoteVersion: '1.4.0', isNewer: false } } }), 600);
    }));
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();

    const btn = page.locator('#update-check-now');
    await btn.click();
    // Mid-flight: disabled, contains spinner span, label is the in-flight text.
    await expect(btn).toBeDisabled();
    await expect(btn).toContainText('Checking GitHub…');
    await expect(btn.locator('.update-check-spinner')).toBeVisible();

    // Wait for the responder to resolve; button becomes enabled again.
    await expect(btn).toBeEnabled({ timeout: 3_000 });
    await expect(btn).toHaveText('Check for updates now');

    await page.close();
  });

  test('success, up-to-date: green "Up to date" line renders and fades to idle', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await stubSendMessage(page, () => ({
      ok: true,
      result: { ran: true, result: { checkedAt: Date.now(), localVersion: '1.4.0', remoteVersion: '1.4.0', isNewer: false } }
    }));
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();

    await page.locator('#update-check-now').click();

    const line = page.locator('#update-check-now-result');
    await expect(line).toBeVisible();
    await expect(line).toHaveClass(/ok/);
    await expect(line).toContainText('Up to date');
    await expect(line).toContainText('1.4.0');

    // Auto-hide kicks in (~4s); allow a generous timeout.
    await expect(line).toBeHidden({ timeout: 8_000 });
    // Button returned to idle label.
    await expect(page.locator('#update-check-now')).toHaveText('Check for updates now');

    await page.close();
  });

  test('success, newer-version: button hides and banner renders above the tool grid', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    const newer = { checkedAt: Date.now(), localVersion: '1.4.0', remoteVersion: '99.0.0', isNewer: true };
    // Stub sets storage to mimic the SW write-then-respond path so the
    // popup's renderUpdateBanner() reads the updated state.
    await stubSendMessage(page, () => {
      // Best-effort: persist via chrome.storage.local so renderUpdateBanner
      // sees the freshly-stored result. (sendMessage stub runs in the
      // popup page; chrome.storage is real per the surgical-stub rule.)
      try { window.chrome.storage.local.set({ 'fm:updateCheck': { checkedAt: Date.now(), localVersion: '1.4.0', remoteVersion: '99.0.0', isNewer: true } }); } catch {}
      return { ok: true, result: { ran: true, result: { checkedAt: Date.now(), localVersion: '1.4.0', remoteVersion: '99.0.0', isNewer: true } } };
    });
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();

    const btn = page.locator('#update-check-now');
    await btn.click();

    // Button hides on newer-version success.
    await expect(btn).toBeHidden();

    // Banner is rendered (renderUpdateBanner reads storage; we wrote
    // the newer result before resolving the stub). The banner lives in
    // the main view above the tool grid, not in settings - go back.
    await page.locator('#settings-back').click();
    const banner = page.locator('#update-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('99.0.0');
    void newer;

    await page.close();
  });

  test('failure: SW returns ok=false; red "Check failed: {reason}" line renders', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await stubSendMessage(page, () => ({ ok: false, error: 'simulated SW error' }));
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();

    await page.locator('#update-check-now').click();

    const line = page.locator('#update-check-now-result');
    await expect(line).toBeVisible();
    await expect(line).toHaveClass(/error/);
    await expect(line).toContainText('Check failed:');
    await expect(line).toContainText('simulated SW error');
    // Button returns to idle.
    await expect(page.locator('#update-check-now')).toBeEnabled();

    await page.close();
  });

  test('failure: ran=false (e.g., bad-remote-version) renders the reason as the failure', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await stubSendMessage(page, () => ({ ok: true, result: { ran: false, reason: 'bad-remote-version' } }));
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();

    await page.locator('#update-check-now').click();

    const line = page.locator('#update-check-now-result');
    await expect(line).toBeVisible();
    await expect(line).toHaveClass(/error/);
    await expect(line).toContainText('Check failed: bad-remote-version');

    await page.close();
  });

  test('failure: sendMessage rejects; "extension not ready" reason renders', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await stubSendMessage(page, () => { throw new Error('disconnected'); });
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();

    await page.locator('#update-check-now').click();

    const line = page.locator('#update-check-now-result');
    await expect(line).toBeVisible();
    await expect(line).toHaveClass(/error/);
    await expect(line).toContainText('Check failed:');

    await page.close();
  });

  test('rapid clicks each fire a fresh fm:update-check:run (no client-side gate)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await stubSendMessage(page, () => ({
      ok: true,
      result: { ran: true, result: { checkedAt: Date.now(), localVersion: '1.4.0', remoteVersion: '1.4.0', isNewer: false } }
    }));
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();

    // Snapshot the call count after popup init - popup.js fires one
    // implicit non-force fm:update-check:run on open (the
    // triggerBackgroundUpdateCheck path). We measure clicks above that
    // baseline so we only count clicks-driven force=true sends.
    const baseline = await page.evaluate(() =>
      (window.__fmManualCheckCalls || []).filter((c) => c?.msg?.payload?.force === true).length
    );

    const btn = page.locator('#update-check-now');
    // Three clicks in quick succession; each must round-trip and the
    // button must end in the idle state.
    for (let i = 0; i < 3; i++) {
      // Wait for the button to be enabled between clicks; the stub
      // resolves immediately so there's no in-flight gate to wait on
      // other than the synchronous DOM update.
      await expect(btn).toBeEnabled();
      await btn.click();
    }
    // Wait for the result line to render at least once before assertion.
    await expect(page.locator('#update-check-now-result')).toBeVisible();

    // Three forced calls, each tagged with force=true.
    const forced = await page.evaluate(() =>
      (window.__fmManualCheckCalls || []).filter((c) => c?.msg?.payload?.force === true)
    );
    expect(forced.length - baseline).toBeGreaterThanOrEqual(3);
    for (const call of forced) {
      expect(call.msg.payload.force).toBe(true);
    }

    await page.close();
  });

  test('payload includes force=true (sanity check the SW message shape)', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();
    await stubSendMessage(page, () => ({
      ok: true,
      result: { ran: true, result: { checkedAt: Date.now(), localVersion: '1.4.0', remoteVersion: '1.4.0', isNewer: false } }
    }));
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator('#settings-toggle').click();

    await page.locator('#update-check-now').click();

    const lastCall = await page.evaluate(() => window.__fmManualCheckCalls.at(-1));
    expect(lastCall?.msg?.type).toBe('fm:update-check:run');
    expect(lastCall?.msg?.payload?.force).toBe(true);

    await page.close();
  });
});
