// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-298 LIVE spec: download -> anonymize -> audit client templates, driven
// against REAL tenant data over CDP.
//
// The feature has three surfaces, all exercised here against live data:
//   1. The "Export anonymized templates" button on the Tenant Observations
//      Template Analysis tab (viewer.js).
//   2. The template-anonymizer (client-de-identified pack).
//   3. The "Audit an anonymized template pack" file loader on the Start step
//      (start.js), rendering a template-only viewer (audit-from-file).
//
// Read-only against the tenant: it only GETs templates/groups/monitoring-config
// and downloads a local file. It never writes to FortiMonitor.
//
// BEHAVIOR MATRIX (per Verification Discipline - not one happy path):
//   (a) rendered against live templates, the Template Analysis tab renders and
//       the Export button is visible only on that tab;
//   (b) clicking Export downloads a pack whose payload is structurally
//       anonymized (every template name "Template N"; every group name
//       "Group N" or the preserved stock literal; NO tags), preserves the
//       (total_metrics, alerts_count) pairs, and - when the tenant has a
//       "Default Monitoring Templates" group - preserves that stock group name
//       so the analyzer's exemption survives;
//   (c) loading that downloaded pack through the REAL Start-step file input
//       lands on a single-tab (Template Analysis) review whose finding-row
//       counts match the live audit.
//
// SKIP conditions (prerequisites unmet, not a failure):
//   - No extension service worker at the provisioned CDP port.
//   - No v2 API key seeded (panopta.apiKey) - can't fetch templates/groups.
//   - FortiMonitor session at a login screen.
//   - Tenant has zero templates, or session-auth monitoring-config returned
//     nothing (the frontend crawl is unavailable) - the audit has no input.
//
// Run: npm run test:e2e:live   (or target this spec directly)
//   FMN_CDP_PORT=<port> npx playwright test --config tests/e2e/playwright.config.js \
//     tests/e2e/fmn-298-template-anonymize-audit.spec.js --grep "live -" --reporter=line

import { test as base, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FM = 'https://fortimonitor.forticloud.com';
const CDP_PORT = process.env.FMN_CDP_PORT || '9222';
const CDP_URL = `http://localhost:${CDP_PORT}`;
const HOST_ID = '__fmn298host';
const STOCK_GROUP = 'Default Monitoring Templates';
// Cap the session-auth monitoring-config crawl so the spec stays quick.
const MAX_TEMPLATES = 25;

const test = base.extend({
  liveCtx: [async ({}, use) => {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
    } catch (e) {
      throw new Error(
        `Could not connect to Chromium at ${CDP_URL}. A pre-provisioned ` +
        `authenticated Chromium with the extension loaded must be running at ` +
        `that CDP port. Underlying error: ${e.message}`
      );
    }
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('CDP browser has no contexts');

    let sw = ctx.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => null);

    let fmPage = ctx.pages().find((p) => p.url().startsWith(FM));
    let atLogin = false;
    if (fmPage) atLogin = (await fmPage.locator('input[type="password"]').count()) > 0;

    await use({ ctx, sw, browser, atLogin });
    await browser.close();
  }, { scope: 'worker' }]
});

test.setTimeout(180_000);

async function apiKeyConfigured(sw) {
  if (!sw) return false;
  return await sw.evaluate(async () => {
    const d = await chrome.storage.local.get('panopta.apiKey');
    return Boolean(d?.['panopta.apiKey']);
  });
}

// Fetch the template slice LIVE inside the SW: v2 templates + v2 group names +
// session-auth monitoring-config per template (bounded). Returns the same
// { server_templates, server_group_details, template_monitoring_configs } shape
// analyzeTemplates() consumes - built from the real wire, not a fixture.
async function fetchLiveTemplateSlice(sw, { maxTemplates, fmOrigin }) {
  return await sw.evaluate(async ({ maxTemplates, fmOrigin }) => {
    const v2 = 'https://api2.panopta.com/v2';
    const d = await chrome.storage.local.get('panopta.apiKey');
    const key = d?.['panopta.apiKey'];
    if (!key) return null;
    const headers = { Authorization: `ApiKey ${key}` };

    async function pageAll(pathName, listKey) {
      let out = [];
      let offset = 0;
      for (let i = 0; i < 100; i++) {
        const r = await fetch(`${v2}/${pathName}?limit=100&offset=${offset}`, { headers });
        if (!r.ok) break;
        const b = await r.json();
        const list = b[listKey] || [];
        out = out.concat(list);
        if (list.length < 100) break;
        offset += 100;
      }
      return out;
    }
    const trailingId = (u) => {
      if (typeof u !== 'string') return null;
      const parts = u.replace(/\/+$/, '').split('/');
      for (let i = parts.length - 1; i >= 0; i--) if (/^\d+$/.test(parts[i])) return parts[i];
      return null;
    };

    const rawTemplates = await pageAll('server_template', 'server_template_list');
    const rawGroups = await pageAll('server_group', 'server_group_list');

    const server_group_details = {};
    for (const g of rawGroups) {
      const gid = (g?.id != null && g.id !== '') ? String(g.id) : trailingId(g?.url);
      if (gid) server_group_details[gid] = { name: g?.name ?? '' };
    }

    const server_templates = rawTemplates.map((t) => ({
      id: (t?.id != null && t.id !== '') ? String(t.id) : trailingId(t?.url),
      name: t?.name ?? '',
      server_group: t?.server_group ?? null,
      tags: Array.isArray(t?.tags) ? t.tags : [],
      template_type: t?.template_type ?? ''
    })).filter((t) => t.id);

    // session-auth monitoring-config per template (bounded). SW fetch attaches
    // FortiMonitor session cookies via host_permissions. On auth failure the
    // endpoint returns SPA-shell HTML, so we detect via JSON parse, not status.
    const template_monitoring_configs = {};
    const subset = server_templates.slice(0, maxTemplates);
    for (const t of subset) {
      try {
        const r = await fetch(`${fmOrigin}/report/get_monitoring_config_data?server_id=${encodeURIComponent(t.id)}`,
          { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        const text = await r.text();
        let body;
        try { body = JSON.parse(text); } catch { continue; }   // SPA shell -> skip
        const added = body?.categories?.added;
        if (!Array.isArray(added)) continue;
        let total_metrics = 0, alerts_count = 0;
        const metric_names = [], metrics_without_alerts = [];
        for (const cat of added) {
          for (const m of (Array.isArray(cat?.metrics) ? cat.metrics : [])) {
            total_metrics += 1;
            const nm = typeof m?.name === 'string' ? m.name : '';
            if (nm) metric_names.push(nm);
            if (Array.isArray(m?.alert_items) && m.alert_items.length > 0) alerts_count += 1;
            else if (nm) metrics_without_alerts.push(nm);
          }
        }
        template_monitoring_configs[t.id] = { total_metrics, alerts_count, metric_names, metrics_without_alerts };
      } catch { /* skip this template */ }
    }

    return { server_templates, server_group_details, template_monitoring_configs };
  }, { maxTemplates, fmOrigin });
}

test.describe('live - FMN-298 template anonymize + audit', () => {
  test('live - export produces an anonymized pack that re-audits to the same findings', async ({ liveCtx }) => {
    const { ctx, sw, atLogin } = liveCtx;

    test.skip(!sw, 'No extension service worker connected at the provisioned CDP port.');
    test.skip(atLogin, 'FortiMonitor session is at a login screen; cannot fetch templates.');
    test.skip(!(await apiKeyConfigured(sw)), 'No v2 API key seeded (panopta.apiKey).');

    const slice = await fetchLiveTemplateSlice(sw, { maxTemplates: MAX_TEMPLATES, fmOrigin: FM });
    test.skip(!slice, 'Live template fetch returned null (no API key in SW).');
    test.skip(slice.server_templates.length === 0, 'Tenant has zero templates; nothing to audit.');
    test.skip(Object.keys(slice.template_monitoring_configs).length === 0,
      'session-auth monitoring-config returned nothing (frontend crawl unavailable); the audit has no input.');

    const extensionId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

    await page.goto(`chrome-extension://${extensionId}/src/ui/tenant-observations/app.html`,
      { waitUntil: 'domcontentloaded' });

    // ---- (a) render the REAL viewer from the live slice; open Template tab ---
    const liveAudit = await page.evaluate(async ({ hostId, slice }) => {
      const host = document.createElement('div');
      host.id = hostId;
      document.body.appendChild(host);
      const [{ renderViewer }, { analyzeTemplates }] = await Promise.all([
        import('./viewer.js'),
        import('/src/lib/observation-analyzers/template.js')
      ]);
      const analysis = { templates: analyzeTemplates(slice) };
      renderViewer({
        root: host,
        store: {
          customerName: 'FMN-298 live',
          runResult: {
            inventory: slice,
            analysis,
            sections: ['template-recommendations'],
            tenant_origin: null
          }
        }
      });
      // Ground-truth finding counts from the live audit, for (c).
      const t = analysis.templates || {};
      return {
        default_only: (t.default_only_templates || []).length,
        cleanup: (t.cleanup_candidates || []).length,
        overlapping: (t.overlapping_templates || []).length,
        default_overview: (t.default_templates || []).length
      };
    }, { hostId: HOST_ID, slice });

    const tabBtn = page.locator(`#${HOST_ID} button[data-tab="template-recommendations"]`);
    await expect(tabBtn, 'the Template Analysis tab must render').toBeVisible({ timeout: 10_000 });

    const exportBtn = page.locator(`#${HOST_ID} button[data-test="export-anon-templates"]`);
    // Export button belongs to the Template tab only: hidden until we open it.
    await expect(exportBtn).toBeHidden();
    await tabBtn.click();
    await expect(exportBtn, 'Export button must show on the Template Analysis tab').toBeVisible();

    // ---- (b) click Export, capture the download, assert anonymization -------
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      exportBtn.click()
    ]);
    const tmpPack = path.join(os.tmpdir(), `fmn298-pack-${Date.now()}.json`);
    await download.saveAs(tmpPack);
    const packText = fs.readFileSync(tmpPack, 'utf8');
    const envelope = JSON.parse(packText);
    expect(envelope.format).toBe('fmn-template-pack');
    const packInv = envelope.pack.inventory;

    // Structural anonymization: names tokenized, tags gone.
    for (const t of packInv.server_templates) {
      expect(t.name, `template name must be tokenized, got "${t.name}"`).toMatch(/^Template \d+$/);
      expect('tags' in t, 'templates must carry no tags').toBe(false);
      expect('applied_servers' in t, 'templates must carry no applied_servers').toBe(false);
    }
    for (const gid of Object.keys(packInv.server_group_details)) {
      const nm = packInv.server_group_details[gid].name;
      expect(nm === STOCK_GROUP || /^Group \d+$/.test(nm),
        `group name must be tokenized or the stock literal, got "${nm}"`).toBe(true);
    }
    // Metric names are opaque tokens - the free-text PII channel is closed.
    for (const cfg of Object.values(packInv.template_monitoring_configs)) {
      for (const nm of [...(cfg.metric_names || []), ...(cfg.metrics_without_alerts || [])]) {
        expect(nm, `metric name must be an "m{n}" token, got "${nm}"`).toMatch(/^m\d+$/);
      }
    }

    // No real TAG string and no real NON-stock GROUP name leaks into the pack.
    const stockGids = new Set(Object.entries(slice.server_group_details)
      .filter(([, g]) => (g.name || '').trim().toLowerCase() === STOCK_GROUP.toLowerCase())
      .map(([gid]) => gid));
    const forbidden = new Set();
    for (const t of slice.server_templates) for (const tag of t.tags) if (tag) forbidden.add(String(tag));
    for (const [gid, g] of Object.entries(slice.server_group_details)) {
      if (!stockGids.has(gid) && g.name) forbidden.add(String(g.name));
    }
    for (const needle of forbidden) {
      expect(packText.includes(needle), `pack leaked client string "${needle}"`).toBe(false);
    }

    // Counts preserved: multiset of (total_metrics, alerts_count) is unchanged.
    const pairsOf = (cfgs) => Object.values(cfgs)
      .map((c) => `${c.total_metrics}:${c.alerts_count}`).sort();
    expect(pairsOf(packInv.template_monitoring_configs))
      .toEqual(pairsOf(slice.template_monitoring_configs));

    // Stock exemption survives: if the live tenant references a stock group,
    // the pack must still carry that exact group name somewhere.
    const liveHasStock = slice.server_templates.some((t) => {
      const gid = String(t.server_group || '').replace(/\/+$/, '').split('/').filter(Boolean).pop();
      return stockGids.has(gid);
    });
    if (liveHasStock) {
      expect(Object.values(packInv.server_group_details).some((g) => g.name === STOCK_GROUP),
        'stock group name must be preserved so the analyzer exemption survives').toBe(true);
    }

    // ---- (c) audit-from-file: load the pack through the REAL Start input ----
    await page.goto(`chrome-extension://${extensionId}/src/ui/tenant-observations/app.html#/start`,
      { waitUntil: 'domcontentloaded' });
    const fileInput = page.locator('input[data-test="load-template-pack"]');
    await expect(fileInput, 'the load-template-pack input must render on Start').toBeVisible({ timeout: 10_000 });
    await fileInput.setInputFiles(tmpPack);

    // Lands on the review viewer, narrowed to a single Template Analysis tab.
    const reloadedTab = page.locator('button[data-tab="template-recommendations"]');
    await expect(reloadedTab, 'audit-from-file must render the Template Analysis tab').toBeVisible({ timeout: 10_000 });
    const visibleTabCount = await page.locator('.observations-viewer-host button[data-tab]').count();
    expect(visibleTabCount, 'a loaded pack renders exactly one (Template Analysis) tab').toBe(1);

    // Prove the tab actually PAINTED its section tables (not a blank pane) -
    // the audit-from-file DOM renders, not just the loader landing.
    const paneSections = await page.locator('.observations-viewer-host .tab-pane .review-section').count();
    expect(paneSections, 'the Template Analysis tab must render its section tables').toBeGreaterThan(0);

    // Finding-row counts match the live audit (anonymization preserved them).
    const reloaded = await page.evaluate(async ({ packInv }) => {
      const { analyzeTemplates } = await import('/src/lib/observation-analyzers/template.js');
      const t = analyzeTemplates(packInv) || {};
      return {
        default_only: (t.default_only_templates || []).length,
        cleanup: (t.cleanup_candidates || []).length,
        overlapping: (t.overlapping_templates || []).length,
        default_overview: (t.default_templates || []).length
      };
    }, { packInv });
    expect(reloaded).toEqual(liveAudit);

    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    fs.rmSync(tmpPack, { force: true });
    await page.close();
  });
});
