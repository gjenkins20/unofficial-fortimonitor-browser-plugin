#!/usr/bin/env node
// FMN-166 deep-dive 3: time-series data fetch feasibility, MOS presence anywhere, OnSight VoIP plugins.

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const OUT_PATH = path.resolve(REPO_ROOT, 'tests/e2e/__artifacts__/fmn-166-voip-survey-6.json');

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

  // Walk all 64 servers, classify by NQ resource composition.
  // Capture: how many have full quartet (jitter/latency/loss/MOS)?
  out.nq_inventory = [];
  let off = 0; const lim = 100;
  for (let p = 0; p < 5; p++) {
    const r = await v2Fetch(`/server?limit=${lim}&offset=${off}`);
    if (r.error) break;
    const list = r.body?.server_list || [];
    for (const s of list) {
      const sid = (s.url || '').match(/\/server\/(\d+)/)?.[1];
      if (!sid) continue;
      const ar = await v2Fetch(`/server/${sid}/agent_resource?limit=200`);
      if (ar.error) continue;
      const arl = ar.body?.agent_resource_list || [];
      const types = new Set();
      const arIds = {};
      for (const a of arl) {
        const tk = a.resource_textkey || '';
        if (['icmp.jitter', 'icmp.mos', 'icmp.latency', 'icmp.packet_loss'].includes(tk)) {
          types.add(tk);
          arIds[tk] = (a.url || '').match(/\/agent_resource\/(\d+)/)?.[1];
        }
      }
      if (types.size > 0) {
        out.nq_inventory.push({
          id: sid,
          name: s.name,
          fqdn: s.fqdn,
          types: [...types].sort(),
          arIds
        });
      }
    }
    if (list.length < lim) break;
    off += lim;
  }

  // Try metric_data endpoint on a known NQ agent_resource. Schema-discovery hinted at
  // /v2/server/{id}/agent_resource/{rid}/metric_data
  // We'll try a handful of likely paths.
  if (out.nq_inventory.length > 0) {
    const target = out.nq_inventory[0];
    const oneArId = target.arIds['icmp.latency'] || Object.values(target.arIds)[0];
    if (oneArId) {
      out.metric_data_attempts = [];
      const probePaths = [
        `/server/${target.id}/agent_resource/${oneArId}/data`,
        `/server/${target.id}/agent_resource/${oneArId}/metric_data`,
        `/agent_resource/${oneArId}/data`,
        `/server/${target.id}/agent_resource/${oneArId}/data_point`,
        `/server/${target.id}/data?agent_resource_id=${oneArId}`
      ];
      for (const pp of probePaths) {
        const r = await v2Fetch(pp + '?limit=5');
        if (r.error) out.metric_data_attempts.push({ path: pp, ok: false });
        else out.metric_data_attempts.push({ path: pp, ok: true, sampleKeys: Object.keys(r.body || {}), bodyPreview: JSON.stringify(r.body).slice(0, 400) });
      }
    }
  }

  return out;
});

// Session-auth: try to find any VoIP / SIP signatures in the wider monitoring config catalog
// by hitting /report/get_monitoring_config_data for a template_id; and probe a few canned-report
// URLs to see if FortiMonitor has a "VoIP report" page out of the box.
const pages = ctx.pages();
const fm = pages.find(p => p.url().includes('fortimonitor.forticloud.com'));
if (fm) {
  // Probe a few known canned-report paths
  result.canned_report_probes = await fm.evaluate(async () => {
    const origin = location.origin;
    const paths = [
      '/report/voip',
      '/report/VoipReport',
      '/report/VoIPQuality',
      '/report/NetworkQuality',
      '/report/ListReports',
      '/report/VoipQualityReport',
      '/report/SipReport',
      '/report/Voip'
    ];
    const r = [];
    for (const p of paths) {
      try {
        const resp = await fetch(`${origin}${p}`, { credentials: 'include', redirect: 'follow' });
        r.push({ path: p, status: resp.status, ct: resp.headers.get('content-type'), final: resp.url });
      } catch (e) {
        r.push({ path: p, error: e.message });
      }
    }
    return r;
  });

  // Sample the get_monitoring_config_data for a Network Quality server, full payload size
  if (result.nq_inventory?.length > 0) {
    const sid = result.nq_inventory[0].id;
    result.full_monitoring_config = await fm.evaluate(async (sid) => {
      const origin = location.origin;
      const resp = await fetch(`${origin}/report/get_monitoring_config_data?server_id=${sid}`, { credentials: 'include' });
      if (!resp.headers.get('content-type')?.includes('json')) return { error: 'non-json' };
      const body = await resp.json();
      const cats = body.categories?.added || [];
      // dump the network quality category fully
      const nq = cats.find(c => c.name === 'Network Quality');
      return {
        success: body.success,
        nq_category: nq,
        all_category_textkeys: cats.map(c => ({ name: c.name, textkey: c.textkey, metric_count: (c.metrics || []).length }))
      };
    }, sid);
  }
}

fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
console.log('Wrote', OUT_PATH);
console.log('\n=== NQ inventory (full tenant scan) ===');
console.log('Servers with at least one NQ metric:', result.nq_inventory?.length || 0);
const distros = {};
for (const s of (result.nq_inventory || [])) {
  const key = s.types.join('+');
  distros[key] = (distros[key] || 0) + 1;
}
console.log('Type-set distribution:', distros);
console.log('Servers with icmp.mos:', (result.nq_inventory || []).filter(s => s.types.includes('icmp.mos')).length);

console.log('\n=== metric_data endpoint probes ===');
for (const a of (result.metric_data_attempts || [])) {
  console.log(' ', a.path, '->', a.ok ? 'OK keys=' + a.sampleKeys.join(',') : 'fail');
  if (a.ok) console.log('     preview:', a.bodyPreview);
}

console.log('\n=== canned-report URL probes (session-auth) ===');
for (const p of (result.canned_report_probes || [])) {
  console.log(' ', p.path, '->', p.status, p.ct?.split(';')[0], 'final:', p.final?.replace(/^https?:\/\/[^/]+/, ''));
}

console.log('\n=== full Network Quality category (one server) ===');
console.log(JSON.stringify(result.full_monitoring_config, null, 2).slice(0, 3000));

if (result.errors?.length) {
  console.log('\nerrors (sample):');
  for (const e of result.errors.slice(0, 10)) console.log(' ', e);
}

await browser.close();
