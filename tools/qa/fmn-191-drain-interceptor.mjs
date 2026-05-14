// FMN-191 step 2: drain the interceptor buffer. Run after the operator
// has triggered a report creation + run on the FortiMonitor tab.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const tenant = ctx.pages().find((p) => /fortimonitor/i.test(p.url()));
if (!tenant) { console.error('No FortiMonitor tab in context.'); process.exit(1); }

const events = await tenant.evaluate(() => Array.isArray(window.__fmn191Capture) ? window.__fmn191Capture.slice() : null);
if (!events) { console.error('Interceptor not installed. Run fmn-191-install-interceptor.mjs first.'); process.exit(1); }
if (events.length === 0) { console.log('Buffer empty. Operator may not have triggered anything yet.'); }

console.log(`Captured ${events.length} events. Most recent 40:\n`);
for (const e of events.slice(-40)) {
  const ts = new Date(e.ts).toISOString();
  console.log(`${ts} ${e.method.padEnd(6)} ${String(e.status).padEnd(3)} ${String(e.ms).padStart(5)}ms  ${e.url}`);
  if (e.body && e.body.length > 0) console.log(`   body: ${e.body.replace(/\n/g, ' ').slice(0, 200)}`);
}

const out = `docs/api-discovery/captures/fmn-191-report-flow-${Date.now()}.json`;
writeFileSync(out, JSON.stringify(events, null, 2));
console.log(`\nFull capture saved to ${out}`);
await b.close();
