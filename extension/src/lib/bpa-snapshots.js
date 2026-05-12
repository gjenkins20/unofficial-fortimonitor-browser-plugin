// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-154: persistent snapshot storage for BPA runs.
//
// Phase 1 (this ticket): two-slot model. The most-recent snapshot lands
// in `current`; the prior one is rotated to `previous`. Diff compares
// the two. A future phase replaces this with N-rotation + per-snapshot
// archival, but two slots is enough to answer "what changed since last
// time I looked" which is the operator's question.
//
// Per memory mv3_sendmessage_multimb_stall: a full BPA result is
// multi-MB. We store only the slices used by the diff (no raw analyzer
// outputs, no raw HTML, no per-server detail beyond what TABS reads).
// This keeps two snapshots well under the chrome.storage.local quota.

const STORAGE_KEY = 'fm:bpaSnapshots';

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
  const { current } = await readSnapshots(s);
  // Rotate: current -> previous, new -> current.
  const next = {
    previous: current,
    current: snapshot,
  };
  await s.set({ [STORAGE_KEY]: next });
  return next;
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
  const { current } = await readSnapshots(s);
  await s.set({ [STORAGE_KEY]: { current, previous: snapshot } });
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
