// FMN-191: install a persistent (survives navigation) network capture
// on the operator's FortiMonitor tab. Attaches via Playwright's
// addInitScript so the in-page fetch/XHR interceptor re-installs on
// EVERY document load in that tab. Records URL + method + status +
// body snippet + timestamps into window.__fmn191Capture.
//
// Run this BEFORE the operator drives a report run. After they finish,
// run tools/qa/fmn-191-drain-persistent-capture.mjs to read everything
// captured so far.
import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const tenant = ctx.pages().find((p) => /fortimonitor/i.test(p.url()));
if (!tenant) { console.error('No FortiMonitor tab. Open one first.'); process.exit(1); }

const interceptorScript = `
  (() => {
    if (window.__fmn191Installed) return;
    window.__fmn191Installed = true;
    window.__fmn191Capture = window.__fmn191Capture || [];
    const SHOULD = /report|job|poll|status|task|export|render|generate|canned|incident|notification/i;
    const sanitize = (u) => {
      try { const p = new URL(u, location.origin); return p.pathname + p.search + p.hash; }
      catch { return String(u); }
    };
    const masking = (s) => String(s || '').replace(/[A-Za-z0-9_-]{40,}/g, '<long-token>');
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const t0 = performance.now();
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
      const method = (args[1]?.method ?? (args[0]?.method ?? 'GET')).toUpperCase();
      const reqBody = (args[1]?.body && typeof args[1].body === 'string') ? args[1].body : '';
      const resp = await origFetch.apply(this, args);
      try {
        if (SHOULD.test(url)) {
          let body = '';
          try { body = (await resp.clone().text()).slice(0, 600); } catch { body = '<unreadable>'; }
          window.__fmn191Capture.push({ ts: Date.now(), kind: 'fetch', url: sanitize(url), method, status: resp.status, ms: Math.round(performance.now() - t0), reqBody: masking(reqBody).slice(0, 400), body: masking(body) });
        }
      } catch {}
      return resp;
    };
    const OrigXHR = window.XMLHttpRequest;
    function PatchedXHR() {
      const xhr = new OrigXHR();
      let method = 'GET', url = '', reqBody = '';
      const origOpen = xhr.open;
      xhr.open = function (m, u, ...rest) { method = m; url = u; return origOpen.call(xhr, m, u, ...rest); };
      const origSend = xhr.send;
      xhr.send = function (body) { if (body && typeof body === 'string') reqBody = body; return origSend.call(xhr, body); };
      const t0 = performance.now();
      xhr.addEventListener('loadend', () => {
        try {
          if (!SHOULD.test(url)) return;
          let body = '';
          try { body = String(xhr.responseText || '').slice(0, 600); } catch { body = '<unreadable>'; }
          window.__fmn191Capture.push({ ts: Date.now(), kind: 'xhr', url: sanitize(url), method: method.toUpperCase(), status: xhr.status, ms: Math.round(performance.now() - t0), reqBody: masking(reqBody).slice(0, 400), body: masking(body) });
        } catch {}
      });
      return xhr;
    }
    PatchedXHR.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = PatchedXHR;
    console.log('[fmn-191] interceptor installed');
  })();
`;

// Re-arm on every future load.
await tenant.addInitScript({ content: interceptorScript });
// And install on the currently-loaded page too.
await tenant.evaluate(interceptorScript);
console.log('Persistent capture armed on tab:', tenant.url());
console.log('Operator: drive whatever you want on the FortiMonitor tab.');
console.log('When done, run: node tools/qa/fmn-191-drain-persistent-capture.mjs');
await b.close();
