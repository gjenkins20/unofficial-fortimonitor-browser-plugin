// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Device fingerprint - deterministic hash over the port scope state.
//
// Two devices that return the same { port_name, admin_status, oper_status }
// tuple set produce the same fingerprint, regardless of the order the
// FortiMonitor API returned them in. One operator decision per fingerprint
// is the core scale mechanism (see FMN-38 mockups).
//
// Uses SubtleCrypto (available in both service workers and Node's
// webcrypto) so this module runs unchanged under test and in production.

async function getSubtle() {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
  const nodeCrypto = await import('node:crypto');
  return nodeCrypto.webcrypto.subtle;
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function normalizeStatus(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().toLowerCase();
}

/**
 * Produce a canonical string form of a port tuple set. Exported for tests
 * so the canonicalization can be inspected without hashing.
 */
export function canonicalizePorts(ports) {
  if (!Array.isArray(ports)) return '';
  const rows = ports.map((p) => ({
    name: String(p.name ?? ''),
    admin: normalizeStatus(p.admin_status),
    oper: normalizeStatus(p.oper_status)
  }));
  rows.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  return rows.map((r) => `${r.name}|${r.admin}|${r.oper}`).join('\n');
}

/**
 * Compute a stable hex SHA-256 fingerprint over a device's port scope.
 */
export async function fingerprintDevice({ ports }) {
  const canonical = canonicalizePorts(ports);
  const data = new TextEncoder().encode(canonical);
  const subtle = await getSubtle();
  const digest = await subtle.digest('SHA-256', data);
  return toHex(digest);
}
