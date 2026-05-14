// FMN-191 discovery: drive a Canned Report create + immediate generate,
// capturing every HTTP request/response on the tenant tab via Playwright's
// CDP network events (which see form-submission POSTs in addition to
// fetch/XHR). Single-shot end-to-end.
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const tenant = ctx.pages().find((p) => /fortimonitor/i.test(p.url()));
if (!tenant) { console.error('No FortiMonitor tab.'); process.exit(1); }

const sanitize = (u) => {
  try { const p = new URL(u); return p.origin + p.pathname + (p.search ? '?<query>' : '') + p.hash; }
  catch { return String(u).replace(/\?.*$/, '?<query>'); }
};
const shouldCapture = (u) => /report|job|poll|status|task|export|render|generate|canned|incident/i.test(u);

const records = [];
tenant.on('request', (req) => {
  const url = req.url();
  if (!shouldCapture(url)) return;
  const id = req._guid || Math.random().toString(36);
  records.push({
    id, ts: Date.now(), kind: 'request',
    url: sanitize(url), method: req.method(), resourceType: req.resourceType(),
    postDataPreview: (req.postData() || '').slice(0, 300),
  });
});
tenant.on('response', async (resp) => {
  const url = resp.url();
  if (!shouldCapture(url)) return;
  let body = '';
  try { body = (await resp.text()).slice(0, 400); } catch { body = '<unreadable>'; }
  records.push({
    ts: Date.now(), kind: 'response',
    url: sanitize(url), status: resp.status(), method: resp.request().method(),
    body: body.replace(/[A-Za-z0-9_-]{40,}/g, '<long-token>'),
  });
});
tenant.on('framenavigated', (frame) => {
  if (frame === tenant.mainFrame()) {
    records.push({ ts: Date.now(), kind: 'nav', url: sanitize(frame.url()) });
  }
});

console.log('--- Navigating to Canned Reports list...');
await tenant.goto('https://fortimonitor.forticloud.com/report/ListReports', { waitUntil: 'domcontentloaded' });
await tenant.waitForTimeout(3000);

console.log('--- Opening Create form (report_type_id=1, "Incident Report")...');
await tenant.goto('https://fortimonitor.forticloud.com/report/CreateCannedReport?report_type_id=1&selected_ids=', { waitUntil: 'domcontentloaded' });
await tenant.waitForTimeout(4000);

console.log('--- Filling form (name=FMN-191 Discovery, tags=all, cadence=once, generate_immediately=true)...');
const fill = await tenant.evaluate(() => {
  const form = document.querySelector('form');
  if (!form) return { ok: false, reason: 'no form' };
  const inputs = Array.from(form.querySelectorAll('input[type="text"]'));
  const nameInput = inputs[0];
  if (nameInput) {
    nameInput.value = 'FMN-191 Discovery';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const sel = (selector) => {
    const el = form.querySelector(selector);
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); return true; }
    return false;
  };
  return {
    ok: true,
    nameSet: nameInput?.value || '',
    tagsAll: sel('input[name="tags"][value="all"]'),
    cadenceOnce: sel('input[name="cadence"][value="once"]'),
    generateNow: sel('input[name="generate_immediately"]'),
  };
});
console.log(JSON.stringify(fill));

console.log('\n--- Submitting form...');
const submit = await tenant.evaluate(() => {
  const form = document.querySelector('form');
  if (!form) return { ok: false, reason: 'no form' };
  if (typeof form.requestSubmit === 'function') form.requestSubmit();
  else form.submit();
  return { ok: true, via: 'form.submit()' };
});
console.log(JSON.stringify(submit));

console.log('\n--- Waiting up to 120s for completion...');
const deadline = Date.now() + 120_000;
let lastReportedSize = 0;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  if (records.length !== lastReportedSize) {
    console.log(`  events=${records.length}, last=${records[records.length - 1]?.url}`);
    lastReportedSize = records.length;
  }
}

console.log(`\n--- Total ${records.length} records:\n`);
for (const r of records) {
  const ts = new Date(r.ts).toISOString();
  if (r.kind === 'request') {
    console.log(`${ts} REQ  ${r.method.padEnd(6)} ${r.url}`);
    if (r.postDataPreview) console.log(`   POST body: ${r.postDataPreview.replace(/\n/g, ' ').slice(0, 200)}`);
  } else if (r.kind === 'response') {
    console.log(`${ts} RES  ${r.method.padEnd(6)} ${String(r.status).padEnd(3)} ${r.url}`);
    if (r.body) {
      const trimmed = r.body.replace(/\s+/g, ' ').slice(0, 200);
      if (trimmed) console.log(`   body: ${trimmed}`);
    }
  } else if (r.kind === 'nav') {
    console.log(`${ts} NAV  -> ${r.url}`);
  }
}
mkdirSync('docs/api-discovery/captures', { recursive: true });
const out = `docs/api-discovery/captures/fmn-191-report-flow-${Date.now()}.json`;
writeFileSync(out, JSON.stringify(records, null, 2));
console.log(`\nFull capture saved to ${out}`);
await b.close();
