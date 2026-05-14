// FMN-191: drain whatever the persistent interceptor has captured on
// the FortiMonitor tab. Save the full payload to a capture file plus
// print a compact summary.
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const tenant = ctx.pages().find((p) => /fortimonitor/i.test(p.url()));
if (!tenant) { console.error('No FortiMonitor tab.'); process.exit(1); }

const events = await tenant.evaluate(() => {
  return Array.isArray(window.__fmn191Capture) ? window.__fmn191Capture.slice() : null;
});
if (!Array.isArray(events)) {
  console.error('Interceptor not installed. Run fmn-191-arm-persistent-capture.mjs first.');
  process.exit(1);
}

console.log(`Captured ${events.length} events.\n`);
const summarize = (e) => {
  const ts = new Date(e.ts).toISOString();
  const head = `${ts} ${e.kind.toUpperCase().padEnd(5)} ${e.method.padEnd(6)} ${String(e.status).padEnd(3)} ${String(e.ms).padStart(5)}ms  ${e.url}`;
  const lines = [head];
  if (e.reqBody) lines.push(`   req: ${e.reqBody.replace(/\n/g, ' ').slice(0, 240)}`);
  if (e.body) {
    const trimmed = e.body.replace(/\s+/g, ' ').slice(0, 320);
    if (trimmed) lines.push(`   res: ${trimmed}`);
  }
  return lines.join('\n');
};
for (const e of events) console.log(summarize(e));

mkdirSync('docs/api-discovery/captures', { recursive: true });
const out = `docs/api-discovery/captures/fmn-191-flow-${Date.now()}.json`;
writeFileSync(out, JSON.stringify(events, null, 2));
console.log(`\nFull capture saved to ${out}`);
await b.close();
