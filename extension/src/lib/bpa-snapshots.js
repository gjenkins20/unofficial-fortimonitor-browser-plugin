// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-154: persistent snapshot storage for BPA runs.
//
// Storage shape (backwards-compat with the original two-slot model):
//   {
//     current: <snapshot> | null,
//     previous: <snapshot> | null,
//     history: [<snapshot>, ...] // most-recent first, length up to maxSnapshots - 2
//     maxSnapshots: <int>        // configurable; defaults to DEFAULT_MAX_SNAPSHOTS
//     schema: 2                  // bumped when history landed (Phase 2.1)
//   }
//
// The `current` + `previous` slots stay the source of truth for the
// "diff against last run" default. Older runs spill into `history` so
// the picker UI can offer arbitrary pairings. Each snapshot carries an
// `id` field (synthesized from takenAt for legacy entries) so the UI
// can address pairs by ID.
//
// Per memory mv3_sendmessage_multimb_stall: a full BPA result is
// multi-MB. We store only the slices used by the diff (no raw analyzer
// outputs, no raw HTML, no per-server detail beyond what TABS reads).
// This keeps N snapshots well under the chrome.storage.local quota.

const STORAGE_KEY = 'fm:bpaSnapshots';

export const DEFAULT_MAX_SNAPSHOTS = 10;
export const MIN_MAX_SNAPSHOTS = 2;
export const MAX_MAX_SNAPSHOTS = 50;

// Compact a full BPA result to what the diff layer actually consumes.
// Reduces a typical result blob from ~3-5 MB to under 500 KB.
export function condenseForSnapshot(result) {
  if (!result || typeof result !== 'object') return null;
  const inv = result.inventory || {};
  // FMN-154: record durationMs from the BPA result so the next estimate
  // can show real data instead of a default heuristic.
  let durationMs = null;
  if (result.started_at && result.finished_at) {
    const start = Date.parse(result.started_at);
    const end = Date.parse(result.finished_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      durationMs = end - start;
    }
  }
  return {
    schema: 1,
    takenAt: result.finished_at || result.started_at || new Date().toISOString(),
    durationMs,
    deep: Boolean(result.deep),
    maxServers: result.max_servers ?? 0,
    customer: pickCustomer(result.customer),
    inventory: {
      servers: (inv.servers || []).map(condenseServer),
      users: (inv.users || []).map(condenseUser),
      server_templates: (inv.server_templates || []).map(condenseTemplate),
      server_groups: (inv.server_groups || []).map(condenseGroup),
    },
  };
}

function pickCustomer(c) {
  if (!c || typeof c !== 'object') return null;
  return { id: c.id ?? null, name: c.name ?? '', subdomain: c.subdomain ?? '' };
}

function extractId(urlOrObj) {
  if (typeof urlOrObj === 'string') {
    const m = urlOrObj.match(/\/(\d+)\/?$/);
    return m ? Number(m[1]) : null;
  }
  if (urlOrObj && typeof urlOrObj === 'object') {
    if (typeof urlOrObj.id === 'number') return urlOrObj.id;
    if (typeof urlOrObj.url === 'string') return extractId(urlOrObj.url);
  }
  return null;
}

function condenseServer(s) {
  return {
    id: extractId(s),
    name: s.name ?? '',
    fqdn: s.fqdn ?? '',
    status: s.status ?? '',
    device_type: s.device_type ?? '',
    device_sub_type: s.device_sub_type ?? '',
    agent_version: s.agent_version ?? '',
    server_group: extractId(s.server_group),
    server_template: Array.isArray(s.server_template)
      ? s.server_template.map(extractId).filter((x) => x != null)
      : [],
    tags: Array.isArray(s.tags) ? s.tags.slice() : [],
  };
}

function condenseUser(u) {
  return {
    id: extractId(u),
    username: u.username ?? '',
    first_name: u.first_name ?? '',
    last_name: u.last_name ?? '',
    is_active: Boolean(u.is_active),
    user_role: u.user_role ?? null,
  };
}

function condenseTemplate(t) {
  return {
    id: extractId(t),
    name: t.name ?? '',
    template_type: t.template_type ?? '',
    server_group: extractId(t.server_group),
    applied_servers: Array.isArray(t.applied_servers) ? t.applied_servers.length : 0,
  };
}

function condenseGroup(g) {
  return {
    id: extractId(g),
    name: g.name ?? '',
  };
}

// Read just the current + previous slots. Kept stable so existing handler
// code that only needs the head-of-rotation does not have to deal with
// history; full enumeration goes through listAllSnapshots.
export async function readSnapshots(storage) {
  const s = storage ?? chrome.storage.local;
  const data = await s.get(STORAGE_KEY);
  const slots = data?.[STORAGE_KEY] || {};
  return {
    current: slots.current || null,
    previous: slots.previous || null,
  };
}

export async function writeSnapshot(snapshot, storage) {
  const s = storage ?? chrome.storage.local;
  const raw = await readRawStore(s);
  const maxSnapshots = clampMax(raw.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);
  const tagged = ensureId(snapshot);
  // Rotate: previous -> history[0], current -> previous, new -> current.
  const nextHistory = [];
  if (raw.previous) nextHistory.push(ensureId(raw.previous));
  for (const h of (Array.isArray(raw.history) ? raw.history : [])) {
    nextHistory.push(ensureId(h));
  }
  // Keep at most maxSnapshots total (current + previous + history.length).
  const overflow = Math.max(0, nextHistory.length - (maxSnapshots - 2));
  const prunedHistory = overflow > 0 ? nextHistory.slice(0, nextHistory.length - overflow) : nextHistory;
  const next = {
    schema: 2,
    maxSnapshots,
    current: tagged,
    previous: raw.current ? ensureId(raw.current) : null,
    history: prunedHistory,
  };
  await s.set({ [STORAGE_KEY]: next });
  return { current: next.current, previous: next.previous };
}

export async function clearSnapshots(storage) {
  const s = storage ?? chrome.storage.local;
  await s.remove(STORAGE_KEY);
}

// FMN-161: replace just the `previous` slot, leaving `current` untouched.
// Used by the import handler: an imported baseline becomes the "previous"
// (i.e. older) side of the diff against whatever was last taken locally.
export async function setPreviousSnapshot(snapshot, storage) {
  const s = storage ?? chrome.storage.local;
  const raw = await readRawStore(s);
  await s.set({
    [STORAGE_KEY]: {
      ...raw,
      schema: 2,
      maxSnapshots: clampMax(raw.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS),
      current: raw.current || null,
      previous: snapshot ? ensureId(snapshot) : null,
      history: Array.isArray(raw.history) ? raw.history.map(ensureId) : [],
    },
  });
}

// =====================================================================
// Phase 2.1: N-rotation primitives.
// =====================================================================

// Return every stored snapshot, most-recent first. Each entry is a
// summary suitable for a picker (no full inventory); call
// getSnapshotById for the full snapshot. The id is stable across reads.
export async function listAllSnapshots(storage) {
  const s = storage ?? chrome.storage.local;
  const raw = await readRawStore(s);
  const out = [];
  if (raw.current) out.push(toSummary(raw.current, 'current'));
  if (raw.previous) out.push(toSummary(raw.previous, 'previous'));
  if (Array.isArray(raw.history)) {
    for (let i = 0; i < raw.history.length; i++) {
      out.push(toSummary(raw.history[i], `history-${i}`));
    }
  }
  return out;
}

export async function getSnapshotById(id, storage) {
  if (!id) return null;
  const s = storage ?? chrome.storage.local;
  const raw = await readRawStore(s);
  if (raw.current && idOf(raw.current, 'current') === id) return ensureId(raw.current);
  if (raw.previous && idOf(raw.previous, 'previous') === id) return ensureId(raw.previous);
  if (Array.isArray(raw.history)) {
    for (let i = 0; i < raw.history.length; i++) {
      if (idOf(raw.history[i], `history-${i}`) === id) return ensureId(raw.history[i]);
    }
  }
  return null;
}

// Wipe everything (current, previous, history, max). Settings "Clear all
// snapshots" button calls this.
export async function clearAllSnapshots(storage) {
  const s = storage ?? chrome.storage.local;
  await s.remove(STORAGE_KEY);
}

export async function getMaxSnapshots(storage) {
  const s = storage ?? chrome.storage.local;
  const raw = await readRawStore(s);
  return clampMax(raw.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);
}

export async function setMaxSnapshots(n, storage) {
  const s = storage ?? chrome.storage.local;
  const raw = await readRawStore(s);
  const clamped = clampMax(n);
  // Prune history to fit the new cap. current + previous always stick.
  const history = Array.isArray(raw.history) ? raw.history.map(ensureId) : [];
  const overflow = Math.max(0, history.length - (clamped - 2));
  const pruned = overflow > 0 ? history.slice(0, history.length - overflow) : history;
  await s.set({
    [STORAGE_KEY]: {
      ...raw,
      schema: 2,
      maxSnapshots: clamped,
      current: raw.current || null,
      previous: raw.previous || null,
      history: pruned,
    },
  });
  return clamped;
}

function clampMax(n) {
  const v = Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_SNAPSHOTS;
  if (v < MIN_MAX_SNAPSHOTS) return MIN_MAX_SNAPSHOTS;
  if (v > MAX_MAX_SNAPSHOTS) return MAX_MAX_SNAPSHOTS;
  return v;
}

async function readRawStore(s) {
  const data = await s.get(STORAGE_KEY);
  const raw = data?.[STORAGE_KEY] || {};
  return raw;
}

function idOf(snapshot, fallbackSlot) {
  if (snapshot && typeof snapshot.id === 'string' && snapshot.id) return snapshot.id;
  // Legacy snapshots predate the id field. Synthesize from slot + takenAt
  // so the picker has a stable handle without rewriting storage on read.
  return `snap-${fallbackSlot}-${snapshot?.takenAt || 'unknown'}`;
}

function ensureId(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  if (typeof snapshot.id === 'string' && snapshot.id) return snapshot;
  // Stable enough for snapshots taken at distinct seconds; collisions are
  // tolerated because the listing always disambiguates by slot+index.
  const rand = Math.random().toString(36).slice(2, 8);
  return { ...snapshot, id: `snap-${snapshot.takenAt || 'unknown'}-${rand}` };
}

function toSummary(snapshot, fallbackSlot) {
  const id = idOf(snapshot, fallbackSlot);
  const inv = snapshot?.inventory || {};
  return {
    id,
    takenAt: snapshot?.takenAt ?? null,
    customer: snapshot?.customer ?? null,
    durationMs: snapshot?.durationMs ?? null,
    counts: {
      servers: Array.isArray(inv.servers) ? inv.servers.length : 0,
      users: Array.isArray(inv.users) ? inv.users.length : 0,
      server_templates: Array.isArray(inv.server_templates) ? inv.server_templates.length : 0,
      server_groups: Array.isArray(inv.server_groups) ? inv.server_groups.length : 0,
    },
    slot: fallbackSlot,
  };
}

// Diff inventory.servers between two condensed snapshots. Returns rows
// keyed by server id with a change category and an optional list of
// field-level prev/next pairs.
//
// Categories:
//   - added: id present in current but not in previous
//   - removed: id present in previous but not in current
//   - modified: id present in both with at least one field changed
//
// Fields compared on each server: name, fqdn, status, device_sub_type,
// agent_version, server_group, server_template (array equality by
// sorted-stringified contents), tags (same).
const SERVER_FIELDS = ['name', 'fqdn', 'status', 'device_sub_type', 'agent_version'];
const SERVER_ARRAY_FIELDS = ['server_template', 'tags'];

export function diffServers(prevSnap, currSnap) {
  const prev = new Map();
  const curr = new Map();
  for (const s of (prevSnap?.inventory?.servers || [])) if (s.id != null) prev.set(s.id, s);
  for (const s of (currSnap?.inventory?.servers || [])) if (s.id != null) curr.set(s.id, s);

  const added = [];
  const removed = [];
  const modified = [];

  for (const [id, c] of curr) {
    if (!prev.has(id)) {
      added.push({ id, change: 'added', current: c });
    } else {
      const p = prev.get(id);
      const fieldChanges = [];
      for (const f of SERVER_FIELDS) {
        if (String(p[f] ?? '') !== String(c[f] ?? '')) {
          fieldChanges.push({ name: f, prev: p[f], next: c[f] });
        }
      }
      // Compare server_group separately - it's a number, not a string.
      if ((p.server_group ?? null) !== (c.server_group ?? null)) {
        fieldChanges.push({ name: 'server_group', prev: p.server_group, next: c.server_group });
      }
      for (const f of SERVER_ARRAY_FIELDS) {
        const pa = Array.isArray(p[f]) ? p[f].slice().sort().join(',') : '';
        const ca = Array.isArray(c[f]) ? c[f].slice().sort().join(',') : '';
        if (pa !== ca) fieldChanges.push({ name: f, prev: p[f] ?? [], next: c[f] ?? [] });
      }
      if (fieldChanges.length > 0) {
        modified.push({ id, change: 'modified', previous: p, current: c, fields: fieldChanges });
      }
    }
  }
  for (const [id, p] of prev) {
    if (!curr.has(id)) removed.push({ id, change: 'removed', previous: p });
  }

  return { added, removed, modified, prevTakenAt: prevSnap?.takenAt ?? null, currTakenAt: currSnap?.takenAt ?? null };
}
