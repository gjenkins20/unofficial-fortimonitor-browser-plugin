#!/usr/bin/env node
// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-156 discovery probe.
//
// Hits /v2/outage on the live tenant via the persistent Dev Launcher
// (CDP :9222) using the operator's existing API key. Reports:
//   - keys present on outage records
//   - distribution of severity values
//   - presence of start_time/end_time
//   - whether records carry any metric/check identifier
//
// Output: prints a summary and writes raw records to
// tests/e2e/__artifacts__/fmn-156-outage-sample.json (NOT committed).
//
// Usage:
//   node tools/discovery/fmn-156-outage-shape.mjs

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.resolve(REPO_ROOT, 'tests/e2e/__artifacts__');
const OUT_PATH = path.resolve(OUT_DIR, 'fmn-156-outage-sample.json');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CDP = process.env.FMN_CDP_PORT
  ? `http://localhost:${process.env.FMN_CDP_PORT}`
  : 'http://localhost:9222';

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];

// The service worker holds extension privileges (chrome.storage.local).
// We need it to look up the operator's API key and then issue an
// authenticated fetch against the v2 endpoint.
const swList = ctx.serviceWorkers();
if (swList.length === 0) {
  console.error('No service worker found on the CDP target. The extension must be loaded.');
  await browser.close();
  process.exit(1);
}
const sw = swList[0];

const sample = await sw.evaluate(async () => {
  let apiKey = null;
  try {
    const res = await chrome.storage.local.get('panopta.apiKey');
    apiKey = res['panopta.apiKey'] || null;
  } catch (e) { /* ignore */ }

  if (!apiKey) return { error: 'no API key configured in chrome.storage.local' };

  const tryHosts = [
    'https://api2.panopta.com/v2',
    'https://my.us02.fortimonitor.com/v2',
    'https://fortimonitor.forticloud.com/v2'
  ];
  let outagesUrl = null;
  let outagesResp = null;
  const errors = [];
  for (const base of tryHosts) {
    try {
      const headers = {
        Accept: 'application/json',
        Authorization: `ApiKey ${apiKey}`
      };
      const r = await fetch(`${base}/outage?limit=200`, { headers });
      const ct = r.headers.get('content-type') || '';
      if (r.ok && ct.includes('application/json')) {
        outagesResp = await r.json();
        outagesUrl = `${base}/outage`;
        break;
      }
      errors.push(`${base}: ${r.status} ${ct}`);
    } catch (e) {
      errors.push(`${base}: ${e.message}`);
    }
  }

  if (!outagesResp) return { error: 'could not reach /v2/outage on any candidate host', errors };

  const list = outagesResp.outage_list || outagesResp.results || outagesResp.outages || [];
  const sevDist = {};
  const fieldCounts = {};
  let hasStart = 0, hasEnd = 0, hasActive = 0, hasMetric = 0;
  for (const o of list) {
    for (const k of Object.keys(o || {})) fieldCounts[k] = (fieldCounts[k] || 0) + 1;
    const sev = String(o?.severity ?? '');
    sevDist[sev] = (sevDist[sev] || 0) + 1;
    if (o?.start_time) hasStart++;
    if (o?.end_time) hasEnd++;
    if (o?.active != null) hasActive++;
    // probe for any field that looks like a metric/check ref
    if (o?.metric || o?.check_type || o?.agent_resource || o?.network_service || o?.compound_service) hasMetric++;
  }
  return {
    url: outagesUrl,
    meta: outagesResp.meta,
    count: list.length,
    sevDist,
    fieldCounts,
    hasStart, hasEnd, hasActive, hasMetric,
    samples: list.slice(0, 3)
  };
});

fs.writeFileSync(OUT_PATH, JSON.stringify(sample, null, 2));
console.log('Wrote', OUT_PATH);
console.log('Summary:');
console.log('  URL          :', sample.url);
console.log('  Records      :', sample.count);
console.log('  Severity dist:', sample.sevDist);
console.log('  hasStart     :', sample.hasStart);
console.log('  hasEnd       :', sample.hasEnd);
console.log('  hasActive    :', sample.hasActive);
console.log('  hasMetric    :', sample.hasMetric);
console.log('  Field counts :', sample.fieldCounts);
if (sample.samples && sample.samples.length > 0) {
  console.log('Keys on first record:', Object.keys(sample.samples[0]).sort());
}
if (sample.error) console.error('Error:', sample.error);

await browser.close();
