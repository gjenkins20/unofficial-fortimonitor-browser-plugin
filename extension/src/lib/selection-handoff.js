// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-115: cross-tool "Send selection to" handoff.
//
// One module owns the storage shape, the receiver registry, and the
// read/write helpers. Senders (Find Servers / Server Lookup results) write
// a selection blob; receivers (Manage Templates / Manage Attributes start
// steps) read and consume it on mount.
//
// Storage surface: chrome.storage.session under STORAGE_KEY. Session
// storage is per-window and evaporates on browser restart, which matches
// the "ephemeral handoff" intent. expiresAt enforces a soft TTL on top of
// that so a stale blob from one popup-close cannot prefill a receiver
// opened minutes later via a different path.

export const STORAGE_KEY = 'fm:pendingSelection';
export const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Receiver registry. Adding a new receiver is a single entry here plus a
// reader on that receiver's start step. Senders never need to change.
export const RECEIVERS = Object.freeze({
  'manage-templates-attach': Object.freeze({
    id: 'manage-templates-attach',
    label: 'Manage Templates → Attach',
    appPath: 'src/ui/template-management/app.html',
    accepts: ['ids', 'names'],
    hint: Object.freeze({ operation: 'attach' })
  }),
  'manage-templates-detach': Object.freeze({
    id: 'manage-templates-detach',
    label: 'Manage Templates → Detach',
    appPath: 'src/ui/template-management/app.html',
    accepts: ['ids', 'names'],
    hint: Object.freeze({ operation: 'detach' })
  }),
  'manage-attributes': Object.freeze({
    id: 'manage-attributes',
    label: 'Manage Attributes',
    appPath: 'src/ui/attribute-management/app.html',
    accepts: ['ids', 'names'],
    hint: null
  })
});

export function listReceivers() {
  return Object.values(RECEIVERS).map((r) => ({
    id: r.id,
    label: r.label,
    appPath: r.appPath,
    accepts: [...r.accepts],
    hint: r.hint ? { ...r.hint } : null
  }));
}

export function getReceiver(receiverId) {
  return RECEIVERS[receiverId] || null;
}

// Validate a blob shape. Returns { ok: true } or { ok: false, reason }.
function validateBlob(blob) {
  if (!blob || typeof blob !== 'object') return { ok: false, reason: 'not-object' };
  if (!RECEIVERS[blob.receiverId]) return { ok: false, reason: 'unknown-receiver' };
  if (!Array.isArray(blob.ids) || blob.ids.length === 0) return { ok: false, reason: 'no-ids' };
  if (typeof blob.expiresAt !== 'number') return { ok: false, reason: 'no-expiry' };
  return { ok: true };
}

// Write a selection blob targeting a specific receiver. The sender supplies
// ids, optional names, and a free-form source label (e.g. 'find-servers').
// hint defaults to the receiver's registered hint and can be overridden by
// the caller for sender-side context (rare).
export async function writeSelection({
  receiverId,
  ids,
  names = null,
  source,
  hint,
  ttlMs = DEFAULT_TTL_MS,
  storage = defaultStorage(),
  now = Date.now
} = {}) {
  const receiver = getReceiver(receiverId);
  if (!receiver) throw new Error(`selection-handoff: unknown receiver ${receiverId}`);
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('selection-handoff: ids must be a non-empty array');
  }
  const cleanIds = ids
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (cleanIds.length === 0) {
    throw new Error('selection-handoff: ids reduced to empty after coercion');
  }
  const cleanNames = Array.isArray(names) && names.length > 0
    ? names.map((s) => (s == null ? '' : String(s))).filter((s) => s.length > 0)
    : null;
  const blob = {
    receiverId,
    ids: cleanIds,
    names: cleanNames,
    source: String(source || 'unknown'),
    hint: hint !== undefined ? hint : (receiver.hint ? { ...receiver.hint } : null),
    expiresAt: now() + Math.max(1, ttlMs)
  };
  await storage.set({ [STORAGE_KEY]: blob });
  return blob;
}

// Read the current selection blob, returning null when absent, expired,
// or shape-invalid. Does NOT clear the slot. Callers that want a one-shot
// read should use consumeSelection().
export async function readSelection({
  storage = defaultStorage(),
  now = Date.now
} = {}) {
  const data = await storage.get(STORAGE_KEY);
  const blob = data?.[STORAGE_KEY];
  if (!blob) return null;
  const v = validateBlob(blob);
  if (!v.ok) return null;
  if (blob.expiresAt <= now()) return null;
  return blob;
}

// Read + clear in one call. Receivers use this on mount so a back-button
// revisit cannot duplicate the prefill.
export async function consumeSelection({
  storage = defaultStorage(),
  now = Date.now
} = {}) {
  const blob = await readSelection({ storage, now });
  await clearSelection({ storage });
  return blob;
}

// Read a selection only if it targets receiverId; clear it whether or not
// it matched (the slot is single-shot regardless). This is the canonical
// receiver-side entry point. receiverId may be a string or an array of
// strings (a tool that hosts multiple receivers, e.g. Manage Templates
// owns both attach and detach).
export async function consumeSelectionFor(receiverId, opts = {}) {
  const accepted = Array.isArray(receiverId) ? receiverId : [receiverId];
  const blob = await consumeSelection(opts);
  if (!blob || !accepted.includes(blob.receiverId)) return null;
  return blob;
}

export async function clearSelection({ storage = defaultStorage() } = {}) {
  if (typeof storage.remove === 'function') {
    await storage.remove(STORAGE_KEY);
  } else {
    await storage.set({ [STORAGE_KEY]: null });
  }
}

function defaultStorage() {
  // eslint-disable-next-line no-undef
  if (typeof chrome !== 'undefined' && chrome?.storage?.session) return chrome.storage.session;
  throw new Error('selection-handoff: chrome.storage.session is not available and no storage adapter was provided');
}
