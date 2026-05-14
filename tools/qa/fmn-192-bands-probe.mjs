#!/usr/bin/env node
// FMN-192 bands probe.
// Enumerates the horizontal bands stacked from the top of the page down to
// the main content, so the operator can pin which one they mean by
// "Top bar" (distinct from "Header" = FortiCloud strip) and which container
// they mean by "Control Panel".
// Read-only.

import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const fmPage = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('fortimonitor.forticloud.com'));
if (!fmPage) { console.error('No FortiMonitor tab'); process.exit(1); }
console.log(`Probing: ${fmPage.url()}\n`);

const result = await fmPage.evaluate(() => {
  const seen = new Set();
  const bands = [];

  // Walk the visible top region of the page; collect any wide, short-ish
  // visible element whose top edge is in the upper third.
  document.querySelectorAll('*').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width < 600) return;
    if (r.height < 12 || r.height > 200) return;
    if (r.top < 0 || r.top > window.innerHeight * 0.55) return;
    // Dedupe by tag+class+rect signature to avoid every parent appearing.
    const sig = `${el.tagName}|${(typeof el.className === 'string' ? el.className : '')}|${Math.round(r.top)}|${Math.round(r.height)}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    bands.push({
      tag: el.tagName.toLowerCase(),
      classes: (typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean) : []),
      rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90),
      outerHTML: (el.outerHTML || '').slice(0, 250),
    });
  });
  // Sort by top edge ascending.
  bands.sort((a, b) => a.rect.top - b.rect.top);

  // Also: enumerate likely "main content container" candidates by walking up
  // from the page-header section to find the BIG container.
  const containers = [];
  const ph = document.querySelector('section.pa-page-header');
  if (ph) {
    let cur = ph.parentElement;
    for (let i = 0; i < 8 && cur; i++) {
      const r = cur.getBoundingClientRect();
      containers.push({
        depth: i,
        tag: cur.tagName.toLowerCase(),
        classes: (typeof cur.className === 'string' ? cur.className.split(/\s+/).filter(Boolean) : []),
        rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
        outerHTMLStart: (cur.outerHTML || '').slice(0, 200),
      });
      cur = cur.parentElement;
    }
  }
  return { bands, mainContentCandidates: containers, viewportH: window.innerHeight };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
