// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-187: when Vue removes our card from .pa-hList during its periodic
// reconciliation, a dedicated MutationObserver pointed at the host re-mounts
// the card within a single event-loop tick. Pre-fix worst case was 35
// seconds; post-fix should be ~10ms.
//
// Run: npx playwright test tests/e2e/fmn-187-snapshot-card-remount.spec.js

import { test as base, expect, chromium } from '@playwright/test';

const FM = 'https://fortimonitor.forticloud.com';
const REPORTS_URL = `${FM}/report/ListReports`;
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const CDP_URL = `http://localhost:${CDP_PORT}`;
const CARD_SELECTOR = '[data-fmn-entry="fmn-snapshot-diff-card"]';

const test = base.extend({
  livePage: [async ({}, use) => {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
    } catch (e) {
      throw new Error(
        `Could not connect to Chromium at ${CDP_URL}. ` +
        `Start the persistent launcher first: \`node tools/dev/launcher.mjs\`. ` +
        `Underlying error: ${e.message}`
      );
    }
    const ctx = browser.contexts()[0];
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
    if (sw) await sw.evaluate(() => chrome.storage.local.set({ 'fm:snapshotDiffEnabled': true }));

    let page = ctx.pages().find((p) => p.url().startsWith(FM));
    if (!page) page = await ctx.newPage();
    if (!page.url().includes('/report/ListReports')) {
      await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
    } else {
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
    if (await page.locator('input[type="password"]').count()) {
      throw new Error('FortiMonitor is at a login screen. Sign in in the launcher window and re-run.');
    }
    await page.waitForSelector('.pa-hList .pa-card', { timeout: 30_000 });
    await page.waitForSelector(CARD_SELECTOR, { timeout: 15_000 });
    await use(page);
    await browser.close();
  }, { scope: 'worker' }],
});

test.setTimeout(60_000);

test.describe('FMN-187: Snapshot card re-mounts on forced removal', () => {
  test('single removal: card reappears within 100ms', async ({ livePage }) => {
    const page = livePage;
    const remountMs = await page.evaluate(async (sel) => {
      const card = document.querySelector(sel);
      const t0 = performance.now();
      card.remove();
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 5));
        if (document.querySelector(sel)) return Math.round(performance.now() - t0);
      }
      return -1;
    }, CARD_SELECTOR);
    expect(remountMs).toBeGreaterThanOrEqual(0);
    expect(remountMs).toBeLessThan(100);
  });

  test('repeated removals: card always reappears within 100ms', async ({ livePage }) => {
    const page = livePage;
    const samples = await page.evaluate(async (sel) => {
      const out = [];
      for (let i = 0; i < 10; i++) {
        const card = document.querySelector(sel);
        if (!card) { out.push(-2); continue; }
        const t0 = performance.now();
        card.remove();
        let recorded = -1;
        for (let t = 0; t < 50; t++) {
          await new Promise(r => setTimeout(r, 5));
          if (document.querySelector(sel)) { recorded = Math.round(performance.now() - t0); break; }
        }
        out.push(recorded);
        await new Promise(r => setTimeout(r, 100));
      }
      return out;
    }, CARD_SELECTOR);
    for (const ms of samples) {
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(100);
    }
  });

  test('host replacement: simulate Vue replacing .pa-hList entirely, card re-attaches to the new host', async ({ livePage }) => {
    const page = livePage;
    const result = await page.evaluate(async (sel) => {
      const oldHost = document.querySelector('.pa-hList');
      if (!oldHost) return { error: 'no host' };
      const parent = oldHost.parentElement;
      if (!parent) return { error: 'no parent' };

      // Vue's reconciliation pattern: remove the existing UL and insert a
      // fresh one in its place. Copy native pa-card children to retain
      // the visual context but EXCLUDE our card (simulating that Vue's
      // data model doesn't know about us).
      const newHost = document.createElement('ul');
      newHost.className = oldHost.className;
      for (const child of Array.from(oldHost.children)) {
        if (child.getAttribute('data-fmn-entry') === 'fmn-snapshot-diff-card') continue;
        newHost.appendChild(child.cloneNode(true));
      }
      const t0 = performance.now();
      parent.replaceChild(newHost, oldHost);

      // Poll for card to re-attach to the new host.
      let elapsed = -1;
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 10));
        const card = document.querySelector(sel);
        if (card && newHost.contains(card)) { elapsed = Math.round(performance.now() - t0); break; }
      }
      return {
        remountMs: elapsed,
        attachedToNewHost: Boolean(newHost.querySelector(sel)),
        oldHostDetached: !document.body.contains(oldHost),
      };
    }, CARD_SELECTOR);
    expect(result.attachedToNewHost).toBe(true);
    expect(result.oldHostDetached).toBe(true);
    expect(result.remountMs).toBeGreaterThanOrEqual(0);
    expect(result.remountMs).toBeLessThan(1000);
  });
});
