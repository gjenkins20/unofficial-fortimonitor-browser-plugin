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
// MVP signature definition (exact match, threshold === 1.0):
//   cluster = (Make, Model, sorted set of resource keys, threshold
//             signature per resource, sorted port indices)
//
// FMN-209: Loosened clustering via Jaccard similarity on resource sets
// (threshold < 1.0). Devices still must share Make+Model. Within a
// (Make, Model) group, devices are clustered greedily in input order:
// the first device seeds the cluster as its representative, and each
// subsequent device joins if Jaccard(repKeys, deviceKeys) >= threshold,
// otherwise it seeds a new cluster. Threshold-equality and port-scope
// are recorded per-member as metadata but do NOT gate Jaccard merging;
// the operator picks a `resource_strategy` (intersection or union) in
// the UI to decide which resource set becomes the proposed template.

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
 * @typedef {Object} MemberSnapshot
 * @property {number|string} server_id
 * @property {string|null} device_name
 * @property {string[]} resource_keys             Sorted resource keys for
 *                                                this member.
 * @property {(number|string)[]|null} port_keys   Sorted port keys, or null.
 * @property {Record<string,string>} threshold_signature_by_resource
 * @property {number} jaccard_to_representative   Jaccard similarity of
 *                                                this device's resource
 *                                                set to the cluster
 *                                                representative's set
 *                                                (1.0 for the seed and
 *                                                in exact-match mode).
 * @property {string} rationale                   Human-readable reason
 *                                                this device joined or
 *                                                seeded this cluster.
 *
 * @typedef {Object} Cluster
 * @property {string} key                     Stable cluster identity.
 * @property {string} make
 * @property {string} model
 * @property {(number|string)[]} applies_to_server_ids
 * @property {string[]} resource_signature       Sorted resource keys for
 *                                                the cluster's representative
 *                                                (back-compat field; in
 *                                                exact-match mode this is
 *                                                also the union and the
 *                                                intersection).
 * @property {string[]} resource_union            Union of resource keys
 *                                                across all members.
 * @property {string[]} resource_intersection    Intersection of resource
 *                                                keys across all members.
 *                                                Equals union when only
 *                                                one member.
 * @property {"intersection"|"union"} resource_strategy
 *   Default 'union' (broader coverage). UI flips per cluster.
 *   Action descriptor reads this to pick proposed_resources content
 *   when not using clone-from-device.
 * @property {(number|string)[]|null} port_signature  Sorted port keys
 *                                                for the representative,
 *                                                or null.
 * @property {Record<string,string>} threshold_signature_by_resource
 *                                                Representative's
 *                                                threshold sigs.
 * @property {MemberSnapshot[]} member_signatures  Per-device snapshots
 *                                                so UI can show ranges
 *                                                (resource counts, port
 *                                                scopes) for the cluster.
 * @property {string} proposed_template_name
 * @property {ProposedResource[]} proposed_resources
 *                                                Always reflects
 *                                                resource_strategy.
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
  const threshold = clampThreshold(options.threshold);
  const resourceStrategy = options.resourceStrategy === 'intersection' ? 'intersection' : 'union';

  const sigs = [];
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
    sigs.push({ device, sig });
  }

  const clusters = threshold >= 1.0
    ? clusterExact(sigs, resourceStrategy)
    : clusterJaccard(sigs, threshold, resourceStrategy);

  return { clusters, unclassified };
}

function clampThreshold(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return 1.0;
  if (t < 0) return 0;
  if (t > 1) return 1.0;
  return t;
}

function clusterExact(sigs, resourceStrategy) {
  const byKey = new Map();
  for (const { device, sig } of sigs) {
    const key = makeClusterKey(sig);
    let cluster = byKey.get(key);
    let isSeed = false;
    if (!cluster) {
      cluster = newCluster(sig, device, key, resourceStrategy);
      cluster.__rep_keys_set = sig.resKeysSet;
      byKey.set(key, cluster);
      isSeed = true;
    }
    addMember(cluster, device, sig, {
      jaccard: 1.0,
      rationale: isSeed
        ? 'Seeded cluster (exact-match mode: same Make+Model + identical resource/threshold/port signature)'
        : 'Identical signature to representative (Make+Model+resources+thresholds+ports all match)'
    });
  }
  for (const cluster of byKey.values()) {
    delete cluster.__rep_keys_set;
    finalizeCluster(cluster, resourceStrategy);
  }
  return [...byKey.values()];
}

function clusterJaccard(sigs, threshold, resourceStrategy) {
  // Greedy single-pass within each (make, model) bucket. The first
  // device in a bucket seeds the cluster; subsequent devices join the
  // first cluster whose representative's resource set is >= threshold
  // Jaccard-similar to theirs, otherwise seed a new cluster. Bucket
  // ordering preserves input order so the same devices always cluster
  // the same way given the same threshold.
  const buckets = new Map();   // "make::model" -> Cluster[]
  for (const { device, sig } of sigs) {
    const bucketKey = `${sig.make}${CLUSTER_KEY_SEPARATOR}${sig.model}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = [];
      buckets.set(bucketKey, bucket);
    }
    let target = null;
    let bestScore = -1;
    for (const cluster of bucket) {
      const score = jaccard(cluster.__rep_keys_set, sig.resKeysSet);
      if (score >= threshold && score > bestScore) {
        target = cluster;
        bestScore = score;
      }
    }
    let isSeed = false;
    let memberJaccard;
    let memberRationale;
    if (!target) {
      const idx = bucket.length;
      const key = `${bucketKey}${CLUSTER_KEY_SEPARATOR}j::${idx}`;
      target = newCluster(sig, device, key, resourceStrategy);
      target.__rep_keys_set = sig.resKeysSet;
      bucket.push(target);
      isSeed = true;
      memberJaccard = 1.0;
      memberRationale = bucket.length === 1 && sig.resKeysSet.size === 0
        ? `Seeded cluster (no current monitoring config; cannot Jaccard-merge with non-empty clusters at threshold ${threshold.toFixed(2)})`
        : `Seeded cluster (no existing cluster met Jaccard threshold ${threshold.toFixed(2)} for same Make+Model)`;
    } else {
      memberJaccard = bestScore;
      memberRationale = `Joined cluster: Jaccard ${bestScore.toFixed(2)} with representative resource set ≥ threshold ${threshold.toFixed(2)} (same Make+Model)`;
    }
    addMember(target, device, sig, { jaccard: memberJaccard, rationale: memberRationale });
    void isSeed;
  }
  const all = [];
  for (const bucket of buckets.values()) {
    for (const cluster of bucket) {
      delete cluster.__rep_keys_set;
      finalizeCluster(cluster, resourceStrategy);
      all.push(cluster);
    }
  }
  return all;
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  let intersection = 0;
  for (const k of setA) if (setB.has(k)) intersection++;
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 1.0;
  return intersection / union;
}

function addMember(cluster, device, sig, { jaccard = 1.0, rationale = '' } = {}) {
  cluster.applies_to_server_ids.push(device.id);
  cluster.member_signatures.push({
    server_id: device.id,
    device_name: device.name ?? null,
    resource_keys: [...sig.resKeys],
    port_keys: sig.portKeys === null ? null : [...sig.portKeys],
    threshold_signature_by_resource: Object.fromEntries(sig.resourcesByKey),
    jaccard_to_representative: jaccard,
    rationale
  });
  // Track per-resource metric metadata once per cluster so we can build
  // proposed_resources for the union later. First sighting wins.
  for (const [rk, m] of sig.sampleMetricByResource) {
    if (!cluster.__sample_metric_by_resource.has(rk)) {
      cluster.__sample_metric_by_resource.set(rk, m);
      cluster.__category_textkey_by_resource.set(rk, sig.categoryTextkeyByResource.get(rk) ?? null);
      cluster.__threshold_sig_by_resource.set(rk, sig.resourcesByKey.get(rk) ?? '');
    }
  }
}

function finalizeCluster(cluster, resourceStrategy) {
  const memberCount = cluster.member_signatures.length;
  // Union of all members' resource keys
  const unionSet = new Set();
  for (const m of cluster.member_signatures) {
    for (const k of m.resource_keys) unionSet.add(k);
  }
  // Intersection: keys present in every member
  let intersectionSet;
  if (memberCount === 0) {
    intersectionSet = new Set();
  } else {
    intersectionSet = new Set(cluster.member_signatures[0].resource_keys);
    for (let i = 1; i < memberCount; i++) {
      const keys = new Set(cluster.member_signatures[i].resource_keys);
      for (const k of [...intersectionSet]) {
        if (!keys.has(k)) intersectionSet.delete(k);
      }
    }
  }
  cluster.resource_union = [...unionSet].sort();
  cluster.resource_intersection = [...intersectionSet].sort();
  const buildResources = (keys) => keys.map((rk) => {
    const m = cluster.__sample_metric_by_resource.get(rk);
    const alertItems = Array.isArray(m?.alert_items) ? deepClone(m.alert_items) : [];
    return {
      plugin_textkey: cluster.__category_textkey_by_resource.get(rk) ?? null,
      resource_textkey: rk,
      name: trimOrEmpty(m?.name) || rk,
      alert_items: alertItems
    };
  });
  cluster.proposed_resources_union = buildResources(cluster.resource_union);
  cluster.proposed_resources_intersection = buildResources(cluster.resource_intersection);
  cluster.proposed_resources = resourceStrategy === 'intersection'
    ? cluster.proposed_resources_intersection
    : cluster.proposed_resources_union;
  delete cluster.__sample_metric_by_resource;
  delete cluster.__category_textkey_by_resource;
  delete cluster.__threshold_sig_by_resource;
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
  const resKeysSet = new Set(resKeys);
  const portKeys = Array.isArray(device.port_scope)
    ? [...device.port_scope].map(String).sort()
    : null;

  return {
    make,
    model,
    resKeys,
    resKeysSet,
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

function newCluster(sig, sampleDevice, key, resourceStrategy) {
  return {
    key,
    make: sig.make,
    model: sig.model,
    applies_to_server_ids: [],
    resource_signature: [...sig.resKeys],
    resource_union: [],          // filled by finalizeCluster
    resource_intersection: [],   // filled by finalizeCluster
    resource_strategy: resourceStrategy,
    port_signature: sig.portKeys === null ? null : [...sig.portKeys],
    threshold_signature_by_resource: Object.fromEntries(sig.resourcesByKey),
    member_signatures: [],
    proposed_template_name: `${sig.make} ${sig.model} Best Practice`,
    proposed_resources: [],      // filled by finalizeCluster
    sample_device_id: sampleDevice.id,
    __sample_metric_by_resource: new Map(),
    __category_textkey_by_resource: new Map(),
    __threshold_sig_by_resource: new Map()
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
