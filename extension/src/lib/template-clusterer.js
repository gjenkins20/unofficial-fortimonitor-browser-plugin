// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-200: Template clusterer.
//
// Pure logic; no Chrome / fetch / DOM dependencies. Testable in Node.
//
// Given a list of devices (each carrying fabricSystemData + the
// monitoring_config they currently have + optional port scope), groups
// them into clusters by configuration signature. Each cluster maps to
// ONE proposed template: same metrics, same thresholds, same port scope,
// same (Make, Model). The Bulk Composer action (Phase D) renders one
// row per cluster, lets the operator opt in/out, and on commit creates
// the template + attaches it to the cluster's members.
//
// MVP signature definition (exact match):
//   cluster = (Make, Model, sorted set of resource keys, threshold
//             signature per resource, sorted port indices)
//
// Looser clustering (Jaccard similarity below 1.0 etc.) is a follow-up.
// The current pass treats any difference as a new cluster.

/**
 * @typedef {Object} Metric
 * @property {string} [textkey]   Canonical resource identity (FMN-203
 *                                catalog uses `plugin_textkey` +
 *                                `resource_textkey`; on read-side
 *                                `get_monitoring_config_data` metric
 *                                records, the textkey appears at metric
 *                                level when available).
 * @property {string} name        Display name (fallback identity).
 * @property {Array<*>} [alert_items]  Threshold tuples; signature
 *                                computed from the full array.
 *
 * @typedef {Object} Category
 * @property {string} [textkey]   FortiMonitor category textkey
 *                                (e.g. "fortinet.fortigate"). Used as
 *                                the `plugin_textkey` for the write side.
 * @property {string} name
 * @property {Metric[]} metrics
 *
 * @typedef {Object} FabricSystemData
 * @property {string} [model_name]
 * @property {string} [model_number]
 * @property {string} [os_version]
 *
 * @typedef {Object} Device
 * @property {number|string} id
 * @property {string} [name]
 * @property {FabricSystemData} [fabricSystemData]
 * @property {Category[]|null} [monitoring_config]   `categories.added`
 *                                                  from FMN-135 read.
 * @property {Array<number|string>|null} [port_scope]  Selected port
 *                                                  indices/names from
 *                                                  FMN-36 getDevicePorts.
 *                                                  Null on non-FortiGate.
 *
 * @typedef {Object} ProposedResource
 * @property {string|null} plugin_textkey   Category textkey
 *                                          (FMN-203 write field).
 * @property {string} resource_textkey      Per-metric textkey or fallback.
 * @property {string} name
 * @property {Array<*>} alert_items
 *
 * @typedef {Object} Cluster
 * @property {string} key                     Stable cluster identity.
 * @property {string} make
 * @property {string} model
 * @property {(number|string)[]} applies_to_server_ids
 * @property {string[]} resource_signature       Sorted resource keys.
 * @property {(number|string)[]|null} port_signature  Sorted port keys,
 *                                                or null when input was null.
 * @property {Record<string,string>} threshold_signature_by_resource
 * @property {string} proposed_template_name
 * @property {ProposedResource[]} proposed_resources
 * @property {number|string} sample_device_id     Representative device
 *                                                (used by callers that
 *                                                want the clone-from-device
 *                                                path on the wire).
 *
 * @typedef {Object} ClusterOutput
 * @property {Cluster[]} clusters
 * @property {Array<{device: any, reason: string}>} unclassified
 */

export const CLUSTER_KEY_SEPARATOR = '::';

/**
 * Cluster devices by configuration signature.
 *
 * @param {Device[]} devices
 * @param {Object} [options]
 * @param {(metric: Metric) => string} [options.resourceKey]
 *   Extracts the canonical identity for a metric. Default prefers
 *   `metric.textkey`, falls back to `metric.name`.
 * @param {(metric: Metric) => string} [options.thresholdSignature]
 *   Stable canonical form of a metric's threshold tuples. Default
 *   JSON-stringifies `alert_items`.
 * @returns {ClusterOutput}
 */
export function buildTemplateClusters(devices, options = {}) {
  const resourceKey = options.resourceKey ?? defaultResourceKey;
  const thresholdSig = options.thresholdSignature ?? defaultThresholdSignature;

  const clusters = new Map();
  const unclassified = [];

  for (const device of (devices ?? [])) {
    if (device == null || device.id === undefined || device.id === null) {
      unclassified.push({ device, reason: 'missing device id' });
      continue;
    }
    const make = trimOrEmpty(device.fabricSystemData?.model_name);
    const model = trimOrEmpty(device.fabricSystemData?.model_number);
    if (!make || !model) {
      unclassified.push({ device, reason: 'no fabricSystemData make/model' });
      continue;
    }

    const sig = buildDeviceSignature(device, { resourceKey, thresholdSig, make, model });
    const key = makeClusterKey(sig);

    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = newCluster(sig, device, key);
      clusters.set(key, cluster);
    }
    cluster.applies_to_server_ids.push(device.id);
  }

  return { clusters: [...clusters.values()], unclassified };
}

// ---------- internals ----------

function buildDeviceSignature(device, { resourceKey, thresholdSig, make, model }) {
  const resourcesByKey = new Map();   // resource key -> threshold signature
  const categoryTextkeyByResource = new Map();  // resource key -> plugin_textkey
  const sampleMetricByResource = new Map();     // resource key -> first metric obj

  for (const cat of (device.monitoring_config || [])) {
    for (const m of (cat?.metrics || [])) {
      if (!m) continue;
      const rk = resourceKey(m);
      if (!rk) continue;
      if (resourcesByKey.has(rk)) continue; // first sighting wins (stable)
      resourcesByKey.set(rk, thresholdSig(m));
      categoryTextkeyByResource.set(rk, cat?.textkey ?? null);
      sampleMetricByResource.set(rk, m);
    }
  }

  const resKeys = [...resourcesByKey.keys()].sort();
  const portKeys = Array.isArray(device.port_scope)
    ? [...device.port_scope].map(String).sort()
    : null;

  return {
    make,
    model,
    resKeys,
    resourcesByKey,
    categoryTextkeyByResource,
    sampleMetricByResource,
    portKeys
  };
}

function makeClusterKey({ make, model, resKeys, resourcesByKey, portKeys }) {
  const resPart = resKeys.join(',');
  const tsPart = resKeys.map((rk) => resourcesByKey.get(rk) || '').join(';');
  const portPart = portKeys === null ? 'none' : portKeys.join(',');
  return [
    make,
    model,
    `r=${resPart}`,
    `t=${shortHash(tsPart)}`,
    `p=${portPart}`
  ].join(CLUSTER_KEY_SEPARATOR);
}

function newCluster(sig, sampleDevice, key) {
  const proposed_resources = sig.resKeys.map((rk) => {
    const m = sig.sampleMetricByResource.get(rk);
    const alertItems = Array.isArray(m?.alert_items) ? deepClone(m.alert_items) : [];
    return {
      plugin_textkey: sig.categoryTextkeyByResource.get(rk) ?? null,
      resource_textkey: rk,
      name: trimOrEmpty(m?.name) || rk,
      alert_items: alertItems
    };
  });
  return {
    key,
    make: sig.make,
    model: sig.model,
    applies_to_server_ids: [],
    resource_signature: [...sig.resKeys],
    port_signature: sig.portKeys === null ? null : [...sig.portKeys],
    threshold_signature_by_resource: Object.fromEntries(sig.resourcesByKey),
    proposed_template_name: `${sig.make} ${sig.model} Best Practice`,
    proposed_resources,
    sample_device_id: sampleDevice.id
  };
}

function defaultResourceKey(metric) {
  if (!metric) return '';
  if (typeof metric.textkey === 'string' && metric.textkey.trim()) return metric.textkey.trim();
  if (typeof metric.name === 'string' && metric.name.trim()) return metric.name.trim();
  return '';
}

function defaultThresholdSignature(metric) {
  const items = Array.isArray(metric?.alert_items) ? metric.alert_items : [];
  // Canonical JSON: items kept in their captured order. FortiMonitor
  // returns them in a stable order per-metric, so we don't sort here.
  return JSON.stringify(items);
}

function trimOrEmpty(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function shortHash(s) {
  // Cheap deterministic ~7-char base36 hash. Used only to bound the
  // cluster key length when threshold strings are long. Not crypto.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function deepClone(v) {
  if (v == null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v));
}
