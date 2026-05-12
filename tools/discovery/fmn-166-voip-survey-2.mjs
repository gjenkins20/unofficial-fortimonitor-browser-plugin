#!/usr/bin/env node
// Unofficial FortiMonitor Toolkit - Gregori Jenkins
// FMN-166 follow-up probe: widen term set, capture full shape for jitter / latency matches.

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const OUT_PATH = path.resolve(REPO_ROOT, 'tests/e2e/__artifacts__/fmn-166-voip-survey-2.json');

const VOIP_TERMS = [
  'voip', 'sip', 'rtp', 'rtcp', 'jitter', 'mos', 'codec',
  'latency', 'packet_loss', 'mean_opinion', 'call_quality',
  'g711', 'g729', 'opus', 'silk',
  'phone', 'voice', 'call', 'pbx', 'fxs', 'fxo', 'sccp', 'h323',
  'ping', 'icmp'
];

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const sw = ctx.serviceWorkers()[0];

const result = await sw.evaluate(async (VOIP_TERMS) => {
  const out = { agent_resource_type_matches: [], network_service_type_matches: [], errors: [] };
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
      } catch (e) { /* try next */ }
    }
    return { error: `failed: ${pathQs}` };
  }

  const matchTerms = (str) => str ? VOIP_TERMS.some(t => String(str).toLowerCase().includes(t)) : false;

  // agent_resource_type widened
  {
    let offset = 0; const limit = 200;
    const matches = [];
    let first = null;
    for (let p = 0; p < 30; p++) {
      const r = await v2Fetch(`/agent_resource_type?limit=${limit}&offset=${offset}`);
      if (r.error) { out.errors.push(r.error); break; }
      const list = r.body?.agent_resource_type_list || [];
      if (!first && list[0]) first = list[0];
      for (const it of list) {
        const blob = [it.name, it.textkey, it.plugin_name, it.description].filter(Boolean).join(' ').toLowerCase();
        if (VOIP_TERMS.some(t => blob.includes(t))) matches.push(it);
      }
      if (list.length < limit) break;
      offset += limit;
    }
    out.agent_resource_type_matches = matches;
    out.agent_resource_type_sample_entry = first;
  }

  // network_service_type full + matches (already small set)
  {
    const r = await v2Fetch(`/network_service_type?limit=200`);
    if (r.error) out.errors.push(r.error);
    else {
      const list = r.body?.network_service_type_list || [];
      out.network_service_type_all_count = list.length;
      const matches = [];
      for (const it of list) {
        const blob = [it.name, it.textkey, it.description].filter(Boolean).join(' ').toLowerCase();
        if (VOIP_TERMS.some(t => blob.includes(t))) matches.push(it);
      }
      out.network_service_type_matches = matches;
    }
  }

  return out;
}, VOIP_TERMS);

fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
console.log('Wrote', OUT_PATH);
console.log('agent_resource_type_matches:', result.agent_resource_type_matches.length);
for (const m of result.agent_resource_type_matches.slice(0, 30)) {
  console.log('  ', m.textkey, '|', m.name, '|', m.plugin_name || '-', '|', m.unit || '-');
}
console.log('network_service_type_matches:', result.network_service_type_matches.length);
for (const m of result.network_service_type_matches) {
  console.log('  ', m.textkey, '|', m.name);
  console.log('     keys:', Object.keys(m).sort().join(', '));
}
if (result.errors.length) {
  console.log('errors:', result.errors);
}

await browser.close();
