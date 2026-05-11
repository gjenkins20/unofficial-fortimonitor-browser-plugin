// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-160 live spec: FM TK Search matches by instance ID.
//
// Operator workflow: paste an ID copied from a URL / log / ticket into
// the FM TK Search bar and expect the matching instance to surface with
// the `id` badge and an `#<id>` snippet, with a click that navigates to
// /report/Instance/<id>/details.
//
// Runs against the persistent Dev Launcher (tools/dev/launcher.mjs) over
// CDP. Requires a signed-in FortiMonitor session with omni-search warmed.
//
// Run: npx playwright test tests/e2e/fmn-160-search-by-id-live.spec.js

import { test as base, expect, chromium } from '@playwright/test';

const FM = 'https://fortimonitor.forticloud.com';
const LIST_URL = `${FM}/report/ListServers`;
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const CDP_URL = `http://localhost:${CDP_PORT}`;

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
    if (!ctx) throw new Error('CDP browser has no contexts');
    let page = ctx.pages().find((p) => p.url().startsWith(FM));
    if (!page) page = ctx.pages()[0] || await ctx.newPage();
    if (!page.url().includes('/report/ListServers')) {
      await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
    }
    if (await page.locator('input[type="password"]').count()) {
      throw new Error('FortiMonitor is at a login screen. Sign in in the launcher window and re-run.');
    }
    // Ensure omni-search is enabled, then wait for the chip to stop pulsing
    // (cache fully warm). The chip pulses while a warm/refresh is in flight.
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
    if (sw) {
      await sw.evaluate(() => chrome.storage.local.set({ 'fm:omniSearchEnabled': true }));
    }
    await page.waitForSelector('#fmn-omni-search-input', { timeout: 30_000 });
    await page.waitForFunction(
      () => !document.querySelector('.fmn-omni-chip.is-warming'),
      { timeout: 60_000 }
    );
    await use(page);
    await browser.close();
  }, { scope: 'worker' }],
});

test.setTimeout(120_000);

test.describe('FMN-160: FM TK Search matches by instance ID', () => {
  test('cache corpus includes server.id so substring filter finds it', async ({ livePage }) => {
    const page = livePage;
    const ctx = page.context();
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
    const sample = await sw.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      const cacheKey = Object.keys(all).find((k) => k.startsWith('fm:omni-search-cache:'));
      if (!cacheKey) return { error: 'no cache' };
      const cache = all[cacheKey];
      const servers = Array.isArray(cache?.servers) ? cache.servers : [];
      const corpus = Array.isArray(cache?.corpus) ? cache.corpus : [];
      if (servers.length === 0) return { error: 'cache has no servers' };
      // Pick the first server with a numeric id and assert the corpus
      // entry at the same index contains its id.
      let firstWithId = -1;
      for (let i = 0; i < servers.length; i++) {
        if (typeof servers[i].id === 'number') { firstWithId = i; break; }
      }
      if (firstWithId === -1) return { error: 'no server with numeric id' };
      return {
        id: servers[firstWithId].id,
        corpusContainsId: corpus[firstWithId]?.includes(String(servers[firstWithId].id)),
      };
    });
    test.skip(sample.error, `Cache unavailable: ${sample.error}`);
    expect(sample.corpusContainsId).toBe(true);
  });

  test('exact-id query labels the match with field=id and renders #<id> snippet', async ({ livePage }) => {
    const page = livePage;
    const ctx = page.context();
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));

    // Pick a known id from the cache so the assertion isn't tied to a
    // specific tenant. Reading via the SW dodges the page-world chrome.*
    // limitation that bit FMN-153.
    const pickedId = await sw.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      const cacheKey = Object.keys(all).find((k) => k.startsWith('fm:omni-search-cache:'));
      if (!cacheKey) return null;
      const servers = all[cacheKey]?.servers || [];
      for (const s of servers) {
        if (typeof s.id === 'number' && /^\d+$/.test(String(s.id))) return s.id;
      }
      return null;
    });
    test.skip(!pickedId, 'No id-bearing server in cache.');

    // Drive the FM TK Search input with the id. omni-search query is
    // debounced; wait for the dropdown's first row to render.
    await page.locator('#fmn-omni-search-input').fill(String(pickedId));
    await page.waitForSelector('#fmn-omni-search-dropdown .fmn-omni-row', { timeout: 10_000 });

    // Read the top row's badge + snippet.
    const top = await page.evaluate(() => {
      const row = document.querySelector('#fmn-omni-search-dropdown .fmn-omni-row');
      if (!row) return null;
      return {
        name: row.querySelector('.fmn-omni-row-name')?.textContent ?? '',
        snippet: row.querySelector('.fmn-omni-row-snippet')?.textContent ?? '',
        badge: row.querySelector('.fmn-omni-badge')?.textContent ?? '',
      };
    });
    expect(top).not.toBeNull();
    expect(top.badge).toBe('id');
    expect(top.snippet).toBe('#' + pickedId);
  });

  test('prefix-id query (4 leading digits of an id) returns at least one id-labeled match', async ({ livePage }) => {
    const page = livePage;
    const ctx = page.context();
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));

    const pickedPrefix = await sw.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      const cacheKey = Object.keys(all).find((k) => k.startsWith('fm:omni-search-cache:'));
      if (!cacheKey) return null;
      const servers = all[cacheKey]?.servers || [];
      for (const s of servers) {
        if (typeof s.id === 'number') {
          const str = String(s.id);
          if (str.length >= 5) return str.slice(0, 4);
        }
      }
      return null;
    });
    test.skip(!pickedPrefix, 'No id with at least 5 digits to take a 4-digit prefix from.');

    await page.locator('#fmn-omni-search-input').fill(pickedPrefix);
    await page.waitForSelector('#fmn-omni-search-dropdown .fmn-omni-row', { timeout: 10_000 });

    const idLabeled = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#fmn-omni-search-dropdown .fmn-omni-row'));
      return rows.some((r) => r.querySelector('.fmn-omni-badge')?.textContent === 'id');
    });
    expect(idLabeled).toBe(true);
  });
});
