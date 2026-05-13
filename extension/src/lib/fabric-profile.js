// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-195: Fabric device profile classifier.
//
// Pure logic; no Chrome / fetch / DOM dependencies. Testable in Node.
//
// A "profile" is uniquely identified by (Make, Model, ConnectionType).
// Each profile becomes one template recommendation + one Monitoring Policy
// proposal downstream. ConnectionType is fixed at "Fabric" for FMN-195;
// SNMP and others are deferred to FMN-197.
//
// Make and Model come from FortiMonitor's live `fabricSystemData` blob
// (harvested from /report/get_idp_data per project memory
// idp_data_field_path_findings.md). The toolkit hard-codes NO device
// vocabulary - new Fortinet product families or models are picked up
// automatically the moment FortiMonitor exposes them on this endpoint.

export const CONNECTION_TYPE_FABRIC = 'Fabric';

/**
 * Build a per-profile classification from server records + their
 * fabricSystemData blobs.
 *
 * @param {Array<{id?: number|string, url?: string, name?: string}>} servers
 * @param {Map<number|string, object> | Record<string, object>} fabricSystemDataByServerId
 * @returns {{
 *   profiles: Map<string, {
 *     key: string,
 *     make: string,
 *     model: string,
 *     connection_type: 'Fabric',
 *     server_ids: number[],
 *     os_versions: string[]
 *   }>,
 *   unclassified: Array<{server: any, reason: string}>
 * }}
 */
export function buildFabricProfile(servers, fabricSystemDataByServerId) {
  const profiles = new Map();
  const unclassified = [];
  const lookup = normalizeLookup(fabricSystemDataByServerId);

  for (const server of (servers ?? [])) {
    const serverId = extractServerId(server);
    if (serverId == null) {
      unclassified.push({ server, reason: 'missing server id' });
      continue;
    }

    const fsd = lookup.get(String(serverId));
    if (!fsd || typeof fsd !== 'object') {
      unclassified.push({ server, reason: 'no fabricSystemData (non-Fabric or pre-fetch)' });
      continue;
    }

    const make = trimOrEmpty(fsd.model_name);
    const model = trimOrEmpty(fsd.model_number);
    if (!make || !model) {
      unclassified.push({ server, reason: 'fabricSystemData missing model_name or model_number' });
      continue;
    }

    const key = profileKey(make, model, CONNECTION_TYPE_FABRIC);
    let entry = profiles.get(key);
    if (!entry) {
      entry = {
        key,
        make,
        model,
        connection_type: CONNECTION_TYPE_FABRIC,
        server_ids: [],
        os_versions: []
      };
      profiles.set(key, entry);
    }
    entry.server_ids.push(serverId);

    const osVersion = trimOrEmpty(fsd.os_version);
    if (osVersion && !entry.os_versions.includes(osVersion)) {
      entry.os_versions.push(osVersion);
    }
  }

  return { profiles, unclassified };
}

export const PROFILE_KEY_SEPARATOR = '::';

/**
 * Canonical profile key. Inverse: parseProfileKey().
 */
export function profileKey(make, model, connectionType) {
  return `${make}${PROFILE_KEY_SEPARATOR}${model}${PROFILE_KEY_SEPARATOR}${connectionType}`;
}

/**
 * Parse a profile key back into its parts.
 * @returns {{ make: string, model: string, connection_type: string } | null}
 */
export function parseProfileKey(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split(PROFILE_KEY_SEPARATOR);
  if (parts.length !== 3) return null;
  return { make: parts[0], model: parts[1], connection_type: parts[2] };
}

// ---------- helpers ----------

function trimOrEmpty(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function extractServerId(server) {
  if (server == null) return null;
  if (typeof server.id === 'number') return server.id;
  if (typeof server.id === 'string' && server.id.trim() !== '') {
    const n = Number(server.id);
    return Number.isFinite(n) ? n : server.id;
  }
  if (typeof server.url === 'string') {
    const m = server.url.match(/\/server\/(\d+)\/?$/);
    if (m) return Number(m[1]);
  }
  return null;
}

function normalizeLookup(raw) {
  if (raw instanceof Map) {
    const m = new Map();
    for (const [k, v] of raw) m.set(String(k), v);
    return m;
  }
  const m = new Map();
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) m.set(String(k), v);
  }
  return m;
}
