#!/usr/bin/env node
// FMN-166 final probe: are /report/voip etc real pages or SPA-shell?
// Also scan /report/ListReports body parse for the actual report card titles.

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const OUT_PATH = path.resolve(REPO_ROOT, 'tests/e2e/__artifacts__/fmn-166-voip-survey-7.json');

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];

const result = { errors: [] };
const pages = ctx.pages();
const fm = pages.find(p => p.url().includes('fortimonitor.forticloud.com'));
if (!fm) {
  console.error('No FortiMonitor tab open');
  await browser.close();
  process.exit(1);
}

// Compare sizes - SPA shell will be ~consistent size for any unknown route.
const sizeProbe = await fm.evaluate(async () => {
  const origin = location.origin;
  const paths = [
    '/report/voip',
    '/report/ListReports',
    '/report/totally_made_up_path_xyz',
    '/report/NetworkQuality',
    '/report/ListServers'
  ];
  const r = {};
  for (const p of paths) {
    try {
      const resp = await fetch(`${origin}${p}`, { credentials: 'include' });
      const text = await resp.text();
      // hashable summary: length, first 200, last 200, count of <pa-card>, count of "VoIP" / "voip" / "network quality"
      const summary = {
        status: resp.status,
        length: text.length,
        finalUrl: resp.url,
        paCardCount: (text.match(/<pa-card/g) || []).length,
        voipMentions: (text.match(/voip/gi) || []).length,
        nqMentions: (text.match(/network\s*quality/gi) || []).length,
        title: (text.match(/<title>([^<]*)<\/title>/) || [])[1] || null,
        hasReportSpecificMarker: /<pa-table|listreports|network-quality-report|voipreport/i.test(text)
      };
      r[p] = summary;
    } catch (e) {
      r[p] = { error: e.message };
    }
  }
  return r;
});

result.size_probe = sizeProbe;

// Now actually navigate to /report/ListReports and read the rendered card titles
// (the body is the SPA shell - cards are hydrated client-side). Use the live page.
console.log('Navigating live page to /report/ListReports for hydrated card scan...');
await fm.goto('https://fortimonitor.forticloud.com/report/ListReports', { waitUntil: 'networkidle', timeout: 60000 });
await fm.waitForTimeout(3000);

const reportCards = await fm.evaluate(() => {
  // Find every pa-card / card-title visible on the page
  const titles = [];
  document.querySelectorAll('pa-card, .pa-card, [class*="card"]').forEach(el => {
    const headers = el.querySelectorAll('h1,h2,h3,h4,h5,h6,.card-title,.title,[class*="title"]');
    headers.forEach(h => {
      const t = (h.textContent || '').trim();
      if (t && t.length < 100) titles.push(t);
    });
  });
  // dedupe
  return [...new Set(titles)];
});
result.list_reports_card_titles = reportCards;

// Search for VoIP / Network Quality strings in the hydrated DOM
const dom_voip_hits = await fm.evaluate(() => {
  const body = document.body.textContent || '';
  const result = {};
  for (const term of ['voip', 'VoIP', 'Network Quality', 'jitter', 'Jitter', 'MOS', 'SIP', 'RTP']) {
    result[term] = (body.match(new RegExp(term, 'g')) || []).length;
  }
  return result;
});
result.list_reports_dom_term_hits = dom_voip_hits;

fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
console.log('\n=== size_probe (sample of paths) ===');
for (const [path, summary] of Object.entries(result.size_probe)) {
  console.log(' ', path);
  console.log('     status=', summary.status, 'len=', summary.length, 'pa-cards=', summary.paCardCount, 'voipMentions=', summary.voipMentions, 'nqMentions=', summary.nqMentions);
  console.log('     title=', summary.title, 'hasMarker=', summary.hasReportSpecificMarker);
}
console.log('\n=== ListReports rendered card titles (' + reportCards.length + ') ===');
for (const t of reportCards) console.log('  -', t);
console.log('\n=== ListReports DOM term hits ===');
console.log(result.list_reports_dom_term_hits);

await browser.close();
