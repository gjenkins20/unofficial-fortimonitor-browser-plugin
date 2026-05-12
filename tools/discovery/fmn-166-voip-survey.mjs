#!/usr/bin/env node
// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-166 discovery probe.
//
// Surveys the live FortiMonitor tenant for VoIP-related capabilities:
//   - /v2/agent_resource_type entries (paged) - match name/textkey on voip/sip/rtp/jitter/mos/codec
//   - /v2/network_service_type entries - check for SIP / VoIP service checks
//   - /v2/server_template entries - templates with voip in name
//   - /v2/onsight - sample shape for OnSight devices that might host SIP checks
//   - sample of /v2/server filtered to a small set to confirm no voip-shaped agent_resources surface inline
//   - session-auth: /report/get_monitoring_config_data for any template tagged voip
//   - session-auth: /report/ListReports HTML scan for any voip-shaped canned reports
//
// Output: writes a sample artifact to tests/e2e/__artifacts__/fmn-166-voip-survey.json
// and prints a console summary.
//
// Usage:
//   node tools/discovery/fmn-166-voip-survey.mjs

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.resolve(REPO_ROOT, 'tests/e2e/__artifacts__');
const OUT_PATH = path.resolve(OUT_DIR, 'fmn-166-voip-survey.json');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CDP = process.env.FMN_CDP_PORT
  ? `http://localhost:${process.env.FMN_CDP_PORT}`
  : 'http://localhost:9222';

const VOIP_TERMS = [
  'voip', 'sip', 'rtp', 'rtcp', 'jitter', 'mos', 'codec',
  'latency', 'packet_loss', 'mean_opinion', 'call_quality',
  'g711', 'g729', 'opus', 'silk'
];

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];

const swList = ctx.serviceWorkers();
if (swList.length === 0) {
  console.error('No service worker found on the CDP target. The extension must be loaded.');
  await browser.close();
  process.exit(1);
}
const sw = swList[0];

const result = await sw.evaluate(async (VOIP_TERMS) => {
  const out = {
    tenant_origin: null,
    api_key_present: false,
    agent_resource_type: { total: null, matches: [], sampleKeys: [] },
    network_service_type: { total: null, matches: [], sampleKeys: [] },
    server_template_matches: [],
    onsight_total: null,
    voip_servers: [],
    monitoring_config_samples: [],
    list_reports_voip_hits: null,
    errors: []
  };

  let apiKey = null;
  try {
    const res = await chrome.storage.local.get('panopta.apiKey');
    apiKey = res['panopta.apiKey'] || null;
    out.api_key_present = !!apiKey;
  } catch (e) { /* ignore */ }
  if (!apiKey) {
    out.errors.push('no API key configured in chrome.storage.local');
    return out;
  }

  const apiHosts = [
    'https://api2.panopta.com/v2',
    'https://my.us02.fortimonitor.com/v2',
    'https://fortimonitor.forticloud.com/v2'
  ];

  async function v2Fetch(pathQs) {
    let lastErr = null;
    for (const base of apiHosts) {
      try {
        const r = await fetch(`${base}${pathQs}`, {
          headers: {
            Accept: 'application/json',
            Authorization: `ApiKey ${apiKey}`
          }
        });
        const ct = r.headers.get('content-type') || '';
        if (r.ok && ct.includes('application/json')) {
          return { base, body: await r.json() };
        }
        lastErr = `${base}${pathQs}: ${r.status} ${ct}`;
      } catch (e) {
        lastErr = `${base}${pathQs}: ${e.message}`;
      }
    }
    return { error: lastErr };
  }

  function matchTerms(str) {
    if (!str) return false;
    const s = String(str).toLowerCase();
    return VOIP_TERMS.some(t => s.includes(t));
  }

  // ----- /v2/agent_resource_type (paged) -----
  {
    const matches = [];
    let offset = 0;
    const limit = 100;
    let total = null;
    let first = true;
    let lastKeys = null;
    let pages = 0;
    while (true) {
      const r = await v2Fetch(`/agent_resource_type?limit=${limit}&offset=${offset}`);
      if (r.error) { out.errors.push(r.error); break; }
      if (first) total = r.body?.meta?.total_count ?? null;
      const list = r.body?.agent_resource_type_list || [];
      if (lastKeys === null && list[0]) lastKeys = Object.keys(list[0]).sort();
      for (const item of list) {
        const blob = [item.name, item.textkey, item.plugin_name, item.description].filter(Boolean).join(' ');
        if (matchTerms(blob)) {
          matches.push({
            name: item.name || null,
            textkey: item.textkey || null,
            plugin_name: item.plugin_name || null,
            url: item.url || null,
            description: item.description || null,
            unit: item.unit || null
          });
        }
      }
      pages++;
      if (list.length < limit) break;
      offset += limit;
      if (pages > 60) break; // safety
      first = false;
    }
    out.agent_resource_type.total = total;
    out.agent_resource_type.matches = matches;
    out.agent_resource_type.sampleKeys = lastKeys;
  }

  // ----- /v2/network_service_type (paged) -----
  {
    const matches = [];
    let offset = 0;
    const limit = 100;
    let total = null;
    let first = true;
    let lastKeys = null;
    let pages = 0;
    while (true) {
      const r = await v2Fetch(`/network_service_type?limit=${limit}&offset=${offset}`);
      if (r.error) { out.errors.push(r.error); break; }
      if (first) total = r.body?.meta?.total_count ?? null;
      const list = r.body?.network_service_type_list || [];
      if (lastKeys === null && list[0]) lastKeys = Object.keys(list[0]).sort();
      for (const item of list) {
        const blob = [item.name, item.textkey, item.description].filter(Boolean).join(' ');
        if (matchTerms(blob)) {
          matches.push({
            name: item.name || null,
            textkey: item.textkey || null,
            url: item.url || null,
            description: item.description || null
          });
        }
      }
      pages++;
      if (list.length < limit) break;
      offset += limit;
      if (pages > 60) break;
      first = false;
    }
    out.network_service_type.total = total;
    out.network_service_type.matches = matches;
    out.network_service_type.sampleKeys = lastKeys;
  }

  // ----- /v2/server_template (paged) - match on name -----
  {
    const matches = [];
    let offset = 0;
    const limit = 100;
    let pages = 0;
    while (true) {
      const r = await v2Fetch(`/server_template?limit=${limit}&offset=${offset}`);
      if (r.error) { out.errors.push(r.error); break; }
      const list = r.body?.server_template_list || [];
      for (const item of list) {
        if (matchTerms(item.name) || matchTerms(item.description)) {
          matches.push({
            name: item.name || null,
            url: item.url || null,
            template_type: item.template_type || null
          });
        }
      }
      pages++;
      if (list.length < limit) break;
      offset += limit;
      if (pages > 60) break;
    }
    out.server_template_matches = matches;
  }

  // ----- /v2/onsight - capture total + sample -----
  {
    const r = await v2Fetch(`/onsight?limit=10`);
    if (r.error) out.errors.push(r.error);
    else {
      out.onsight_total = r.body?.meta?.total_count ?? null;
      const list = r.body?.onsight_list || [];
      out.onsight_sample = list.slice(0, 2);
    }
  }

  // ----- /v2/server - sample some + count any with voip-shape -----
  {
    const r = await v2Fetch(`/server?limit=200&offset=0`);
    if (r.error) out.errors.push(r.error);
    else {
      const list = r.body?.server_list || [];
      out.server_sample_count = list.length;
      out.server_total = r.body?.meta?.total_count ?? null;
      const voipNamed = [];
      for (const s of list) {
        const blob = JSON.stringify(s).toLowerCase();
        if (VOIP_TERMS.some(t => blob.includes(t))) {
          voipNamed.push({ id: s.id, name: s.name, fqdn: s.fqdn, url: s.url });
        }
      }
      out.voip_servers = voipNamed;
    }
  }

  return out;
}, VOIP_TERMS);

// Also probe a session-auth page: /report/ListReports.
const pages = ctx.pages();
const fm = pages.find(p => p.url().includes('fortimonitor.forticloud.com'));
if (fm) {
  // tenant origin for the session-auth probes
  const origin = new URL(fm.url()).origin;
  result.tenant_origin = origin;
  // hit /report/ListReports for VoIP hits
  const listReports = await fm.evaluate(async (origin) => {
    try {
      const r = await fetch(`${origin}/report/ListReports`, { credentials: 'include' });
      if (!r.ok) return { error: `status ${r.status}` };
      const html = await r.text();
      const voipHits = [];
      // crude paragraph extraction
      const lower = html.toLowerCase();
      const terms = ['voip', 'sip', 'rtp', 'jitter', 'mos', 'codec'];
      for (const t of terms) {
        const i = lower.indexOf(t);
        if (i !== -1) {
          // grab ~80 chars of context
          voipHits.push({ term: t, context: html.substring(Math.max(0, i - 40), i + 80) });
        }
      }
      return { length: html.length, voipHits };
    } catch (e) {
      return { error: e.message };
    }
  }, origin);
  result.list_reports_voip_hits = listReports;

  // probe ListMonitoringPolicies for voip references
  const lmp = await fm.evaluate(async (origin) => {
    try {
      const r = await fetch(`${origin}/report/ListMonitoringPolicies`, { credentials: 'include' });
      if (!r.ok) return { error: `status ${r.status}` };
      const html = await r.text();
      const lower = html.toLowerCase();
      const terms = ['voip', 'sip', 'rtp', 'jitter', 'mos', 'codec'];
      const hits = {};
      for (const t of terms) hits[t] = (lower.match(new RegExp(t, 'g')) || []).length;
      return { length: html.length, hits };
    } catch (e) {
      return { error: e.message };
    }
  }, origin);
  result.list_monitoring_policies_voip_hits = lmp;
}

fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
console.log('Wrote', OUT_PATH);
console.log('--- summary ---');
console.log('tenant_origin                :', result.tenant_origin);
console.log('api_key_present              :', result.api_key_present);
console.log('agent_resource_type total    :', result.agent_resource_type.total);
console.log('agent_resource_type matches  :', result.agent_resource_type.matches.length);
for (const m of result.agent_resource_type.matches.slice(0, 20)) {
  console.log('  ', m.textkey, '|', m.name);
}
console.log('network_service_type total   :', result.network_service_type.total);
console.log('network_service_type matches :', result.network_service_type.matches.length);
for (const m of result.network_service_type.matches.slice(0, 20)) {
  console.log('  ', m.textkey, '|', m.name);
}
console.log('server_template_matches      :', result.server_template_matches.length);
for (const m of result.server_template_matches.slice(0, 10)) {
  console.log('  ', m.name);
}
console.log('voip-named servers in sample :', result.voip_servers.length);
console.log('onsight_total                :', result.onsight_total);
console.log('server_total                 :', result.server_total);
console.log('list_reports_voip_hits       :', JSON.stringify(result.list_reports_voip_hits));
console.log('list_monitoring_policies     :', JSON.stringify(result.list_monitoring_policies_voip_hits));
if (result.errors.length) {
  console.log('--- errors ---');
  for (const e of result.errors) console.log(' ', e);
}

await browser.close();
