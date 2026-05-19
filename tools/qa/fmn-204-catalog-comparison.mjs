// FMN-204 step 3: hit ManageCategoryVue2 for category_textkey=fortinet.fortigate
// against the source device, the populated cloned template, and the empty
// template. Compare which sub_categories expose metric_types per scope.
//
// The hypothesis from steps 1-2: the 8 "metric_types: []" sub-categories are
// auto-populated by underlying device state, not added via the dialog. If the
// device-side catalog ALSO returns metric_types: [] for those 8, the hypothesis
// holds and the FMN-193 implementation must clone-with-metrics rather than rely
// on editAgentMetric for those categories.

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const OUT_DIR = resolve(REPO, 'docs', 'api-discovery', 'captures');

const TARGETS = [
  { label: 'source-device',      id: '42024075' },
  { label: 'populated-template', id: '44017228' },
  { label: 'empty-template',     id: '44017104' }
];

const CATEGORY_TEXTKEY = 'fortinet.fortigate';

const HIDDEN_TEXTKEYS = new Set([
  'fortinet.fortigate.antivirus.stats',
  'fortinet.fortigate.firewall.bytes',
  'fortinet.fortigate.firewall.hit_count',
  'fortinet.fortigate.firewall.packets',
  'fortinet.fortigate.sdwan',
  'fortinet.fortigate.interface.dhcpv4_clients',
  'fortinet.fortigate.interface.dhcpv6_clients',
  'fortinet.fortigate.vpnssl_sessions'
]);

const browser = await chromium.connectOverCDP('http://localhost:9222').catch((err) => {
  console.error('Failed to connect to Chromium on :9222.', err.message);
  process.exit(1);
});

let page = null;
for (const ctx of browser.contexts()) {
  for (const p of ctx.pages()) {
    if (p.url().includes('fortimonitor.forticloud.com')) { page = p; break; }
  }
  if (page) break;
}
if (!page) {
  console.error('No FortiMonitor tab attached. Open https://fortimonitor.forticloud.com/ in the :9222 Chromium first.');
  process.exit(1);
}
console.log('Attached to:', page.url());

const results = {};

for (const target of TARGETS) {
  const result = await page.evaluate(async ({ id, textkey }) => {
    const url = `${location.origin}/report/ManageCategoryVue2?server_id=${id}&category_textkey=${encodeURIComponent(textkey)}`;
    const r = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    });
    const text = await r.text();
    return { status: r.status, contentType: r.headers.get('content-type') || '', body: text };
  }, { id: target.id, textkey: CATEGORY_TEXTKEY });

  const fname = `fmn-204-managecategoryvue2-${target.label}-${target.id}.json`;
  const out = resolve(OUT_DIR, fname);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, result.body || '', 'utf8');

  let parsed = null;
  try { parsed = JSON.parse(result.body); } catch {}

  const subCats = Array.isArray(parsed?.sub_categories) ? parsed.sub_categories : [];
  const hiddenWithTypes = subCats
    .filter((sc) => HIDDEN_TEXTKEYS.has(sc.textkey))
    .map((sc) => ({
      textkey: sc.textkey,
      name: sc.name,
      metric_types_count: (sc.metric_types || []).length,
      metric_type_textkeys: (sc.metric_types || []).map((m) => m.textkey).filter(Boolean)
    }));

  results[target.label] = {
    id: target.id,
    http: result.status,
    contentType: result.contentType,
    bytes: result.body.length,
    sub_categories_total: subCats.length,
    hidden_8_findings: hiddenWithTypes
  };

  console.log(`${target.label} (${target.id}): HTTP ${result.status}, ${subCats.length} sub_categories, ${result.body.length} bytes -> ${fname}`);
}

console.log('\n=== Hidden-8 metric_types per target ===');
for (const t of TARGETS) {
  console.log(`\n[${t.label} ${t.id}]`);
  for (const f of results[t.label].hidden_8_findings) {
    const tail = f.metric_types_count > 0 ? `  add_urls: ${JSON.stringify(f.metric_type_textkeys)}` : '';
    console.log(`  ${f.metric_types_count}\t${f.textkey}\t${f.name}${tail}`);
  }
}

const summaryPath = resolve(OUT_DIR, 'fmn-204-catalog-comparison-summary.json');
await writeFile(summaryPath, JSON.stringify(results, null, 2), 'utf8');
console.log(`\nSummary -> ${summaryPath}`);

await browser.close().catch(() => {});
