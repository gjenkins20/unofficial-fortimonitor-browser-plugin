// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-199 Discovery: capture FortiMonitor's frontend template-create API.
//
// Modeled on tools/discovery/fmn-194-monitoring-policies-capture.mjs.
// The operator drives the browser manually (log in, navigate to the
// Templates surface, exercise create / edit / delete); the script
// passively records every XHR/fetch whose URL is template-shaped and
// writes them to a JSON capture file when the browser closes.
//
// Usage:
//   node tools/discovery/fmn-199-templates-create-capture.mjs \
//     [--tenant=https://fortimonitor.forticloud.com] \
//     [--output=tools/discovery/fmn-199-capture-YYYY-MM-DD.json] \
//     [--user-data-dir=/tmp/fm-templates-capture] \
//     [--no-op]
//
// Safety:
//   The capture file contains the operator's session cookies in request
//   headers. Treat it like a credential. The repo's .gitignore excludes
//   tools/discovery/fmn-199-capture-*.json captures.

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
const USER_DATA_DIR = args['user-data-dir'] || fs.mkdtempSync(path.join(os.tmpdir(), 'fm-templates-capture-'));
const NO_OP = Boolean(args['no-op']);

function stripTrailingSlash(s) {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
function defaultOutputPath() {
  const today = new Date().toISOString().slice(0, 10);
  return `tools/discovery/fmn-199-capture-${today}.json`;
}

// ---------- Template-shape filter ----------
//
// A URL counts as template-shaped if its path or query contains any of
// these tokens (case-insensitive). False positives are fine; the goal
// is to over-capture and triage during analysis. Also filters in
// agent_resource (FortiMonitor's term for a metric / monitor) because
// add-resource is likely a separate endpoint.

const TEMPLATE_PATTERN = /(server[-_]?template|template|agent[-_]?resource|monitoring[-_]?config|threshold|alert[-_]?item)/i;

function looksTemplateShaped(url) {
  try {
    const u = new URL(url);
    return TEMPLATE_PATTERN.test(u.pathname + u.search);
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

const CANDIDATE_PATHS = [
  // Likely SPA route paths
  '/templates',
  '/server_templates',
  '/Templates',
  '/ServerTemplates',
  // Internal data endpoints (snake_case is FortiMonitor's pattern)
  '/template/get_page_data',
  '/templates/get_page_data',
  '/server_template/get_page_data',
  '/config/add_server_template',
  '/config/edit_server_template',
  '/config/save_server_template',
  '/config/delete_server_template',
  '/report/templates',
  '/report/Templates',
  '/onboarding/templates',
  // v2-shaped candidates on tenant origin (these all returned SPA shell
  // in FMN-194 but include them for completeness)
  '/v2/server_template',
  '/v2/template'
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

  console.log('--- FortiMonitor template-create capture (FMN-199) ---');
  console.log(`Tenant origin:    ${TENANT_ORIGIN}`);
  console.log(`User data dir:    ${USER_DATA_DIR}`);
  console.log(`Output file:      ${OUTPUT_PATH}`);
  console.log(`Mode:             ${NO_OP ? 'NO-OP (sanity-check boot)' : 'interactive pairing'}`);
  console.log('');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 }
  });

  context.on('request', (request) => {
    const url = request.url();
    if (!isFortimonitorOrigin(url)) return;
    const isXhr = request.resourceType() === 'xhr' || request.resourceType() === 'fetch';
    if (!looksTemplateShaped(url) && !isXhr) return;
    const entry = {
      method: request.method(),
      url,
      resourceType: request.resourceType(),
      templateShaped: looksTemplateShaped(url),
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
  console.log('  1. Log in to FortiMonitor as an admin with template-config permissions.');
  console.log('  2. Navigate to the Templates surface (Monitoring → Templates, or wherever');
  console.log('     it lives in your tenant). Let the list render.');
  console.log('  3. CREATE a probe template:');
  console.log('       - Name: "FMN-199 capture probe"');
  console.log('       - Add 2-3 small agent_resources (e.g. CPU, memory).');
  console.log('       - Set a threshold on one of them.');
  console.log('       - Save.');
  console.log('  4. EDIT the probe template:');
  console.log('       - Add one more resource.');
  console.log('       - Change one threshold.');
  console.log('       - Save.');
  console.log('  5. (Optional) Try creating a SECOND template with the same name as the');
  console.log('     probe so we can capture the duplicate-name error path.');
  console.log('  6. DELETE the probe template.');
  console.log('  7. Close the browser window. The script writes captures.');
  console.log('');
  console.log('Narration to surface in chat:');
  console.log('  - Which sidebar / nav path opens the Templates UI?');
  console.log('  - When you click Save on create, does the form post to one endpoint');
  console.log('    or multiple? (You can watch the live stream below.)');
  console.log('  - Any "add resource" buttons that hit the server separately from Save?');
  console.log('');
  console.log('Capture progress (live):');
  console.log('');

  let printedCount = 0;
  const liveTimer = setInterval(() => {
    while (printedCount < captures.length) {
      const c = captures[printedCount];
      const mark = c.templateShaped ? ' (template-shaped)' : '';
      console.log(`  [${c.method}] ${c.url}${mark}`);
      printedCount += 1;
    }
  }, 500);

  await context.waitForEvent('close', { timeout: 0 }).catch(() => {});
  clearInterval(liveTimer);

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

  const templateShapedCount = captures.filter((c) => c.templateShaped).length;
  console.log('');
  console.log('--- Summary ---');
  console.log(`Total requests captured (XHR/fetch on tenant origin + template-shaped): ${captures.length}`);
  console.log(`Template-shaped requests: ${templateShapedCount}`);
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
  console.log('Next: review the capture, then write docs/api-discovery/templates-create.md.');
}

main().catch((err) => {
  console.error('fmn-199 capture failed:', err);
  process.exit(1);
});
