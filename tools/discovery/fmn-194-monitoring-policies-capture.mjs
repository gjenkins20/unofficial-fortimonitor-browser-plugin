// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-194 Discovery: capture FortiMonitor Monitoring Policies API.
//
// Interactive Playwright session-auth recorder, modeled on
// tools/discovery/sso-capture.js (FMN-138). The operator drives the
// browser manually (log in, navigate to Monitoring > Monitoring Policies,
// exercise list / create / edit / delete); the script passively records
// every XHR/fetch whose URL or response is policy-shaped and writes them
// to a JSON capture file when the browser closes.
//
// Usage:
//   node tools/discovery/fmn-194-monitoring-policies-capture.mjs \
//     [--tenant=https://fortimonitor.forticloud.com] \
//     [--output=tools/discovery/fmn-194-capture-YYYY-MM-DD.json] \
//     [--user-data-dir=/tmp/fm-mp-capture] \
//     [--no-op]   # boot the script, navigate to about:blank, exit. Used for
//                 # the Playwright-convention sanity check before pairing.
//
// Outputs:
//   - The capture JSON file (default: tools/discovery/fmn-194-capture-<date>.json)
//   - Console summary: probe results, captured-request count
//
// Safety:
//   - The capture file contains the operator's session cookies in request
//     headers. Treat it like a credential; do NOT commit it. The repo's
//     .gitignore already excludes tools/discovery/*.json captures.
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
const TENANT_ORIGIN = stripTrailingSlash(args.tenant || 'https://fortimonitor.forticloud.com');
const OUTPUT_PATH = path.resolve(args.output || defaultOutputPath());
const USER_DATA_DIR = args['user-data-dir'] || fs.mkdtempSync(path.join(os.tmpdir(), 'fm-mp-capture-'));
const NO_OP = Boolean(args['no-op']);

function stripTrailingSlash(s) {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function defaultOutputPath() {
  const today = new Date().toISOString().slice(0, 10);
  return `tools/discovery/fmn-194-capture-${today}.json`;
}

// ---------- Policy-shape filter ----------
//
// A URL counts as policy-shaped if its path or query contains any of these
// tokens (case-insensitive). False positives are fine; the goal is to
// over-capture and triage during analysis.

const POLICY_PATTERN = /(monitoring[-_]?polic|policies|policy|auto[-_]?apply|auto[-_]?assign|auto[-_]?template|provisioning[-_]?rule|matching[-_]?rule|onboarding[-_]?rule)/i;

function looksPolicyShaped(url) {
  try {
    const u = new URL(url);
    return POLICY_PATTERN.test(u.pathname + u.search);
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
// Runs after the operator finishes the walk-through. Hits each candidate
// with a credentialed GET (using context.request, which inherits cookies)
// and reports status + content-type. Helps confirm which endpoints exist
// and which 404 / 405 / redirect to /login.

const CANDIDATE_PATHS = [
  // v2 API guesses (api2.panopta.com is the public v2; some endpoints proxy
  // through the tenant origin, others don't. We probe the tenant origin
  // here. The capture itself will reveal the actual host the UI uses.)
  '/v2/monitoring_policy',
  '/v2/monitoring_policies',
  '/v2/policy',
  '/v2/policies',
  '/v2/auto_apply',
  '/v2/auto_assignment',
  '/v2/provisioning_rule',
  '/v2/matching_rule',
  // Session-auth (UI internal) guesses
  '/config/monitoring_policies',
  '/config/monitoring_policy',
  '/admin/monitoring_policies',
  '/account/monitoring_policies',
  '/onboarding/monitoring_policies',
  '/report/monitoring_policies',
  '/report/MonitoringPolicies',
  // Plural-form guesses sometimes used by FortiMonitor route names
  '/MonitoringPolicies',
  '/MonitoringPolicy'
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

  console.log('--- FortiMonitor Monitoring Policies capture (FMN-194) ---');
  console.log(`Tenant origin:    ${TENANT_ORIGIN}`);
  console.log(`User data dir:    ${USER_DATA_DIR}`);
  console.log(`Output file:      ${OUTPUT_PATH}`);
  console.log(`Mode:             ${NO_OP ? 'NO-OP (sanity-check boot)' : 'interactive pairing'}`);
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
    const isXhr = request.resourceType() === 'xhr' || request.resourceType() === 'fetch';
    if (!looksPolicyShaped(url) && !isXhr) return;
    const entry = {
      method: request.method(),
      url,
      resourceType: request.resourceType(),
      policyShaped: looksPolicyShaped(url),
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
      return data.length > 200_000 ? data.slice(0, 200_000) + '\n[...truncated...]' : data;
    } catch { return null; }
  }

  const page = context.pages()[0] || await context.newPage();

  if (NO_OP) {
    // Sanity-check path per Playwright Conventions: confirm imports +
    // Chromium boot work without dragging the operator in. We navigate to
    // about:blank, wait a moment, and exit.
    await page.goto('about:blank');
    console.log('NO-OP boot succeeded. Closing.');
    await context.close();
    return;
  }

  await page.goto(TENANT_ORIGIN + '/');

  console.log('A browser window has opened.');
  console.log('');
  console.log('Walk-through (drive the browser; the script captures passively):');
  console.log('');
  console.log('  1. Log in to FortiMonitor as an admin with policy-config permissions.');
  console.log('  2. Navigate: Monitoring (sidebar) > Monitoring Policies.');
  console.log('  3. LIST: let the page render. The list-load XHR will fire.');
  console.log('  4. CREATE: click Create (or "+" / "New Policy"). Fill a dummy policy.');
  console.log('       - Name: "FMN-194 capture probe"');
  console.log('       - Predicate: pick attribute equality (e.g. Model = "FortiGate")');
  console.log('       - Action: attach a known template (any existing template is fine).');
  console.log('       - Auto-apply: toggle whichever option exposes the auto-vs-once flag.');
  console.log('       - Save.');
  console.log('  5. EDIT: open the policy you just created, change ONE field, Save again.');
  console.log('  6. (Optional) TRIGGER: if a "Run now" / "Evaluate" button exists, click it.');
  console.log('  7. DELETE: delete the probe policy you created.');
  console.log('  8. Close the browser window. The script writes captures.');
  console.log('');
  console.log('Narration to capture verbally (we will record in the doc afterwards):');
  console.log('  - Which toggle distinguishes auto-apply (fires on new onboards) vs');
  console.log('    apply-once (manual trigger only)?');
  console.log('  - When multiple policies match an instance, which wins?');
  console.log('  - Is there a visible "last evaluated" or similar runtime field?');
  console.log('');
  console.log('Capture progress (live):');
  console.log('');

  let printedCount = 0;
  const liveTimer = setInterval(() => {
    while (printedCount < captures.length) {
      const c = captures[printedCount];
      const mark = c.policyShaped ? ' (policy-shaped)' : '';
      console.log(`  [${c.method}] ${c.url}${mark}`);
      printedCount += 1;
    }
  }, 500);

  await context.waitForEvent('close', { timeout: 0 }).catch(() => {});
  clearInterval(liveTimer);

  // Probe candidates. We need a context that still has cookies; the
  // operator-driven context was just closed, so spin a headless one off
  // the same persistent user-data-dir.
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

  const capture = {
    capturedAt: new Date().toISOString(),
    tenantOrigin: TENANT_ORIGIN,
    requests: captures,
    probes: probeResults
  };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(capture, null, 2));

  // Summary
  const policyShapedCount = captures.filter((c) => c.policyShaped).length;
  console.log('');
  console.log('--- Summary ---');
  console.log(`Total requests captured (XHR/fetch on tenant origin + policy-shaped): ${captures.length}`);
  console.log(`Policy-shaped requests: ${policyShapedCount}`);
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
  console.log('Next: review the capture, then write docs/api-discovery/monitoring-policies.md');
  console.log('per FMN-194 acceptance.');
}

main().catch((err) => {
  console.error('fmn-194 capture failed:', err);
  process.exit(1);
});
