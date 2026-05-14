// FMN-191 step 1.5: drive a Canned Report creation + run end-to-end on
// the authenticated tenant. Picks the smallest / quickest report type,
// fills minimal config, submits, then drives Generate.
//
// The interceptor (fmn-191-install-interceptor.mjs) must already be
// installed; this script does NOT reinstall to keep the buffer.
import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const tenant = ctx.pages().find((p) => /fortimonitor/i.test(p.url()));
if (!tenant) { console.error('No FortiMonitor tab.'); process.exit(1); }

// Make sure the interceptor is alive on this tab.
const interceptorAlive = await tenant.evaluate(() => Boolean(window.__fmn191Installed));
if (!interceptorAlive) {
  console.log('Interceptor not present (page may have navigated). Reinstall + retry.');
  process.exit(1);
}

console.log('Navigating to /report/ListReports...');
await tenant.goto('https://fortimonitor.forticloud.com/report/ListReports', { waitUntil: 'domcontentloaded' });
await tenant.waitForTimeout(4000);

// Find a Create link. Prefer report_type_id=1 (often "Uptime Summary"
// or similar - typically fast) but fall back to the first one available.
const createTarget = await tenant.evaluate(() => {
  const anchors = Array.from(document.querySelectorAll('a'));
  const creates = anchors
    .map((a) => ({ text: (a.textContent || '').trim(), href: a.getAttribute('href') || '' }))
    .filter((x) => /CreateCannedReport\?report_type_id=/.test(x.href));
  // Try id=1 first.
  const byId = (id) => creates.find((c) => c.href.includes(`report_type_id=${id}&`));
  const pref = byId(1) || byId(2) || byId(3) || creates[0];
  if (!pref) return null;
  return { href: pref.href, text: pref.text };
});
console.log('Chose Create target:', JSON.stringify(createTarget));
if (!createTarget) { console.error('No Create link found.'); process.exit(1); }

const createUrl = new URL(createTarget.href, 'https://fortimonitor.forticloud.com/report/').toString();
console.log('Navigating to', createUrl);
await tenant.goto(createUrl, { waitUntil: 'domcontentloaded' });
await tenant.waitForTimeout(4000);

// Inspect the form. We need to see what fields are required.
const formInfo = await tenant.evaluate(() => {
  const forms = document.querySelectorAll('form');
  const out = [];
  for (const form of forms) {
    const fields = [];
    for (const el of form.querySelectorAll('input, select, textarea')) {
      fields.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        required: el.required || false,
        value: (el.value || '').toString().slice(0, 40),
      });
    }
    out.push({
      action: form.action || '',
      method: form.method || '',
      fields: fields.slice(0, 30),
    });
  }
  // Also dump h1/h2 + submit-like buttons so we can see the surface.
  const surface = {
    title: document.title,
    h1s: Array.from(document.querySelectorAll('h1, h2')).map((el) => el.textContent.trim()).filter(Boolean).slice(0, 6),
    submits: Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn'))
      .map((el) => ({ tag: el.tagName.toLowerCase(), text: (el.textContent || el.value || '').trim().slice(0, 40), type: el.type || '' }))
      .filter((x) => x.text && /submit|run|generate|save|create|build|render/i.test(x.text))
      .slice(0, 10),
  };
  return { forms: out, surface };
});
console.log(JSON.stringify(formInfo, null, 2));
await b.close();
