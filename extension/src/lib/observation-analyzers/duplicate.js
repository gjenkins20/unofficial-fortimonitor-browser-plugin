// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// DuplicateAnalyzer.
//
// Flags likely-duplicate instances in a tenant: distinct /v2/server
// records that share a normalized name OR a normalized primary address
// (fqdn). Same device re-onboarded, or monitored twice, shows up as two
// server records with the same name or address - this surfaces them so an
// operator can consolidate.
//
// Pure function over the ObservationsInventory (no IO, no DOM, no chrome.*),
// matching the FMN-132 analyzer contract. Reads ONLY the top-level
// inventory.servers list, so it needs neither deep mode nor frontend
// augmentation - name and fqdn are both present on the shallow /v2/server
// records. Serial / model are NOT on the shallow list (they need deep
// fields or get_idp_data); a serial axis is a deliberate future follow-up,
// not part of this pass.

import { rowName, extractTrailingId, groupBy } from './_helpers.js';

/**
 * @typedef {Object} DuplicateMember
 * @property {string} id
 * @property {string} name
 * @property {string} address     primary address / fqdn, '' when absent
 */

/**
 * @typedef {Object} DuplicateGroup
 * @property {'name'|'address'} axis   the field the members collide on
 * @property {string} value            the shared (display-cased) value
 * @property {number} count            number of distinct instances in the group
 * @property {DuplicateMember[]} members
 */

/**
 * @typedef {Object} DuplicateResult
 * @property {boolean} available
 * @property {string} [note]
 * @property {DuplicateGroup[]} [groups]
 * @property {{ total_groups:number, instances_involved:number, by_name:number, by_address:number, servers_scanned:number }} [summary]
 */

/**
 * @param {Object} inventory  ObservationsInventory from the ObservationsFetcher
 * @returns {DuplicateResult}
 */
export function analyzeDuplicates(inventory = {}) {
  const servers = Array.isArray(inventory.servers) ? inventory.servers : [];
  if (servers.length === 0) {
    return {
      available: false,
      note: 'No instances in the inventory to scan for duplicates.'
    };
  }

  // Monitoring Location resolution. `primary_monitoring_node` is POLYMORPHIC:
  // it points at /v2/<type>/<id> where <type> is the collector kind -
  // monitoring_node (FortiMonitor Cloud location), onsight (OnSight appliance),
  // fortimanager, etc. We build a { "<type>/<id>" -> name } map from every
  // source list the caller supplied (monitoring_nodes + onsights) plus any
  // pre-resolved map (the find handler GETs unknown collector types directly).
  const sourceNameByKey = buildMonitoringSourceMap(inventory);

  // Normalize each server to { id, name, address, created, location } once.
  // Records without a resolvable id are dropped: we cannot tell two real
  // instances apart from one record counted twice without a stable identity.
  const records = [];
  for (const s of servers) {
    const id = s?.id != null && s.id !== '' ? String(s.id) : extractTrailingId(s?.url);
    if (id == null) continue;
    records.push({
      id: String(id),
      name: rowName(s, ''),
      address: typeof s?.fqdn === 'string' ? s.fqdn.trim() : '',
      created: toCreatedDate(s?.created),
      location: resolveLocation(s, sourceNameByKey)
    });
  }

  const groups = [
    ...findGroups(records, 'name', (r) => r.name),
    ...findGroups(records, 'address', (r) => r.address)
  ];

  // Stable, useful ordering: biggest clusters first, then name axis before
  // address axis, then alphabetical by the shared value.
  groups.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.axis !== b.axis) return a.axis === 'name' ? -1 : 1;
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });

  const involved = new Set();
  for (const g of groups) for (const m of g.members) involved.add(m.id);

  return {
    available: true,
    groups,
    summary: {
      total_groups: groups.length,
      instances_involved: involved.size,
      by_name: groups.filter((g) => g.axis === 'name').length,
      by_address: groups.filter((g) => g.axis === 'address').length,
      servers_scanned: records.length
    }
  };
}

/**
 * Group records by a normalized key and keep only the collisions (>=2
 * DISTINCT instance ids sharing a non-empty value). Dedupe members by id so
 * a record that appears twice in the list cannot fabricate a "duplicate".
 */
function findGroups(records, axis, valueOf) {
  const buckets = groupBy(records, (r) => {
    const raw = valueOf(r);
    const norm = normalize(raw);
    return norm || null; // groupBy drops null keys -> empties never group
  });
  const out = [];
  for (const [, members] of buckets) {
    const byId = new Map();
    for (const m of members) if (!byId.has(m.id)) byId.set(m.id, m);
    if (byId.size < 2) continue;
    const list = [...byId.values()];
    // Monitoring-location discriminator (FMN-274): members polled from the SAME
    // location and sharing a name/address are likely an accidental duplicate;
    // members in DIFFERENT locations are likely intentional (two deliberate
    // monitoring paths). likely_intentional = >=2 distinct KNOWN locations.
    const distinctLocations = new Set(list.map((m) => m.location).filter(Boolean));
    out.push({
      axis,
      // Show the value as it appears on the first member, not the
      // lowercased key, so the operator sees real casing.
      value: axis === 'name' ? (list[0].name || '(no name)') : (list[0].address || '(no address)'),
      count: byId.size,
      likely_intentional: distinctLocations.size >= 2,
      members: list.map((m) => ({ id: m.id, name: m.name || '(no name)', address: m.address, created: m.created || '', location: m.location || '' }))
    });
  }
  return out;
}

// Extract the "<type>/<id>" key from a /v2/<type>/<id> resource URL (e.g.
// "onsight/17887", "monitoring_node/632"). null when not a v2 resource URL.
function sourceKey(url) {
  if (typeof url !== 'string') return null;
  const m = /\/v2\/([a-z_]+)\/(\d+)/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Build a { "<type>/<id>" -> collector name } map from every monitoring-source
// list the caller provided (monitoring_nodes + onsights), plus an optional
// pre-resolved inventory.monitoring_source_names (keyed by URL or "<type>/<id>")
// that the find handler builds for collector types without a list endpoint.
function buildMonitoringSourceMap(inventory) {
  const map = new Map();
  const explicit = inventory?.monitoring_source_names;
  if (explicit) {
    const entries = explicit instanceof Map ? explicit.entries() : Object.entries(explicit);
    for (const [k, v] of entries) {
      const key = sourceKey(k) || String(k);
      if (typeof v === 'string' && v) map.set(key, v);
    }
  }
  const addAll = (list) => {
    for (const item of (Array.isArray(list) ? list : [])) {
      const key = sourceKey(item?.url);
      if (key && typeof item?.name === 'string' && item.name && !map.has(key)) map.set(key, item.name);
    }
  };
  addAll(inventory?.monitoring_nodes);
  addAll(inventory?.onsights);
  return map;
}

// Resolve a server's Monitoring Location (the collector/proxy it is polled
// through) from its polymorphic primary_monitoring_node URL. '' when the
// collector isn't in the map (or the instance is agent-monitored: null URL).
function resolveLocation(server, sourceNameByKey) {
  const key = sourceKey(server?.primary_monitoring_node);
  return key ? (sourceNameByKey.get(key) || '') : '';
}

function normalize(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

// Normalize the /v2/server `created` field (RFC-2822, e.g.
// "Thu, 12 Dec 2024 01:33:48 -0000") to a YYYY-MM-DD date string. Returns ''
// when absent or unparseable.
function toCreatedDate(v) {
  if (typeof v !== 'string' || !v) return '';
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}
