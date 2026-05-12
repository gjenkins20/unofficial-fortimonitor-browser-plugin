#!/usr/bin/env node
// FMN-166 deep-dive 2: shape of an actual icmp.* agent_resource on a real server,
// shape of the icmp network_service_type's options, threshold / report-data feasibility.

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const OUT_PATH = path.resolve(REPO_ROOT, 'tests/e2e/__artifacts__/fmn-166-voip-survey-5.json');

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
        out.errors.push(`${base}${pathQs}: ${r.status} ${ct}`);
      } catch (e) {
        out.errors.push(`${base}${pathQs}: ${e.message}`);
      }
    }
    return { error: pathQs };
  }

  // network_service_type with icmp.jitter
  const nstResp = await v2Fetch(`/network_service_type?limit=200`);
  if (!nstResp.error) {
    const list = nstResp.body?.network_service_type_list || [];
    out.network_service_types_with_options = list
      .filter(it => /jitter|mos|icmp\.latency|icmp\.packet/i.test(it.textkey || it.name || ''))
      .map(it => ({ ...it }));
    // Also the canonical "ping" entry
    const ping = list.find(it => it.textkey === 'icmp.ping');
    if (ping) out.network_service_type_ping = ping;
  }

  // Pick the first server with network quality, dump one agent_resource fully + threshold
  out.network_quality_servers = [];
  {
    let off = 0; const lim = 100;
    for (let p = 0; p < 2 && out.network_quality_servers.length < 3; p++) {
      const r = await v2Fetch(`/server?limit=${lim}&offset=${off}`);
      if (r.error) break;
      const list = r.body?.server_list || [];
      for (const s of list) {
        const sid = (s.url || '').match(/\/server\/(\d+)/)?.[1];
        if (!sid) continue;
        const ar = await v2Fetch(`/server/${sid}/agent_resource?limit=200`);
        if (ar.error) continue;
        const arl = ar.body?.agent_resource_list || [];
        const nqResources = arl.filter(a => {
          const b = JSON.stringify(a).toLowerCase();
          return b.includes('icmp.jitter') || b.includes('icmp.mos') || b.includes('icmp.latency') || b.includes('icmp.packet_loss');
        });
        if (nqResources.length > 0) {
          out.network_quality_servers.push({
            id: sid,
            name: s.name,
            fqdn: s.fqdn,
            nq_resource_count: nqResources.length,
            sample_resource: nqResources[0]
          });
          if (out.network_quality_servers.length >= 3) break;
        }
      }
      if (list.length < lim) break;
      off += lim;
    }
  }

  // Get network_service entries on first network-quality server
  if (out.network_quality_servers.length > 0) {
    const sid = out.network_quality_servers[0].id;
    const ns = await v2Fetch(`/server/${sid}/network_service?limit=50`);
    if (!ns.error) out.network_services_on_nq_server = ns.body?.network_service_list || [];
  }

  return out;
});

// Hit session-auth /report/get_monitoring_config_data?server_id={id} for the first NQ server
const pages = ctx.pages();
const fm = pages.find(p => p.url().includes('fortimonitor.forticloud.com'));
if (fm && result.network_quality_servers?.length > 0) {
  const sid = result.network_quality_servers[0].id;
  const cfg = await fm.evaluate(async (sid) => {
    try {
      const origin = location.origin;
      const r = await fetch(`${origin}/report/get_monitoring_config_data?server_id=${sid}`, { credentials: 'include' });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) return { error: `non-json: ${ct} status ${r.status}` };
      const body = await r.json();
      const cats = body?.categories?.added || [];
      const nqCat = cats.find(c => c.name === 'Network Quality' || (c.textkey || '').includes('icmp') || (c.textkey || '').includes('network_quality'));
      return {
        success: body?.success,
        category_count: cats.length,
        category_names: cats.map(c => c.name),
        network_quality_category: nqCat ? {
          name: nqCat.name,
          textkey: nqCat.textkey,
          metric_count: (nqCat.metrics || []).length,
          metrics_sample: (nqCat.metrics || []).slice(0, 4).map(m => ({
            id: m.id,
            name: m.name,
            textkey: m.textkey,
            alert_items: m.alert_items
          }))
        } : null
      };
    } catch (e) {
      return { error: e.message };
    }
  }, sid);
  result.monitoring_config_for_nq_server = cfg;
}

fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
console.log('Wrote', OUT_PATH);
console.log('\n=== network_service_type matches (icmp.jitter/mos/latency/packet_loss) ===');
for (const t of (result.network_service_types_with_options || [])) {
  console.log('  ', t.textkey, '|', t.name);
  console.log('     options:', JSON.stringify(t.options));
}
console.log('\n=== icmp.ping network_service_type (for comparison) ===');
console.log(JSON.stringify(result.network_service_type_ping, null, 2));
console.log('\n=== network_quality_servers (sample 3) ===');
for (const s of result.network_quality_servers || []) {
  console.log('  ', s.id, '|', s.name, '|', s.fqdn, '|', s.nq_resource_count, 'NQ resources');
  console.log('   sample agent_resource keys:', Object.keys(s.sample_resource).sort().join(', '));
  console.log('   sample agent_resource:');
  console.log('     ', JSON.stringify(s.sample_resource, null, 2).split('\n').join('\n     '));
}
console.log('\n=== network_services on first NQ server (5) ===');
for (const ns of (result.network_services_on_nq_server || []).slice(0, 5)) {
  console.log('  ', ns.network_service_type, '|', JSON.stringify(ns.options));
}
console.log('\n=== monitoring config (session-auth) for first NQ server ===');
console.log(JSON.stringify(result.monitoring_config_for_nq_server, null, 2));
if (result.errors?.length) {
  console.log('\nerrors (sample):', result.errors.slice(0, 5));
}

await browser.close();
