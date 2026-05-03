// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-138 Discovery: capture FortiMonitor SSO admin endpoints.
//
// Interactive Playwright session-auth recorder. The operator drives the
// browser manually (log in, navigate to FortiMonitor's SSO admin UI,
// load + save + test the SSO config); the script passively records every
// XHR/fetch that smells SSO-shaped (URL contains sso, saml, idp, oauth,
// oidc, auth_settings, authentication, identity, federation) and writes
// them to a JSON capture file when the browser closes.
//
// Usage:
//   node tools/discovery/sso-capture.js \
//     --tenant=https://acme.fortimonitor.com \
//     [--output=tools/discovery/sso-capture-2026-05-02.json] \
//     [--user-data-dir=/tmp/fm-sso-capture]
//
// Outputs:
//   - The capture JSON file (default: tools/discovery/sso-capture-<date>.json)
//   - Console summary: probe results, captured-request count
//
// Safety:
//   - The capture file may contain the operator's session cookies in
//     request headers and the IdP signing certificate in request bodies.
//     Treat it like a credential. Do NOT commit the raw capture.
//   - The script writes to a path relative to repo root; the default
//     filename includes the date so successive runs do not overwrite.
//   - Cookies named XSRF-TOKEN, sessionid, csrftoken etc. are NOT
//     redacted. If you need to share the capture, redact it first.
//
// Why this is its own script (not a Playwright test):
//   This is an operator tool, not a regression test. It runs interactively,
//   exits when the operator closes the browser, and writes its findings
//   out for human consumption. Tests live under tests/e2e/.

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------- Args ----------

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (arg.startsWith('--')) out[arg.slice(2)] = true;
  }
  return out;
}

const args = parseArgs(process.argv);

if (!args.tenant) {
  console.error('Missing --tenant=<base url>. Example:');
  console.error('  node tools/discovery/sso-capture.js --tenant=https://acme.fortimonitor.com');
  process.exit(2);
}

const TENANT_ORIGIN = stripTrailingSlash(args.tenant);
const OUTPUT_PATH = path.resolve(args.output || defaultOutputPath());
const USER_DATA_DIR = args['user-data-dir'] || fs.mkdtempSync(path.join(os.tmpdir(), 'fm-sso-capture-'));

function stripTrailingSlash(s) {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function defaultOutputPath() {
  const today = new Date().toISOString().slice(0, 10);
  return `tools/discovery/sso-capture-${today}.json`;
}

// ---------- SSO-shape filter ----------
//
// A URL counts as SSO-shaped if its path or query contains any of these
// tokens (case-insensitive). False positives are fine; the goal is to
// over-capture and triage during analysis.

const SSO_PATTERN = /(sso|saml|idp|identity[-_]?provider|oauth|oidc|federation|auth[-_]?settings|authentication|sign[-_]?on|metadata)/i;

function looksSsoShaped(url) {
  try {
    const u = new URL(url);
    return SSO_PATTERN.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

function isFortimonitorOrigin(url) {
  try {
    const u = new URL(url);
    return u.origin === TENANT_ORIGIN;
  } catch {
    return false;
  }
}

// ---------- Candidate-URL probe ----------
//
// Runs after the operator logs in. Hits each candidate with a credentialed
// GET (using page.request, which inherits the context's cookies) and
// reports status + content-type for each. Helps the operator narrow down
// where the SSO admin UI lives without manually clicking around.

const CANDIDATE_PATHS = [
  '/account/sso',
  '/account/sso_settings',
  '/account/saml',
  '/account/saml_settings',
  '/account/SamlSso',
  '/account/identity_provider',
  '/account/auth_settings',
  '/account/authentication',
  '/account/federation',
  '/admin/sso',
  '/admin/sso_settings',
  '/admin/saml',
  '/admin/identity_providers',
  '/admin/authentication',
  '/config/sso',
  '/config/saml_settings',
  '/onboarding/getSsoConfig',
  '/api/v1/sso',
  '/api/v1/saml',
  '/api/v1/identity_providers'
];

async function probeCandidates(context) {
  const out = [];
  for (const p of CANDIDATE_PATHS) {
    const url = TENANT_ORIGIN + p;
    try {
      const res = await context.request.get(url, { failOnStatusCode: false });
      out.push({
        path: p,
        url,
        status: res.status(),
        contentType: res.headers()['content-type'] || null,
        finalUrl: res.url()
      });
    } catch (err) {
      out.push({ path: p, url, error: err.message || String(err) });
    }
  }
  return out;
}

// ---------- Capture ----------

async function main() {
  const captures = [];
  const requestById = new Map();

  console.log('--- FortiMonitor SSO admin capture ---');
  console.log(`Tenant origin:    ${TENANT_ORIGIN}`);
  console.log(`User data dir:    ${USER_DATA_DIR}`);
  console.log(`Output file:      ${OUTPUT_PATH}`);
  console.log('');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 }
    // NOTE: this script intentionally runs visibly. The
    // playwright_offscreen_window memory governs tests; this is an
    // interactive operator tool that the operator must see and drive.
  });

  context.on('request', (request) => {
    const url = request.url();
    if (!isFortimonitorOrigin(url)) return;
    if (!looksSsoShaped(url) && request.resourceType() !== 'xhr' && request.resourceType() !== 'fetch') return;
    const entry = {
      method: request.method(),
      url,
      resourceType: request.resourceType(),
      ssoShaped: looksSsoShaped(url),
      requestHeaders: request.headers(),
      requestBody: tryBody(request),
      response: null,
      timestamp: new Date().toISOString()
    };
    captures.push(entry);
    requestById.set(request, entry);
  });

  context.on('response', async (response) => {
    const request = response.request();
    const entry = requestById.get(request);
    if (!entry) return;
    let body = null;
    try {
      const ct = response.headers()['content-type'] || '';
      // Avoid pulling huge or binary responses.
      const len = Number(response.headers()['content-length'] || 0);
      if (len < 200_000 && /(json|xml|html|text|javascript)/i.test(ct)) {
        body = await response.text();
      } else if (!len) {
        body = await response.text().catch(() => null);
      }
    } catch { /* ignore */ }
    entry.response = {
      status: response.status(),
      headers: response.headers(),
      body
    };
  });

  function tryBody(request) {
    try {
      const data = request.postData();
      if (data == null) return null;
      // Cap at 200 KB to keep capture files sane.
      return data.length > 200_000 ? data.slice(0, 200_000) + '\n[...truncated...]' : data;
    } catch { return null; }
  }

  const page = context.pages()[0] || await context.newPage();
  await page.goto(TENANT_ORIGIN + '/');

  console.log('A browser window has opened.');
  console.log('');
  console.log('  1. Log in to FortiMonitor as an admin with SSO config permissions.');
  console.log('  2. Navigate to the SSO admin UI (Account Settings -> SSO, or similar).');
  console.log('  3. Exercise these flows in order so the script captures them:');
  console.log('       a. Load the SSO config page (captures the initial GET).');
  console.log('       b. If the form is empty, fill in dummy values (do NOT save yet).');
  console.log('       c. Click Save (captures the POST/PUT).');
  console.log('       d. If the UI has a "Test SAML config" or similar button, click it');
  console.log('          (captures any test endpoint).');
  console.log('       e. If the UI has a "Reset" or "Disable SSO" button, do not click it.');
  console.log('  4. Close the browser window when done. The script will write captures.');
  console.log('');
  console.log('Capture progress will print below as requests fire:');
  console.log('');

  // Print captures live so the operator sees the recorder is working.
  let printedCount = 0;
  const liveTimer = setInterval(() => {
    while (printedCount < captures.length) {
      const c = captures[printedCount];
      console.log(`  [${c.method}] ${c.url}${c.ssoShaped ? ' (SSO-shaped)' : ''}`);
      printedCount += 1;
    }
  }, 500);

  // Wait for the operator to finish.
  await context.waitForEvent('close', { timeout: 0 }).catch(() => {});
  clearInterval(liveTimer);

  // Probe candidate URLs (we still have the browser context if waitForEvent
  // returned because of timeout, but typically we get here after manual close.
  // Run the probes against a fresh context built from the same persistent
  // user-data-dir so cookies/session survive.
  let probeResults = null;
  try {
    const probeContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: true
    });
    probeResults = await probeCandidates(probeContext);
    await probeContext.close();
  } catch (err) {
    console.warn('Probe phase failed:', err.message || err);
    probeResults = null;
  }

  // ---------- Write capture ----------
  const capture = {
    capturedAt: new Date().toISOString(),
    tenantOrigin: TENANT_ORIGIN,
    requests: captures,
    probes: probeResults
  };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(capture, null, 2));

  // ---------- Summary ----------
  const ssoShapedCount = captures.filter((c) => c.ssoShaped).length;
  console.log('');
  console.log('--- Summary ---');
  console.log(`Total requests captured (XHR/fetch + SSO-shaped): ${captures.length}`);
  console.log(`SSO-shaped requests: ${ssoShapedCount}`);
  if (probeResults) {
    const reachable = probeResults.filter((p) => p.status && p.status < 400);
    console.log(`Candidate-URL probes: ${probeResults.length} attempted, ${reachable.length} reachable`);
    if (reachable.length) {
      console.log('  Reachable candidates:');
      for (const p of reachable) {
        console.log(`    ${p.status} ${p.url}  (${p.contentType || '-'})`);
      }
    }
  }
  console.log('');
  console.log(`Capture file: ${OUTPUT_PATH}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Review the capture file. SSO-shaped POST/PUT entries are the prize -');
  console.log('     they reveal whether FortiMonitor accepts metadata XML import or');
  console.log('     requires per-field paste, and the exact request shape.');
  console.log('  2. Drop a sanitized summary into docs/api-discovery/sso-config.md');
  console.log('     following the pattern of port-scope.md.');
  console.log('  3. Comment on FMN-138 with the findings, then move FMN-138 to Done.');
  console.log('  4. The capture file may include session cookies and IdP cert');
  console.log('     material. Do NOT commit it; redact before sharing.');
  console.log('');
}

main().catch((err) => {
  console.error('sso-capture failed:', err);
  process.exit(1);
});
