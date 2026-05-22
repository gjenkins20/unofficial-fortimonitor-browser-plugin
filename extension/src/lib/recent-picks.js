// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-235: Persist successful Bulk Action Composer device snapshots to
// chrome.storage.local as a small ring buffer. The Pick step reads the
// buffer to offer "Use same devices as last run" cards above the input
// tabs, so the operator can re-run an action on the prior set without
// re-pasting / re-fetching.
//
// Entry shape:
//   { savedAt: ISO 8601, targets: [{ id, name | null }] }
// Newest first, capped at MAX_ENTRIES. Dedupe: a new save that matches
// an existing entry's id set replaces (and moves to front).

const STORAGE_KEY = 'bulk-composer:recent-picks';
export const MAX_ENTRIES = 5;

function sanitizeTargets(targets) {
  if (!Array.isArray(targets)) return [];
  const seen = new Set();
  const out = [];
  for (const t of targets) {
    const id = Number(t?.id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: typeof t?.name === 'string' ? t.name : null });
  }
  return out;
}

function sameTargetSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const ids = new Set(a.map((t) => t.id));
  for (const t of b) if (!ids.has(t.id)) return false;
  return true;
}

export async function saveRecentPick(targets) {
  const sanitized = sanitizeTargets(targets);
  if (sanitized.length === 0) return;
  const existing = await loadRecentPicks();
  const next = [
    { savedAt: new Date().toISOString(), targets: sanitized },
    ...existing.filter((e) => !sameTargetSet(e.targets, sanitized)),
  ].slice(0, MAX_ENTRIES);
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[bulk-composer recent-picks] save failed', err);
    }
  }
}

export async function loadRecentPicks() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const entries = result?.[STORAGE_KEY];
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((e) => e && typeof e.savedAt === 'string' && Array.isArray(e.targets) && e.targets.length > 0)
      .map((e) => ({ savedAt: e.savedAt, targets: sanitizeTargets(e.targets) }))
      .filter((e) => e.targets.length > 0);
  } catch {
    return [];
  }
}

export async function clearRecentPicks() {
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

// Formats an absolute ISO timestamp as a short relative age suitable for
// the recent-pick chip caption (e.g. "2 min ago", "yesterday", "3 days
// ago"). Falls back to the raw date string for entries older than a
// month so operators get a real anchor for very old picks.
export function humanizeAge(savedAt, now = Date.now()) {
  if (typeof savedAt !== 'string' || savedAt.length === 0) return '';
  const t = new Date(savedAt).getTime();
  if (!Number.isFinite(t)) return '';
  const seconds = Math.max(0, Math.round((now - t) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks} wk ago`;
  return new Date(savedAt).toISOString().slice(0, 10);
}
