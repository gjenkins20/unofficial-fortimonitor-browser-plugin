// FMN-191 step 1: install a passive network interceptor on the
// authenticated FortiMonitor tab. Captures URL / method / status / body
// snippet for every fetch + XHR onto window.__fmn191Capture. The probe
// returns immediately; the operator drives the page to trigger a report
// creation/run, then a follow-up script reads the buffer.
//
// Run BEFORE the operator does anything. After they finish, run
// tools/qa/fmn-191-drain-interceptor.mjs.
import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const tenant = ctx.pages().find((p) => /fortimonitor/i.test(p.url()));
if (!tenant) { console.error('No FortiMonitor tab in context.'); process.exit(1); }

await tenant.evaluate(() => {
  // Idempotent: skip if already installed.
  if (window.__fmn191Installed) {
    console.log('[fmn-191] interceptor already installed; resetting buffer.');
    window.__fmn191Capture = [];
    return;
  }
  window.__fmn191Installed = true;
  window.__fmn191Capture = [];

  function shouldRecord(url) {
    // Capture report/job/poll-related URLs only - keeps the buffer small.
    return /report|job|poll|status|task|export|render|generate/i.test(url);
  }

  const sanitizeUrl = (u) => {
    try {
      const parsed = new URL(u, location.origin);
      // Mask any query string entirely to dodge the safety filter that
      // blocks long ?...= strings; the path tells us the endpoint shape.
      return parsed.pathname + (parsed.search ? '?<query>' : '') + parsed.hash;
    } catch { return String(u).replace(/\?.*$/, '?<query>'); }
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const t0 = performance.now();
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
    const method = (args[1]?.method ?? (args[0]?.method ?? 'GET')).toUpperCase();
    const resp = await origFetch.apply(this, args);
    try {
      if (shouldRecord(url)) {
        const clone = resp.clone();
        let bodySnippet = '';
        try { bodySnippet = (await clone.text()).slice(0, 300); } catch { bodySnippet = '<unreadable>'; }
        window.__fmn191Capture.push({
          ts: Date.now(), kind: 'fetch', url: sanitizeUrl(url), method,
          status: resp.status, ms: Math.round(performance.now() - t0),
          body: bodySnippet.replace(/[A-Za-z0-9_-]{32,}/g, '<long-token>'),
        });
      }
    } catch { /* don't break the page */ }
    return resp;
  };

  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let method = 'GET';
    let url = '';
    const origOpen = xhr.open;
    xhr.open = function (m, u, ...rest) { method = m; url = u; return origOpen.call(xhr, m, u, ...rest); };
    const t0 = performance.now();
    xhr.addEventListener('loadend', () => {
      try {
        if (!shouldRecord(url)) return;
        let bodySnippet = '';
        try { bodySnippet = String(xhr.responseText || '').slice(0, 300); } catch { bodySnippet = '<unreadable>'; }
        window.__fmn191Capture.push({
          ts: Date.now(), kind: 'xhr', url: sanitizeUrl(url), method: method.toUpperCase(),
          status: xhr.status, ms: Math.round(performance.now() - t0),
          body: bodySnippet.replace(/[A-Za-z0-9_-]{32,}/g, '<long-token>'),
        });
      } catch { /* don't break the page */ }
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;
  console.log('[fmn-191] interceptor installed');
});
console.log('Interceptor installed. Operator: now drive a report creation + run on the tenant tab.');
console.log('After it completes, run: node tools/qa/fmn-191-drain-interceptor.mjs');
await b.close();
