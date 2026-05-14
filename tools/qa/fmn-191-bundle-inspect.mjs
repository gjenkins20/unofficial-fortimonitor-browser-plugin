// FMN-191 discovery: grep the ListReports.js bundle to find how it
// polls for / detects report completion.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const tenant = ctx.pages().find((p) => /fortimonitor/i.test(p.url()));

const bundleText = await tenant.evaluate(async () => {
  const r = await fetch('/static/assets/newux/scripts/ListReports.f2c29c9f055614d3f0bf.js', { credentials: 'include' });
  return r.text();
});
console.log('bundle length:', bundleText.length);

// Find every URL reference under /report/
const urls = [...bundleText.matchAll(/['"`]\/report\/[A-Za-z0-9_-]+/g)].map((m) => m[0].slice(1));
const distinct = [...new Set(urls)];
console.log('\ndistinct /report/* URL strings:');
for (const u of distinct) console.log(' ', u);

// Find setInterval / setTimeout patterns and their surrounding context.
const findCtx = (needle, before = 250, after = 250) => {
  const out = [];
  let cur = 0;
  for (;;) {
    const i = bundleText.indexOf(needle, cur);
    if (i === -1) break;
    out.push(bundleText.slice(Math.max(0, i - before), i + needle.length + after));
    cur = i + needle.length;
  }
  return out;
};

console.log('\n=== setInterval (' + findCtx('setInterval').length + ' occurrences) first 3:');
for (const o of findCtx('setInterval').slice(0, 3)) { console.log('---'); console.log(o); }

console.log('\n=== "complete" in pipe with "status" (15 results):');
const statusComplete = findCtx('status').filter((s) => /complete/i.test(s)).slice(0, 15);
for (const o of statusComplete) { console.log('---'); console.log(o.slice(0, 500)); }

writeFileSync('/tmp/list-reports-bundle.js', bundleText);
console.log('\nFull bundle saved to /tmp/list-reports-bundle.js');
await b.close();
