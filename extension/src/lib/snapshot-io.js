// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-161: snapshot export / import envelope + filename derivation.
//
// The envelope is intentionally separate from the snapshot's internal
// `schema` field. The snapshot shape is owned by observations-snapshots.js; this
// module just decides how that shape is packaged for transport between
// extension installs. Bumping the file format is decoupled from bumping
// the snapshot schema.
//
// Envelope shape (formatVersion=1):
//   {
//     format: 'fmn-toolkit-snapshot',
//     formatVersion: 1,
//     exportedAt: '<ISO timestamp>',
//     extensionVersion: '<manifest version string or null>',
//     snapshot: <condensed snapshot object from observations-snapshots.js>
//   }

export const FORMAT_NAME = 'fmn-toolkit-snapshot';
export const FORMAT_VERSION = 1;
export const SUPPORTED_SNAPSHOT_SCHEMAS = [1];

export class SnapshotIoError extends Error {
  constructor(message, { code, detail } = {}) {
    super(message);
    this.name = 'SnapshotIoError';
    this.code = code || 'invalid';
    if (detail !== undefined) this.detail = detail;
  }
}

export function wrapSnapshot(snapshot, { extensionVersion = null, now } = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new SnapshotIoError('Refusing to export an empty snapshot.', { code: 'empty' });
  }
  const exportedAt = (now instanceof Date ? now : new Date()).toISOString();
  return {
    format: FORMAT_NAME,
    formatVersion: FORMAT_VERSION,
    exportedAt,
    extensionVersion: extensionVersion || null,
    snapshot,
  };
}

export function unwrapSnapshot(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new SnapshotIoError('File is not a valid snapshot envelope.', { code: 'not-envelope' });
  }
  if (envelope.format !== FORMAT_NAME) {
    throw new SnapshotIoError(
      `Unknown file format "${envelope.format ?? ''}". Expected "${FORMAT_NAME}".`,
      { code: 'wrong-format', detail: envelope.format ?? null }
    );
  }
  if (envelope.formatVersion !== FORMAT_VERSION) {
    throw new SnapshotIoError(
      `Unsupported snapshot file version ${envelope.formatVersion ?? '?'}. This extension build supports version ${FORMAT_VERSION}.`,
      { code: 'wrong-format-version', detail: envelope.formatVersion ?? null }
    );
  }
  const snap = envelope.snapshot;
  if (!snap || typeof snap !== 'object') {
    throw new SnapshotIoError('Envelope is missing its snapshot payload.', { code: 'missing-snapshot' });
  }
  if (!SUPPORTED_SNAPSHOT_SCHEMAS.includes(snap.schema)) {
    throw new SnapshotIoError(
      `Unsupported snapshot schema ${snap.schema ?? '?'}. This extension build understands schema ${SUPPORTED_SNAPSHOT_SCHEMAS.join(', ')}.`,
      { code: 'wrong-schema', detail: snap.schema ?? null }
    );
  }
  if (!snap.inventory || typeof snap.inventory !== 'object' || !Array.isArray(snap.inventory.servers)) {
    throw new SnapshotIoError('Snapshot is missing its server inventory.', { code: 'missing-inventory' });
  }
  if (!snap.takenAt || typeof snap.takenAt !== 'string') {
    throw new SnapshotIoError('Snapshot is missing a takenAt timestamp.', { code: 'missing-taken-at' });
  }
  return { snapshot: snap, envelope };
}

// Parse a JSON string the file picker handed us. Wraps JSON.parse so the
// caller deals with one error type, with a useful pointer on syntax errors.
export function parseEnvelopeJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SnapshotIoError(
      `File is not valid JSON: ${err?.message || 'parse failed'}.`,
      { code: 'not-json' }
    );
  }
  return unwrapSnapshot(parsed);
}

// Build a stable, human-readable filename for an exported snapshot.
// Subdomain falls back to "unknown" if the snapshot's customer block was
// missing or stripped at condense time. The minute-resolution timestamp
// is enough to keep multiple exports from the same tenant distinct
// without exposing the seconds-precision takenAt to a filesystem.
export function filenameFor(snapshot, { now } = {}) {
  const sub = sanitizeSubdomain(snapshot?.customer?.subdomain) || 'unknown';
  const stampSource = snapshot?.takenAt || (now instanceof Date ? now.toISOString() : new Date().toISOString());
  const stamp = formatStamp(stampSource);
  return `fmn-snapshot-${sub}-${stamp}.json`;
}

function sanitizeSubdomain(value) {
  if (typeof value !== 'string') return null;
  // FortiMonitor subdomains are alnum + hyphen; anything else is suspicious.
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

function formatStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // Caller handed us garbage; fall back to "now" so we still emit a
    // valid filename instead of "NaN-NaN".
    return formatStamp(new Date().toISOString());
  }
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  return `${yyyy}${mm}${dd}-${hh}${mi}`;
}
