#!/usr/bin/env node
// FMN-166 deep-dive: pull full shape for Network Quality types, find servers using them,
// check OnSight + templates for Network Quality usage.

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const OUT_PATH = path.resolve(REPO_ROOT, 'tests/e2e/__artifacts__/fmn-166-voip-survey-4.json');

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const sw = ctx.serviceWorkers()[0];

const result = await sw.evaluate(async () => {
  const out = { errors: [] };
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

  // Pull the full agent_resource_type entries for the 4 icmp.* network-quality ids
  // From the previous probe, urls were on api2.panopta.com/v2/agent_resource_type/{id}.
  // Walk again, filter, then GET each by url.
  out.network_quality_types = [];
  let offset = 0; const limit = 200;
  for (let p = 0; p < 30; p++) {
    const r = await v2Fetch(`/agent_resource_type?limit=${limit}&offset=${offset}`);
    if (r.error) { out.errors.push(r.error); break; }
    const list = r.body?.agent_resource_type_list || [];
    for (const it of list) {
      if (it.category === 'Network Quality' || it.plugin_textkey === 'resource.icmp') {
        out.network_quality_types.push(it);
      }
    }
    if (list.length < limit) break;
    offset += limit;
  }

  // Fetch one full record to see all fields (the list view may be truncated)
  if (out.network_quality_types.length > 0) {
    const sample = out.network_quality_types[0];
    const urlPath = sample.url.replace(/^https?:\/\/[^/]+\/v2/, '');
    const r = await v2Fetch(urlPath);
    if (r.error) out.errors.push('detail fetch: ' + r.error);
    else out.network_quality_type_full = r.body;
  }

  // OnSight inventory full shape
  {
    const r = await v2Fetch(`/onsight?limit=10`);
    if (r.error) out.errors.push('onsight: ' + r.error);
    else {
      out.onsight_list = r.body?.onsight_list || [];
    }
  }

  // Walk servers, look for any whose agent_resources reference icmp / Network Quality
  out.servers_with_network_quality = [];
  out.servers_with_agent_ping = [];
  out.total_servers = null;
  {
    let off = 0; const lim = 100;
    for (let p = 0; p < 5; p++) {
      const r = await v2Fetch(`/server?limit=${lim}&offset=${off}`);
      if (r.error) { out.errors.push('server scan: ' + r.error); break; }
      if (out.total_servers === null) out.total_servers = r.body?.meta?.total_count ?? null;
      const list = r.body?.server_list || [];
      for (const s of list) {
        const sid = (s.url || '').match(/\/server\/(\d+)/)?.[1];
        if (!sid) continue;
        const ar = await v2Fetch(`/server/${sid}/agent_resource?limit=200`);
        if (ar.error) continue;
        const arl = ar.body?.agent_resource_list || [];
        let hasNQ = false, hasAP = false;
        for (const a of arl) {
          const t = (a.agent_resource_type || '').toLowerCase();
          // agent_resource_type is a URL; resolve numeric id and check against captured network quality ids
          // simpler: check if a.resource_textkey or a.label contains icmp/jitter/mos/packet_loss
          const blob = JSON.stringify(a).toLowerCase();
          if (blob.includes('icmp.jitter') || blob.includes('icmp.mos') || blob.includes('icmp.latency') || blob.includes('icmp.packet_loss')) hasNQ = true;
          if (blob.includes('ping_latency') || blob.includes('ping_packet_loss')) hasAP = true;
        }
        if (hasNQ) out.servers_with_network_quality.push({ id: sid, name: s.name, fqdn: s.fqdn });
        if (hasAP) out.servers_with_agent_ping.push({ id: sid, name: s.name, fqdn: s.fqdn });
      }
      if (list.length < lim) break;
      off += lim;
    }
  }

  return out;
});

fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
console.log('Wrote', OUT_PATH);
console.log('Network Quality agent_resource_type entries:', result.network_quality_types?.length || 0);
for (const t of (result.network_quality_types || [])) {
  console.log(' ', t.resource_textkey, '|', t.label, '|', t.unit, '|', t.platform, '|', t.url);
}
console.log('\nNetwork Quality type FULL detail:');
console.log(JSON.stringify(result.network_quality_type_full, null, 2));
console.log('\nOnSight count:', result.onsight_list?.length);
if (result.onsight_list?.[0]) {
  console.log('OnSight[0] keys:', Object.keys(result.onsight_list[0]).sort());
  console.log('OnSight[0]:', JSON.stringify(result.onsight_list[0], null, 2));
}
console.log('\nTotal servers:', result.total_servers);
console.log('Servers with Network Quality agent_resources:', result.servers_with_network_quality.length);
console.log('Servers with agent_ping agent_resources    :', result.servers_with_agent_ping.length);
if (result.errors?.length) {
  console.log('\nerrors:', result.errors.slice(0, 5));
}

await browser.close();
