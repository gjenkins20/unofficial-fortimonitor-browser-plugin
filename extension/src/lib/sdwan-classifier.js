// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SD-WAN interface classifier (FMN-129).
//
// Ports the regex lists + extraction logic from the BPA Python script
// (fortimonitor_bpa/fortimonitor-sdwan-report.py.txt, lines 61-97 and
// 400-438) so the SD-WAN Report tool can decide whether a metric belongs
// to an overlay, underlay, or generic SD-WAN interface, and which of
// latency / jitter / loss it represents (when the metric is a FortiGate
// SNMP resource).
//
// Pure logic; no Chrome / fetch / DOM dependencies. Testable in Node.

export const SDWAN_OVERLAY_PATTERNS = [
  'overlay',
  'ipsec',
  'vpn',
  'tunnel',
  'vxlan',
  'gre',
  'ssl\\.root'
];

export const SDWAN_UNDERLAY_PATTERNS = [
  'underlay',
  'wan\\d*',
  'internet',
  'isp',
  'mpls',
  'lte',
  '4g',
  '5g',
  'broadband',
  'dsl',
  'fiber'
];

export const SDWAN_GENERIC_PATTERNS = [
  'sdwan',
  'sd.wan',
  'virtual.wan',
  'sd-wan\\s+link',
  'sd-wan\\s+sla',
  'sd-wan\\s+health'
];

const _OVERLAY_RE = SDWAN_OVERLAY_PATTERNS.map((p) => new RegExp(p, 'i'));
const _UNDERLAY_RE = SDWAN_UNDERLAY_PATTERNS.map((p) => new RegExp(p, 'i'));
const _GENERIC_RE = SDWAN_GENERIC_PATTERNS.map((p) => new RegExp(p, 'i'));

/**
 * Compile a custom set of patterns. Operator-supplied overrides flow
 * through this so the production defaults stay frozen as constants.
 *
 * @param {{ overlay?: string[], underlay?: string[], generic?: string[] }} patterns
 */
export function compilePatterns(patterns = {}) {
  const overlay = (patterns.overlay ?? SDWAN_OVERLAY_PATTERNS).map((p) => new RegExp(p, 'i'));
  const underlay = (patterns.underlay ?? SDWAN_UNDERLAY_PATTERNS).map((p) => new RegExp(p, 'i'));
  const generic = (patterns.generic ?? SDWAN_GENERIC_PATTERNS).map((p) => new RegExp(p, 'i'));
  return { overlay, underlay, generic };
}

/**
 * Classify an interface name string. Returns 'overlay' | 'underlay' |
 * 'generic' | null. Generic patterns are checked first so that explicit
 * SD-WAN-named metrics (e.g. "SD-WAN Link Packet Loss") don't get
 * absorbed by 'underlay' via "wan" before the generic match runs - the
 * Python source does the same.
 *
 * @param {string} name
 * @param {{ overlay: RegExp[], underlay: RegExp[], generic: RegExp[] }} [compiled]
 * @returns {'overlay'|'underlay'|'generic'|null}
 */
export function classifyInterface(name, compiled) {
  if (name == null) return null;
  const text = String(name);
  const sets = compiled ?? { overlay: _OVERLAY_RE, underlay: _UNDERLAY_RE, generic: _GENERIC_RE };
  for (const re of sets.generic) if (re.test(text)) return 'generic';
  for (const re of sets.overlay) if (re.test(text)) return 'overlay';
  for (const re of sets.underlay) if (re.test(text)) return 'underlay';
  return null;
}

/**
 * Pull the trailing interface/device segment from a Panopta metric name,
 * mirroring extract_interface_from_metric() in the Python source.
 *
 * Panopta agent_resource names follow:
 *   "Bandwidth: kb in/sec - enX0"
 *   "Bandwidth: kb out/sec - wan1"
 *   "Disk: disk % used - /dev/root mounted at /"
 *
 * SNMP resource formatted_name follow:
 *   "SD-WAN Link Packet Loss Google_DNS - wan1"
 *   "SD-WAN Link Jitter Google_DNS - wan1"
 *
 * Returns the suffix after the LAST " - "; for disk metrics, strips the
 * "mounted at ..." tail. Returns '' when no separator is present.
 *
 * @param {object} metric
 */
export function extractInterfaceCandidate(metric) {
  if (!metric || typeof metric !== 'object') return '';
  const name = String(metric.formatted_name ?? metric.name ?? '');
  if (!name.includes(' - ')) return '';
  const idx = name.lastIndexOf(' - ');
  let suffix = name.slice(idx + 3).trim();
  const mountIdx = suffix.indexOf(' mounted at ');
  if (mountIdx >= 0) suffix = suffix.slice(0, mountIdx).trim();
  return suffix;
}

/**
 * Classify a metric record. Tries the interface-suffix candidate first,
 * then the full name, then the metric's `label` and `description` fields.
 * Returns { interfaceName, classification } where classification is one
 * of 'overlay' | 'underlay' | 'generic' | null. Mirrors the Python
 * source's fallback chain.
 *
 * @param {object} metric
 * @param {{ overlay: RegExp[], underlay: RegExp[], generic: RegExp[] }} [compiled]
 */
export function classifyMetric(metric, compiled) {
  if (!metric || typeof metric !== 'object') return { interfaceName: '', classification: null };
  const candidate = extractInterfaceCandidate(metric);
  const fullName = String(metric.formatted_name ?? metric.name ?? '');
  const tries = [candidate, fullName, String(metric.label ?? ''), String(metric.description ?? '')];
  for (const t of tries) {
    if (!t) continue;
    const cls = classifyInterface(t, compiled);
    if (cls) return { interfaceName: candidate || t, classification: cls };
  }
  return { interfaceName: candidate, classification: null };
}

/**
 * Map a FortiGate SD-WAN MIB OID to its SLA metric type.
 *
 * OID subtree 1.3.6.1.4.1.12356.101.4.9.2.1:
 *   .4  -> latency      .5  -> jitter      .9  -> packet loss
 *
 * Returns 'latency' | 'jitter' | 'loss' | null.
 *
 * @param {string} oid
 */
export function classifyOidMetricType(oid) {
  if (oid == null) return null;
  const s = String(oid);
  if (s.includes('.4.9.2.1.9.')) return 'loss';
  if (s.includes('.4.9.2.1.4.')) return 'latency';
  if (s.includes('.4.9.2.1.5.')) return 'jitter';
  return null;
}
