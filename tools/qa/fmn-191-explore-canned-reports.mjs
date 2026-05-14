// FMN-191 discovery probe: inventory the Canned Reports page + any
// adjacent surfaces that might list / generate reports. Observe-only.
import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const tenant = ctx.pages().find((p) => /fortimonitor/i.test(p.url()));
if (!tenant) { console.error('No FortiMonitor tab. Open one first.'); process.exit(1); }
console.log('Current URL:', tenant.url());

async function inventoryAt(url) {
  await tenant.goto(url, { waitUntil: 'domcontentloaded' });
  // Give the Vue SPA time to hydrate.
  await tenant.waitForTimeout(4000);
  return tenant.evaluate(() => {
    const safeText = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const out = {
      url: location.href,
      title: document.title,
      h1s: Array.from(document.querySelectorAll('h1, h2')).map(safeText).filter(Boolean).slice(0, 20),
      tableCount: document.querySelectorAll('table').length,
      tabLinks: Array.from(document.querySelectorAll('.pa-tabs a, .pa-tabs__tab, [role="tab"], nav a')).map((el) => ({
        text: safeText(el),
        href: el.getAttribute('href') || '',
      })).filter((x) => x.text && x.text.length < 50).slice(0, 30),
      reportRowSample: [],
      relevantButtons: [],
      forms: [],
    };
    const table = document.querySelector('table');
    if (table) {
      const rows = table.querySelectorAll('tbody tr');
      for (let i = 0; i < Math.min(rows.length, 5); i++) {
        const cells = Array.from(rows[i].querySelectorAll('td')).map((td) => safeText(td).slice(0, 60));
        out.reportRowSample.push(cells);
      }
    }
    // Buttons / links whose text suggests run / generate / new / configure.
    const wanted = /run|generate|new|add|create|configure|build|render|export|schedule/i;
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      const txt = safeText(el);
      if (!wanted.test(txt)) continue;
      out.relevantButtons.push({
        tag: el.tagName.toLowerCase(),
        text: txt.slice(0, 60),
        href: el.getAttribute('href') || '',
      });
      if (out.relevantButtons.length >= 20) break;
    }
    for (const form of document.querySelectorAll('form')) {
      out.forms.push({ action: form.action || '', method: form.method || '' });
    }
    return out;
  });
}

const surfaces = [
  'https://fortimonitor.forticloud.com/report/ListReports',
  'https://fortimonitor.forticloud.com/report/ListReports#reports',
  'https://fortimonitor.forticloud.com/report/ReportTemplates',
];
for (const url of surfaces) {
  console.log('\n=========================');
  console.log('Probing:', url);
  try {
    const r = await inventoryAt(url);
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.log('  error:', e.message);
  }
}
await b.close();
