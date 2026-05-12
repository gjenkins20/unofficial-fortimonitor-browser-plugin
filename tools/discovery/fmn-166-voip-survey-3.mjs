#!/usr/bin/env node
// FMN-166 follow-up #2: agent_resource_type has fields {category, label, platform, plugin_textkey, resource_textkey, unit, url}.
// Re-run survey against the correct fields.

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const OUT_PATH = path.resolve(REPO_ROOT, 'tests/e2e/__artifacts__/fmn-166-voip-survey-3.json');

const VOIP_TERMS = [
  'voip', 'sip', 'rtp', 'rtcp', 'jitter', 'mos', 'codec',
  'mean_opinion', 'call_quality',
  'g711', 'g729', 'opus', 'silk',
  'phone', 'voice', 'pbx', 'fxs', 'fxo', 'sccp', 'h323'
];
const LATENCY_TERMS = ['latency', 'ping', 'icmp', 'packet_loss', 'packetloss'];

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const sw = ctx.serviceWorkers()[0];

const result = await sw.evaluate(async (terms) => {
  const { VOIP_TERMS, LATENCY_TERMS } = terms;
  const out = {
    agent_resource_type_total: null,
    voip_matches: [],
    latency_matches: [],
    plugins_seen: [],
    categories_seen: [],
    errors: []
  };
  const { 'panopta.apiKey': apiKey } = await chrome.storage.local.get('panopta.apiKey');
  const apiHosts = [
    'https://api2.panopta.com/v2',
    'https://my.us02.fortimonitor.com/v2',
    'https://fortimonitor.forticloud.com/v2'
  ];
  async function v2Fetch(pathQs) {
    for (const base of apiHosts) {
      try {
        const r = await fetch(`${base}${pathQs}`, {
          headers: { Accept: 'application/json', Authorization: `ApiKey ${apiKey}` }
        });
        const ct = r.headers.get('content-type') || '';
        if (r.ok && ct.includes('application/json')) return { base, body: await r.json() };
      } catch (e) {}
    }
    return { error: pathQs };
  }
  let offset = 0; const limit = 200;
  let total = null; let first = true;
  const plugins = new Set();
  const cats = new Set();
  for (let p = 0; p < 30; p++) {
    const r = await v2Fetch(`/agent_resource_type?limit=${limit}&offset=${offset}`);
    if (r.error) { out.errors.push(r.error); break; }
    if (first) total = r.body?.meta?.total_count ?? null;
    const list = r.body?.agent_resource_type_list || [];
    for (const it of list) {
      plugins.add(it.plugin_textkey || '');
      cats.add(it.category || '');
      const blob = [it.label, it.resource_textkey, it.plugin_textkey, it.category, it.platform].filter(Boolean).join(' ').toLowerCase();
      if (VOIP_TERMS.some(t => blob.includes(t))) out.voip_matches.push(it);
      else if (LATENCY_TERMS.some(t => blob.includes(t))) out.latency_matches.push(it);
    }
    if (list.length < limit) break;
    offset += limit;
    first = false;
  }
  out.agent_resource_type_total = total;
  out.plugins_seen = [...plugins].sort();
  out.categories_seen = [...cats].sort();
  return out;
}, { VOIP_TERMS, LATENCY_TERMS });

fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
console.log('Wrote', OUT_PATH);
console.log('agent_resource_type_total       :', result.agent_resource_type_total);
console.log('voip_matches                    :', result.voip_matches.length);
for (const m of result.voip_matches.slice(0, 50)) {
  console.log(' ', m.resource_textkey, '|', m.label, '|', m.plugin_textkey, '|', m.category, '|', m.platform, '|', m.unit);
}
console.log('latency/ping/icmp matches       :', result.latency_matches.length);
for (const m of result.latency_matches.slice(0, 50)) {
  console.log(' ', m.resource_textkey, '|', m.label, '|', m.plugin_textkey, '|', m.category, '|', m.platform, '|', m.unit);
}
console.log('plugins_seen total              :', result.plugins_seen.length);
console.log('plugins matching voip-ish       :', result.plugins_seen.filter(p => /voip|sip|rtp|jitter|phone|voice|call|pbx/i.test(p)));
console.log('categories matching voip-ish    :', result.categories_seen.filter(c => /voip|sip|rtp|jitter|phone|voice|call|pbx/i.test(c)));
console.log('plugins matching fortinet       :', result.plugins_seen.filter(p => /forti/i.test(p)));
if (result.errors.length) console.log('errors:', result.errors);

await browser.close();
