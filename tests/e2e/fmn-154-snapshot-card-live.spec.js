// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-154 live spec: Deployment Snapshot & Diff card mounts on FortiMonitor's
// Canned Reports page (/report/ListReports) styled to match the native
// .pa-card tiles, carries the FMN-86 attribution ribbon, and surfaces
// the snapshot status. The take-snapshot end-to-end (which runs a BPA
// against the v2 API) is not exercised here - it requires an API key
// and several seconds of network; operator QA covers that.
//
// Run: npx playwright test tests/e2e/fmn-154-snapshot-card-live.spec.js

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
    let page = ctx.pages().find((p) => p.url().startsWith(FM));
    if (!page) page = await ctx.newPage();
    if (!page.url().includes('/report/ListReports')) {
      await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
    }
    if (await page.locator('input[type="password"]').count()) {
      throw new Error('FortiMonitor is at a login screen. Sign in in the launcher window and re-run.');
    }
    // Wait for the native .pa-card tiles to render (signal FortiMonitor's
    // SPA has hydrated the Canned Reports view) and our card to mount.
    await page.waitForSelector('.pa-hList .pa-card', { timeout: 30_000 });
    await page.waitForSelector(CARD_SELECTOR, { timeout: 15_000 });
    await use(page);
    await browser.close();
  }, { scope: 'worker' }],
});

test.setTimeout(120_000);

test.describe('FMN-154 phase 1: Snapshot & Diff card on Canned Reports', () => {
  test('card mounts inside the .pa-hList container as a sibling of native tiles', async ({ livePage }) => {
    const page = livePage;
    const info = await page.evaluate(() => {
      const card = document.querySelector('[data-fmn-entry="fmn-snapshot-diff-card"]');
      if (!card) return { mounted: false };
      return {
        mounted: true,
        parentClass: card.parentElement?.className ?? '',
        hasRibbon: !!card.querySelector('.fmn-pa-card-ribbon'),
        title: card.querySelector('.pa-card-hd h3')?.textContent?.trim() ?? '',
        hasCardHd: !!card.querySelector('.pa-card-hd'),
        hasCardBd: !!card.querySelector('.pa-card-bd'),
        hasCardFt: !!card.querySelector('.pa-card-ft'),
      };
    });
    expect(info.mounted).toBe(true);
    expect(info.parentClass).toContain('pa-hList');
    expect(info.hasRibbon).toBe(true);
    expect(info.title).toBe('Snapshot & Diff');
    expect(info.hasCardHd).toBe(true);
    expect(info.hasCardBd).toBe(true);
    expect(info.hasCardFt).toBe(true);
  });

  test('card uses the same .pa-card class as native tiles (style parity)', async ({ livePage }) => {
    const page = livePage;
    const r = await page.evaluate(() => {
      const card = document.querySelector('[data-fmn-entry="fmn-snapshot-diff-card"]');
      return {
        hasPaCard: card?.classList.contains('pa-card') ?? false,
        siblingCount: card?.parentElement?.children.length ?? 0,
      };
    });
    expect(r.hasPaCard).toBe(true);
    // Should be alongside the 18 native Canned Reports tiles (or however
    // many the tenant has).
    expect(r.siblingCount).toBeGreaterThan(1);
  });

  test('Take Snapshot button is the primary action; Open-diff link only appears when a diff is possible', async ({ livePage }) => {
    const page = livePage;
    // Wait for bpa-snapshots:status to resolve and the meta to render.
    await page.waitForFunction(
      () => {
        const meta = document.querySelector(
          '[data-fmn-entry="fmn-snapshot-diff-card"] .fmn-snapshot-meta'
        );
        if (!meta) return false;
        const t = meta.textContent.trim();
        return t && t !== 'Loading...';
      },
      { timeout: 15_000 }
    );
    const r = await page.evaluate(() => {
      const card = document.querySelector('[data-fmn-entry="fmn-snapshot-diff-card"]');
      const takeBtn = card.querySelector('[data-fmn-snapshot-take]');
      const openLink = card.querySelector('.fmn-snapshot-secondary');
      const openAnchor = card.querySelector('[data-fmn-snapshot-open]');
      return {
        takeExists: !!takeBtn,
        takeLabel: takeBtn?.textContent.trim(),
        takeDisabled: takeBtn?.disabled,
        openLinkInDom: !!openLink,
        openLinkHiddenAttr: openLink?.hasAttribute('hidden'),
        openAnchorLabel: openAnchor?.textContent.trim(),
        meta: card.querySelector('.fmn-snapshot-meta')?.textContent.trim(),
      };
    });
    expect(r.takeExists).toBe(true);
    expect(r.takeLabel).toBe('Take Snapshot');
    expect(r.takeDisabled).toBe(false);
    // Open is always in the DOM but hidden until 2 snapshots exist.
    expect(r.openLinkInDom).toBe(true);
    expect(r.openAnchorLabel).toBe('Open diff →');
    if (r.meta && !r.meta.includes(' vs. ')) {
      // Empty state or single-snapshot state: open link must be hidden.
      expect(r.openLinkHiddenAttr).toBe(true);
    } else {
      expect(r.openLinkHiddenAttr).toBe(false);
    }
  });

  test('bpa-snapshots:status handler is registered and returns a coherent shape', async ({ livePage }) => {
    const page = livePage;
    const ctx = page.context();
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
    const keys = await sw.evaluate(() => globalThis.__fmDebugHandlerKeys || []);
    expect(keys).toContain('bpa-snapshots:status');
    expect(keys).toContain('bpa-snapshots:take');
    expect(keys).toContain('bpa-snapshots:diff');
  });

  test('bpa-diff tool page opens and renders the empty state when no snapshot exists', async ({ livePage }) => {
    const page = livePage;
    const ctx = page.context();
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
    const m = sw.url().match(/^chrome-extension:\/\/([^/]+)\//);
    const extensionId = m[1];

    const toolPage = await ctx.newPage();
    await toolPage.goto(`chrome-extension://${extensionId}/src/ui/bpa-diff/app.html`, {
      waitUntil: 'domcontentloaded',
    });
    await toolPage.waitForSelector('h1.title', { timeout: 10_000 });

    const r = await toolPage.evaluate(() => ({
      title: document.querySelector('h1.title')?.textContent?.trim(),
      version: document.querySelector('#version')?.textContent?.trim(),
      contentText: document.getElementById('content')?.textContent?.trim() ?? '',
    }));
    expect(r.title).toBe('Deployment Snapshot & Diff');
    expect(r.version).toMatch(/^v\d+\.\d+\.\d+$/);
    // Either "Take a snapshot first." (no snapshot) OR a real diff. We
    // accept both since the prior cache state isn't guaranteed.
    expect(r.contentText.length).toBeGreaterThan(0);

    await toolPage.close();
  });
});
