// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-211 Phase A: parse a HAR file exported from a tenant that has
// FortiAPs / FortiSwitches / FortiExtenders, extract the four
// session-auth endpoints we need, redact tenant-identifying content,
// and emit a structured contract doc.
//
// DEPENDENCIES: none. Plain Node, uses fs + path only.
//
// USAGE
//   node tools/qa/fmn-211-parse-har.mjs --har /path/to/tenant.har
//   node tools/qa/fmn-211-parse-har.mjs --har /path/to/tenant.har --out tools/qa/fmn-211-foreign-tenant-capture.json
//
// CAPTURE PLAYBOOK (what whoever-has-access does in their browser):
//
//   For each device class (FortiAP, FortiSwitch, FortiExtender) you can
//   access in the tenant, do these four steps. The HAR captures all
//   network traffic between Start and Stop, so the order matters less
//   than making sure all four happened.
//
//   PREP
//     1. Open the tenant in Chrome / Edge / Firefox.
//     2. Open DevTools (Cmd+Opt+I on mac, F12 on Windows).
//     3. Network tab. Tick "Preserve log". Clear (the circle-slash icon).
//     4. Optional: filter to "report/get_idp_data" OR "config" to keep
//        the HAR small. The parser only reads four endpoint patterns
//        so any filter that keeps them is fine.
//
//   CAPTURE (do this once per device class you have access to)
//     5. Navigate to ONE device's detail page in the tenant UI. Wait
//        for it to render. This logs /report/get_idp_data.
//     6. Click into that device's Monitoring Config / Settings view.
//        This logs /report/get_monitoring_config_data.
//     7. Open the "Save as Template" / "Create Template" dialog from
//        that device. DO NOT submit it - just open the dialog. This
//        logs /config/get_create_server_template_data. Close the
//        dialog without saving.
//     8. (Optional but useful) Navigate around the device's pages enough
//        that /onboarding/getDevicePorts fires - this confirms whether
//        the endpoint exists for non-FortiGate types.
//
//   EXPORT
//     9. In the Network tab, right-click any row -> "Save all as HAR
//        with content".
//    10. Before sharing: open the HAR in a text editor, search-and-
//        scan for any customer name, email, IP block, or account slug
//        that obviously identifies the tenant. The parser redacts
//        common patterns but a human eye catches things regex won't.
//    11. Send the HAR. The parser will redact further before emitting
//        the contract doc.
//
// EXTRACTED ENDPOINTS (matched by URL substring):
//   /report/get_idp_data                  -> fabricSystemData shape
//   /report/get_monitoring_config_data    -> category textkeys + metric
//                                            textkeys + plugin_textkeys
//   /config/get_create_server_template_data -> template_type default,
//                                            dialog defaults
//   /onboarding/getDevicePorts            -> shape on non-FortiGate
//                                            (expected: error / SPA shell)
//
// REDACTION POLICY (applied before write):
//   - Tenant subdomain in URLs            -> <TENANT>
//   - Server name / fqdn / hostname       -> <host-N>
//   - IPv4 / IPv6                         -> <ip> / <ip6>
//   - MAC addresses                       -> <mac>
//   - Long tokens (32+ char base64-ish)   -> <token>
//   - alert_items, tags, description      -> dropped entirely
//   - account_id, customer_id, etc.       -> dropped entirely
//   - Cookies + auth headers              -> stripped from request
//                                            blocks

import fs from 'node:fs';
import path from 'node:path';

// ---------- Redaction policy ----------

const DROP_KEYS = new Set([
  'description', 'tags', 'alert_items',
  'account_id', 'account_name', 'customer_id', 'customer_name',
  'company', 'organization', 'owner',
  'fqdn', 'additional_fqdns', 'ip', 'ip_address', 'ipv4', 'ipv6',
  'mac', 'mac_address', 'hostname', 'host',
  'serial_number', 'serial',
  'url', 'edit_url', 'view_url',
  'geo_latitude', 'geo_longitude',
  'address', 'city', 'state', 'zip', 'country'
]);
const NAME_KEYS = new Set(['name', 'display_name', 'instance_name']);

// ---------- CLI ----------

const args = parseArgs(process.argv.slice(2));
if (!args.har) {
  console.error('USAGE: node tools/qa/fmn-211-parse-har.mjs --har <path> [--out <path>]');
  process.exit(2);
}
if (!fs.existsSync(args.har)) {
  console.error(`HAR file not found: ${args.har}`);
  process.exit(2);
}
const outPath = args.out || path.join(path.dirname(args.har), 'fmn-211-foreign-tenant-capture.json');

// ---------- Parse HAR ----------

const har = JSON.parse(fs.readFileSync(args.har, 'utf8'));
const entries = har?.log?.entries;
if (!Array.isArray(entries)) {
  console.error('HAR file has no log.entries array.');
  process.exit(2);
}
console.log(`HAR file: ${args.har}  (${entries.length} request entries)`);

const ENDPOINTS = {
  idp_data: { match: '/report/get_idp_data', captures: [] },
  monitoring_config: { match: '/report/get_monitoring_config_data', captures: [] },
  create_template_defaults: { match: '/config/get_create_server_template_data', captures: [] },
  get_device_ports: { match: '/onboarding/getDevicePorts', captures: [] }
};

// Detect tenant origin from the first FortiMonitor URL we see, so we
// can scrub it from any surviving strings in the output.
let tenantOrigin = null;

for (const entry of entries) {
  const url = entry?.request?.url;
  if (!url) continue;
  if (!tenantOrigin) {
    const m = url.match(/^https?:\/\/[^/]*fortimonitor[^/]*/i);
    if (m) tenantOrigin = m[0];
  }
  for (const key of Object.keys(ENDPOINTS)) {
    if (url.includes(ENDPOINTS[key].match)) {
      ENDPOINTS[key].captures.push(entry);
    }
  }
}

if (!tenantOrigin) {
  console.warn('WARN: no FortiMonitor origin detected from HAR. URL scrubbing will only target generic patterns.');
}

console.log(`tenant origin detected: ${tenantOrigin || '(none)'}`);
for (const [key, val] of Object.entries(ENDPOINTS)) {
  console.log(`  ${key}: ${val.captures.length} hit(s)`);
}

// ---------- Extract + redact each capture ----------

const out = {
  schema_version: 1,
  captured_at: new Date().toISOString(),
  source_har: path.basename(args.har),
  tenant_origin_placeholder: '<TENANT>',
  redaction_notes: [
    'All FortiMonitor tenant URLs replaced with <TENANT>',
    'Server names / fqdns / IPs / MACs / long tokens redacted',
    'alert_items / tags / description / account fields dropped',
    'Cookies and auth headers stripped',
    'Hand-review before sharing further.'
  ],
  endpoints: {}
};

const hostCounter = [0];

for (const [key, val] of Object.entries(ENDPOINTS)) {
  out.endpoints[key] = val.captures.map((entry) => summarize(entry, tenantOrigin, hostCounter));
}

// Add the inherited contract block for createServerTemplate (POST submit),
// which we couldn't capture because no sandbox is available to test it
// against. Source: FMN-203's capture against the operator's FortiGate
// tenant. Verify when the first non-FortiGate live commit runs.
out.create_server_template_submit_inherited_from_fortigate = {
  source: 'FMN-203 capture (FortiGate tenant)',
  reference: 'docs/api-discovery/template-create-from-device.md',
  assumption: 'Wire format is identical across Fabric device types. The template_type field is the main variable; check the create_template_defaults captures above for the per-type default before submitting.',
  body_shape_from_fortigate: {
    server_id: '<number>',
    template_name: '<string>',
    template_type: 'fabric_template',
    select_options: '"yes" | "no"',
    instance_grp_name: '<string>',
    notification_schedule: '<number>',
    element_ids: 'grp-<number>'
  },
  required_headers_from_fortigate: {
    'X-XSRF-Token': '<mirror of XSRF-TOKEN cookie>',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest'
  },
  open_question: 'Does FortiMonitor reject template_type=fabric_template on POST for FortiAP / FortiSwitch / FortiExtender and demand a per-class value (e.g. fortiap_template)? Will surface in Phase F as a 400 with the rejected field; recover by reading the default from get_create_server_template_data.'
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nwrote ${outPath}`);
console.log('HAND-REVIEW the JSON before sharing. Look for any tenant strings, customer names, IPs, or MACs the regex missed.');

// ---------- helpers ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--har' && argv[i + 1]) { out.har = argv[++i]; continue; }
    if (argv[i] === '--out' && argv[i + 1]) { out.out = argv[++i]; continue; }
    if (argv[i] === '-h' || argv[i] === '--help') { out.help = true; }
  }
  return out;
}

function summarize(entry, tenantOrigin, hostCounter) {
  const reqUrl = entry?.request?.url || '';
  const status = entry?.response?.status;
  const contentType = (entry?.response?.content?.mimeType || '').toLowerCase();
  const rawBody = entry?.response?.content?.text;
  let body = null;
  let bodyError = null;
  if (rawBody && contentType.includes('json')) {
    try {
      body = JSON.parse(rawBody);
    } catch (e) {
      bodyError = `JSON parse error: ${e.message}`;
    }
  } else if (rawBody && !contentType.includes('html')) {
    bodyError = `non-JSON content-type: ${contentType}`;
  } else if (!rawBody) {
    bodyError = 'response body absent in HAR (DevTools may have elided it; re-export with "Save all as HAR with content")';
  } else {
    bodyError = 'HTML response (likely SPA shell - auth wall or unsupported endpoint)';
  }

  // Build the redacted body. We project only the structural fields we
  // care about, so accidental sensitive content stays out by default.
  let projected = null;
  if (body && entry.request.url.includes('/report/get_idp_data')) {
    const fsd = (body.pageData || {}).fabricSystemData;
    const instance = (body.pageData || {}).instance || {};
    projected = {
      fabricSystemData: fsd ? cloneAndScrub(fsd, hostCounter) : null,
      instance_subset: {
        // FortiMonitor returns these as camelCase; reading snake_case
        // silently dropped them on every Fabric capture (FMN-211 QA).
        isFabric: instance.isFabric ?? null,
        deviceType: instance.deviceType ?? null,
        deviceSubType: instance.deviceSubType ?? null,
        hasOnsight: instance.hasOnsight ?? null,
        agentVersion: instance.agentVersion ?? null,
        status: instance.status ?? null,
        category: instance.category ?? null
      }
    };
  } else if (body && entry.request.url.includes('/report/get_monitoring_config_data')) {
    const added = ((body.categories || {}).added) || [];
    projected = {
      categories: added.map((cat) => ({
        category_textkey: cat.textkey ?? null,
        category_name_placeholder: '<category-name>',
        metric_count: Array.isArray(cat.metrics) ? cat.metrics.length : 0,
        metrics: (cat.metrics || []).map((m) => ({
          textkey: m.textkey ?? null,
          plugin_textkey: m.plugin_textkey ?? null,
          name: m.name ?? null,
          alert_items_count: Array.isArray(m.alert_items) ? m.alert_items.length : 0
        }))
      }))
    };
  } else if (body && entry.request.url.includes('/config/get_create_server_template_data')) {
    projected = cloneAndScrub(body, hostCounter);
  } else if (body) {
    projected = cloneAndScrub(body, hostCounter);
  }

  // URL placeholder so the scrubbed URL still shows the path shape
  // without the tenant origin or query-string params (which often
  // carry server_id, customer ids, etc.).
  const u = new URL(reqUrl);
  const pathOnly = `<TENANT>${u.pathname}${u.searchParams.toString() ? '?<query>' : ''}`;

  return {
    url_path: pathOnly,
    http_status: status,
    response_content_type: contentType,
    response_is_html: contentType.includes('html'),
    response_body_projected: projected,
    response_body_error: bodyError
  };
}

function cloneAndScrub(value, hostCounter) {
  // Deep clone via JSON to detach from the HAR.
  const cloned = JSON.parse(JSON.stringify(value));
  const cleaned = redact(cloned, hostCounter);
  // Then a final pass on the serialized text to replace anything regex
  // can catch (tenant hosts, IPs, MACs, long tokens) that survived the
  // structural walk.
  const text = JSON.stringify(cleaned);
  const scrubbed = scrubText(text);
  return JSON.parse(scrubbed);
}

function redact(obj, hostCounter) {
  if (Array.isArray(obj)) return obj.map((x) => redact(x, hostCounter));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const kl = k.toLowerCase();
      if (DROP_KEYS.has(kl)) continue;
      if (NAME_KEYS.has(kl) && typeof v === 'string' && v) {
        hostCounter[0]++;
        out[k] = `<host-${hostCounter[0]}>`;
        continue;
      }
      out[k] = redact(v, hostCounter);
    }
    return out;
  }
  return obj;
}

function scrubText(text) {
  return text
    .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g, '<ip6>')
    .replace(/\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b/g, '<mac>')
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, '<token>')
    .replace(/https?:\/\/[a-zA-Z0-9-]+\.fortimonitor[a-zA-Z0-9.\-]*/g, '<TENANT>');
}
