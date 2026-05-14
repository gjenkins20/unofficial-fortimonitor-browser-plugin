// FMN-191 (pivot to in-page bell): inspect the FortiMonitor top bar
// to find the searchbar element + a stable mount anchor for the bell
// indicator.
import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const tenant = ctx.pages().find((p) => /fortimonitor/i.test(p.url()));
if (!tenant) { console.error('No FortiMonitor tab.'); process.exit(1); }

// Navigate somewhere predictable.
await tenant.goto('https://fortimonitor.forticloud.com/dashboardv2/renderDashboard?dashboard_id=51268', { waitUntil: 'domcontentloaded' });
await tenant.waitForTimeout(5000);

const inspection = await tenant.evaluate(() => {
  const out = {
    searchCandidates: [],
    topbar: null,
    pathToSearch: [],
  };
  // Find search inputs.
  const inputs = Array.from(document.querySelectorAll('input'));
  for (const i of inputs) {
    const place = (i.placeholder || '').toLowerCase();
    const id = (i.id || '').toLowerCase();
    const cls = (i.className || '').toString().toLowerCase();
    if (/search|find|filter/.test(place) || /search|find/.test(id) || /search|find/.test(cls)) {
      out.searchCandidates.push({
        tag: i.tagName.toLowerCase(),
        type: i.type,
        placeholder: i.placeholder,
        id: i.id,
        cls: (i.className || '').toString().slice(0, 100),
        outerHTML: i.outerHTML.slice(0, 240),
        parentTag: i.parentElement?.tagName?.toLowerCase(),
        parentCls: (i.parentElement?.className || '').toString().slice(0, 100),
      });
    }
  }
  // Also enumerate "topbar"-like containers.
  for (const sel of ['.pa-topbar', '.pa-header', '.pa-navigation', '[class*=topBar]', '[class*=TopBar]', '[class*=header]', 'header']) {
    const el = document.querySelector(sel);
    if (el) {
      out.topbar ||= [];
      out.topbar.push({
        selector: sel,
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: (el.className || '').toString().slice(0, 100),
        rect: el.getBoundingClientRect ? { y: Math.round(el.getBoundingClientRect().top), h: Math.round(el.getBoundingClientRect().height) } : null,
      });
    }
  }
  // For the first search candidate, walk up to the topbar so we know the path.
  if (out.searchCandidates.length > 0) {
    let cursor = inputs.find((i) => i.outerHTML.startsWith(out.searchCandidates[0].outerHTML.slice(0, 40)));
    let depth = 0;
    while (cursor && depth < 15) {
      out.pathToSearch.unshift({
        tag: cursor.tagName.toLowerCase(),
        id: cursor.id || '',
        cls: (cursor.className || '').toString().slice(0, 80),
        role: cursor.getAttribute('role') || '',
      });
      cursor = cursor.parentElement;
      depth++;
    }
  }
  return out;
});
console.log(JSON.stringify(inspection, null, 2));
await b.close();
