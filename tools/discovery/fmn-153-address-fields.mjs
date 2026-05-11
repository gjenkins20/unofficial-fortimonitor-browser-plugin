#!/usr/bin/env node
// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-153 discovery probe.
//
// Connects to the persistent Dev Launcher (CDP :9222) and samples a cross
// -section of instances via /report/get_idp_data, extracting every field
// under pageData.instance whose VALUE looks address-bearing (IPv4/IPv6/
// hostname-shaped) or whose KEY contains "ip", "host", "addr", "fqdn",
// "dns", or "address". Also walks nonSystemAttributes + fabricSystemData
// for the same patterns.
//
// Output: prints a per-instance summary table and writes the full raw
// captures to docs/api-discovery/fmn-153-address-field-sample.json (NOT
// committed; the resulting analysis goes into server-metadata.md).
//
// Usage:
//   node tools/discovery/fmn-153-address-fields.mjs
//   node tools/discovery/fmn-153-address-fields.mjs 43859419 42024060 ...

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.resolve(REPO_ROOT, 'tests/e2e/__artifacts__');
const OUT_PATH = path.resolve(OUT_DIR, 'fmn-153-address-field-sample.json');
fs.mkdirSync(OUT_DIR, { recursive: true });
const CDP = process.env.FMN_CDP_PORT
  ? `http://localhost:${process.env.FMN_CDP_PORT}`
  : 'http://localhost:9222';
const FM = 'https://fortimonitor.forticloud.com';

const cliIds = process.argv.slice(2).filter((s) => /^\d+$/.test(s)).map((s) => Number(s));

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().startsWith(FM));
if (!page) {
  page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(`${FM}/report/ListServers`, { waitUntil: 'domcontentloaded' });
}

async function fetchJson(urlPath) {
  return await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include', cache: 'no-store',
        headers: { Accept: 'application/json' } });
      const ct = r.headers.get('content-type') || '';
      if (!/json/i.test(ct)) return { __error: `non-json content-type: ${ct}`, __status: r.status };
      return await r.json();
    } catch (e) {
      return { __error: e?.message || String(e) };
    }
  }, urlPath);
}

let serverIds = cliIds;
if (serverIds.length === 0) {
  // Pull a generous slice from the inventory list and pick a cross-section.
  // The inventory endpoint returns 9-item positional rows; index 3 is the
  // name HTML which contains the s-{id} prefix on a checkbox. We pull the
  // checkbox id by re-using the same data shape used by augment.js.
  console.log('Pulling server inventory list to choose a cross-section...');
  const inv = await fetchJson(
    `${FM}/report/server_group_inventory_data?server_group_id=null&draw=1&start=0&length=200`
  );
  if (inv && Array.isArray(inv.data)) {
    // Row format (FMN-153 capture): [
    //   "s-{id}",                     // 0: instance id (plain string)
    //   { icon, title },              // 1: type cell ("Server"/"Network Device"/"Template"/...)
    //   { extra_icon },               // 2: filler
    //   "<a ...>name</a>",            // 3: name HTML
    //   ...                           // 4-8: group, alert, tags, agent, heartbeat
    // ]
    // Pick a cross-section: Server, Network Device. Skip Template/Other.
    const byType = { Server: [], 'Network Device': [], Template: [], Other: [] };
    for (const row of inv.data) {
      const idMatch = String(row[0] || '').match(/^s-(\d+)$/);
      if (!idMatch) continue;
      const type = row[1]?.title || 'Other';
      const id = Number(idMatch[1]);
      (byType[type] || byType.Other).push(id);
    }
    // Required samples: operator's example + legacy Fortinet test devices.
    const required = [43859419, 42024060, 42024061, 42024075];
    const dedup = new Set(required);
    // Add up to 8 generic Servers (likely DEM / DNS-named instances).
    for (const id of byType.Server.slice(0, 12)) { if (dedup.size >= 18) break; dedup.add(id); }
    // Add up to 6 more Network Devices.
    for (const id of byType['Network Device'].slice(0, 8)) { if (dedup.size >= 24) break; dedup.add(id); }
    serverIds = Array.from(dedup);
    console.log(`  inventory type counts: Server=${byType.Server.length}, NetworkDevice=${byType['Network Device'].length}, Template=${byType.Template.length}, Other=${byType.Other.length}`);
  } else {
    console.log('Inventory fetch failed; falling back to known IDs.');
    serverIds = [43859419, 42024060, 42024061, 42024075];
  }
}
console.log(`Sampling ${serverIds.length} server IDs:`, serverIds.join(', '));

const IPV4_RE = /^(25[0-5]|2[0-4]\d|[01]?\d?\d)(\.(25[0-5]|2[0-4]\d|[01]?\d?\d)){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+:[0-9a-fA-F:]+$/;
const HOSTNAME_RE = /^[a-zA-Z0-9]([-a-zA-Z0-9]{0,62}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([-a-zA-Z0-9]{0,62}[a-zA-Z0-9])?)+\.?$/;
const ADDR_KEY_RE = /(?:^|_|[A-Z])(ip|addr|host|fqdn|dns|address)(?:$|_|[A-Z])/i;

function isAddressLikeValue(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  if (IPV4_RE.test(t)) return 'ipv4';
  if (IPV6_RE.test(t)) return 'ipv6';
  if (HOSTNAME_RE.test(t) && /[a-zA-Z]/.test(t) && t.includes('.')) return 'hostname';
  return null;
}

function findAddressFields(obj, prefix = '', sink = []) {
  if (obj == null) return sink;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => findAddressFields(v, `${prefix}[${i}]`, sink));
    return sink;
  }
  if (typeof obj !== 'object') return sink;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    const keyHint = ADDR_KEY_RE.test(k);
    if (typeof v === 'string') {
      const cat = isAddressLikeValue(v);
      if (cat || keyHint) {
        sink.push({ path: p, key: k, value: v.length > 200 ? v.slice(0, 200) + '...' : v, valueCategory: cat, keyHint });
      }
    } else if (typeof v === 'object' && v !== null) {
      findAddressFields(v, p, sink);
    }
  }
  return sink;
}

const captures = [];
let okCount = 0;
for (const id of serverIds) {
  const data = await fetchJson(`${FM}/report/get_idp_data?server_id=${id}`);
  if (data.__error) {
    captures.push({ id, error: data.__error, status: data.__status });
    console.log(`  ${id}: ERROR ${data.__error}`);
    continue;
  }
  const instance = data?.pageData?.instance;
  if (!instance) {
    captures.push({ id, error: 'no pageData.instance' });
    console.log(`  ${id}: no pageData.instance`);
    continue;
  }
  const addressFields = findAddressFields(instance, '');
  const fab = data?.pageData?.fabricSystemData;
  const fabFields = fab ? findAddressFields(fab, 'pageData.fabricSystemData') : [];
  captures.push({
    id,
    name: instance.name,
    deviceType: instance.deviceType,
    deviceSubType: instance.deviceSubType,
    fqdn: instance.fqdn,
    formattedName: instance.formattedName,
    addressFields,
    fabFields,
    nonSystemAttributes: instance.nonSystemAttributes,
  });
  okCount++;
  console.log(`  ${id}: ${instance.name} (${instance.deviceSubType || instance.deviceType || '?'}) - fqdn=${JSON.stringify(instance.fqdn)} - ${addressFields.length} addr-fields, ${fabFields.length} fab-fields`);
}

fs.writeFileSync(OUT_PATH, JSON.stringify({ capturedAt: new Date().toISOString(), captures }, null, 2));
console.log(`\nWrote ${okCount}/${serverIds.length} captures to ${OUT_PATH}`);

await browser.close();
