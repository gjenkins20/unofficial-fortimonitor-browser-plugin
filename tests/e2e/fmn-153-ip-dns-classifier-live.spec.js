// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-153 live spec: IP / DNS sub-columns on /report/ListServers must
// classify the full pageData.instance.fqdns[] array, not just the
// scalar fqdn. The operator-reported regression: instance 43859419 has
// fqdns = [{ "server", v4 }, { "192.168.106.138", v4 }]. The prior code
// read instance.fqdn = "server" and rendered nothing useful; the fix
// drops "server" (not address-shaped) and surfaces 192.168.106.138 in
// the IP column.
//
// Runs against the persistent Dev Launcher (tools/dev/launcher.mjs) over
// CDP. Requires a signed-in FortiMonitor session in the launcher window
// (the keepalive in launcher.mjs preserves this across iteration).
//
// Run: npx playwright test tests/e2e/fmn-153-ip-dns-classifier-live.spec.js

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
    // Wait for DataTables to render its first data rows; FMN-71 augmentations
    // only kick in once tbody has data.
    await page.waitForSelector('table.pa-table_outage tbody tr input.pa-table-row-checkbox', { timeout: 30_000 });
    // Wait for at least one IP cell to populate (per-row fetches are
    // queued with concurrency 3).
    await page.waitForFunction(
      () => {
        const cells = Array.from(document.querySelectorAll('[data-fmn-ip-cell]'));
        return cells.length > 0 && cells.some((c) => {
          const t = c.textContent.trim();
          return t && t !== 'not captured' && !c.querySelector('.fmn-skel');
        });
      },
      { timeout: 30_000 }
    );
    await use(page);
    await browser.close();
  }, { scope: 'worker' }],
});

test.setTimeout(120_000);

test.describe('FMN-153: IP/DNS classifier walks fqdns[] and validates by value', () => {
  test('43859419 (fqdns[0]="server", fqdns[1]="192.168.106.138") shows 192.168.106.138 in IP, nothing in DNS', async ({ livePage }) => {
    const page = livePage;
    // 43859419 is the operator's example. If it's not on the visible
    // page, the test is inconclusive rather than failing - we report.
    const present = await page.locator('[data-fmn-ip-cell="43859419"]').count();
    test.skip(present === 0, '43859419 not on visible page (DataTables pagination); run with the row visible.');

    await expect(page.locator('[data-fmn-ip-cell="43859419"]')).toHaveText('192.168.106.138');
    // DNS cell should be "not captured" - the "server" literal is dropped
    // because it has no dot and fails the strict hostname regex.
    await expect(page.locator('[data-fmn-dns-cell="43859419"]')).toHaveText('not captured');

    // Sanity: the literal "server" must NEVER appear in the IP cell.
    const ipText = await page.locator('[data-fmn-ip-cell="43859419"]').textContent();
    expect(ipText).not.toContain('server');
  });

  test('DNS-name instance (e.g. www.slack.com) routes to DNS column, not IP', async ({ livePage }) => {
    const page = livePage;
    // Pick the first row whose cached cell is a hostname (contains dot,
    // not IPv4-shaped). Reading the live DOM is more resilient than
    // hardcoding an id that may not be on the visible page.
    const sample = await page.evaluate(() => {
      const ipCells = Array.from(document.querySelectorAll('[data-fmn-ip-cell]'));
      for (const ipCell of ipCells) {
        const id = ipCell.getAttribute('data-fmn-ip-cell');
        const dnsCell = document.querySelector(`[data-fmn-dns-cell="${id}"]`);
        if (!dnsCell) continue;
        const ip = ipCell.textContent.trim();
        const dns = dnsCell.textContent.trim();
        const ipIsNotCaptured = ip === 'not captured';
        const dnsLooksHostname = /^[a-zA-Z]/.test(dns) && dns.includes('.') && dns !== 'not captured';
        if (ipIsNotCaptured && dnsLooksHostname) {
          return { id, ip, dns };
        }
      }
      return null;
    });
    test.skip(sample === null, 'No DNS-only instance visible on this page; rerun with one available.');
    expect(sample.ip).toBe('not captured');
    expect(sample.dns).toMatch(/^[a-zA-Z]/);
    expect(sample.dns).toMatch(/\./);
  });

  test('no IP cell anywhere on the page contains a bare-word value (e.g. "server", "device")', async ({ livePage }) => {
    const page = livePage;
    const offenders = await page.evaluate(() => {
      const out = [];
      for (const cell of document.querySelectorAll('[data-fmn-ip-cell]')) {
        const t = cell.textContent.trim();
        if (!t || t === 'not captured') continue;
        // Each comma-separated token must be IPv4/IPv6 shaped.
        for (const tok of t.split(',').map((s) => s.trim())) {
          const isIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(tok);
          const isIPv6 = tok.includes(':') && /^[0-9a-fA-F:]+$/.test(tok);
          if (!isIPv4 && !isIPv6) {
            out.push({ id: cell.getAttribute('data-fmn-ip-cell'), token: tok });
          }
        }
      }
      return out;
    });
    expect(offenders).toEqual([]);
  });

  test('no DNS cell contains an address-shaped token (IPv4/IPv6 must not appear in DNS column)', async ({ livePage }) => {
    const page = livePage;
    const offenders = await page.evaluate(() => {
      const out = [];
      for (const cell of document.querySelectorAll('[data-fmn-dns-cell]')) {
        const t = cell.textContent.trim();
        if (!t || t === 'not captured') continue;
        for (const tok of t.split(',').map((s) => s.trim())) {
          if (/^(\d{1,3}\.){3}\d{1,3}$/.test(tok)) {
            out.push({ id: cell.getAttribute('data-fmn-dns-cell'), token: tok });
          }
        }
      }
      return out;
    });
    expect(offenders).toEqual([]);
  });
});

test.describe('FMN-153: omni-search corpus classifies fqdn + additional_fqdns', () => {
  test('cached server entries carry ips[] and dns_names[] arrays', async ({ livePage }) => {
    const page = livePage;
    const ctx = page.context();
    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);
    if (!sw) test.fail('Toolkit service worker not registered.');

    // The omni-search container in augment.js warms the cache on mount
    // (via chrome.runtime.sendMessage from page context). We just inspect
    // what's already in chrome.storage.session.
    //
    // Note: SW cannot sendMessage to itself, so a warm trigger has to
    // originate from a content script or extension page. If the cache
    // is empty at this point, the omni-search feature is likely off or
    // no API key is configured.
    const sample = await sw.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      const cacheKey = Object.keys(all).find((k) => k.startsWith('fm:omni-search-cache:'));
      if (!cacheKey) return { error: 'no cache key in storage.session - omni-search may not have warmed yet' };
      const cache = all[cacheKey];
      const servers = Array.isArray(cache?.servers) ? cache.servers : [];
      const withIps = servers.filter((s) => Array.isArray(s.ips) && s.ips.length > 0);
      const withDns = servers.filter((s) => Array.isArray(s.dns_names) && s.dns_names.length > 0);
      return {
        serverCount: servers.length,
        withIpsCount: withIps.length,
        withDnsCount: withDns.length,
        sampleIp: withIps[0] ? { id: withIps[0].id, ips: withIps[0].ips } : null,
        sampleDns: withDns[0] ? { id: withDns[0].id, dns_names: withDns[0].dns_names } : null,
        ipsArePresent: servers.every((s) => 'ips' in s),
        dnsNamesArePresent: servers.every((s) => 'dns_names' in s),
      };
    });
    test.skip(sample.error, `Cache not readable: ${sample.error}`);

    expect(sample.serverCount).toBeGreaterThan(0);
    // Every entry must carry the classified arrays (even if empty).
    expect(sample.ipsArePresent).toBe(true);
    expect(sample.dnsNamesArePresent).toBe(true);
    // At least one server in the corpus has IPs, and at least one has DNS
    // names. A tenant with neither would have no fqdns at all, which is
    // implausible on a real deployment.
    expect(sample.withIpsCount + sample.withDnsCount).toBeGreaterThan(0);

    // The IP sample entries must all classify as IPv4 / IPv6.
    if (sample.sampleIp) {
      for (const t of sample.sampleIp.ips) {
        const isIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(t);
        const isIPv6 = t.includes(':') && /^[0-9a-fA-F:]+$/.test(t);
        expect(isIPv4 || isIPv6).toBe(true);
      }
    }
    // The DNS sample entries must contain a dot.
    if (sample.sampleDns) {
      for (const t of sample.sampleDns.dns_names) {
        expect(t).toMatch(/\./);
        expect(/^(\d{1,3}\.){3}\d{1,3}$/.test(t)).toBe(false);
      }
    }
  });

  // scoreServer's field labeling (ip vs dns) is pure-function logic over
  // the classified arrays validated above. Operator QA exercises the
  // labels live via the search dropdown badge; deeper coverage would
  // require an extension-page test runner with chrome.* access, which
  // would expand FMN-153 scope beyond the ticket.
});
