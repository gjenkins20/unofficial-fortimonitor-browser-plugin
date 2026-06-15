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

  // node id -> human location name, from inventory.monitoring_nodes (the
  // ObservationsFetcher collects this; the find-delete-duplicates handler
  // passes it too). Used to resolve each server's Monitoring Location.
  const nodeNameById = buildMonitoringNodeMap(inventory.monitoring_nodes);

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
      location: resolveLocation(s, nodeNameById)
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

// Build a { nodeId(string) -> location name } map from inventory.monitoring_nodes
// ([{ url, name, ... }]). Items carry `url` (.../monitoring_node/{id}) not id.
function buildMonitoringNodeMap(nodes) {
  const map = new Map();
  if (!Array.isArray(nodes)) return map;
  for (const n of nodes) {
    const id = n?.id != null && n.id !== '' ? String(n.id) : extractTrailingId(n?.url);
    if (id == null) continue;
    if (typeof n?.name === 'string' && n.name) map.set(String(id), n.name);
  }
  return map;
}

// Resolve a server's Monitoring Location name from its primary_monitoring_node
// (a /v2/monitoring_node/{id} URL) via the node map. '' when unresolvable.
function resolveLocation(server, nodeNameById) {
  const nid = extractTrailingId(server?.primary_monitoring_node);
  if (nid == null) return '';
  return nodeNameById.get(String(nid)) || '';
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
