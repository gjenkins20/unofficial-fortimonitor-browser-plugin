// Cleanup queue — operator-reviewed intended actions, one entry per
// device, grouped by fingerprint. Persisted in chrome.storage.local so
// the queue survives tab navigation and accidental closures.
//
// Storage API is injectable so this module is testable in Node with the
// chrome-mocks fixture.

const STORAGE_KEY = 'fm-cleanup-queue';

/**
 * @typedef {Object} QueueEntry
 * @property {string} id              - stable per-entry id (device + batch)
 * @property {string} batchId         - groups entries belonging to the same batch
 * @property {string} groupId         - fingerprint hash of the device's port scope
 * @property {string|number} serverId - FortiMonitor server id
 * @property {string} deviceName      - display name for the operator (best-effort)
 * @property {object} intendedAction  - what will be written to save_port_selection
 * @property {string} intendedAction.portSelectionType
 * @property {string[]} intendedAction.selectedIndices
 * @property {number} intendedAction.totalPortCount
 * @property {string} [intendedAction.searchTerm]
 * @property {Array} [intendedAction.filters]
 * @property {'pending'|'in_progress'|'succeeded'|'failed'|'skipped'} status
 * @property {Array<{at: string, error?: string}>} attempts
 */

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'e_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export class Queue {
  /**
   * @param {object} deps
   * @param {object} [deps.storage] - chrome.storage.local-compatible adapter
   */
  constructor({ storage = undefined } = {}) {
    // Accept chrome.storage.local in production; a mock in tests.
    const candidate = storage ?? (typeof chrome !== 'undefined' ? chrome.storage?.local : undefined);
    if (!candidate || typeof candidate.get !== 'function' || typeof candidate.set !== 'function') {
      throw new TypeError('Queue requires a storage adapter with get() and set()');
    }
    this.storage = candidate;
  }

  async list() {
    const out = await this.storage.get(STORAGE_KEY);
    const arr = out?.[STORAGE_KEY];
    return Array.isArray(arr) ? arr : [];
  }

  async replaceAll(entries) {
    if (!Array.isArray(entries)) throw new TypeError('replaceAll: entries must be an array');
    await this.storage.set({ [STORAGE_KEY]: entries });
  }

  async add(entry) {
    const items = await this.list();
    const withId = { id: entry.id ?? randomId(), attempts: entry.attempts ?? [], ...entry };
    if (!withId.id) withId.id = randomId();
    if (!Array.isArray(withId.attempts)) withId.attempts = [];
    items.push(withId);
    await this.replaceAll(items);
    return withId;
  }

  async addMany(entries) {
    const items = await this.list();
    const out = entries.map((e) => ({
      id: e.id ?? randomId(),
      attempts: Array.isArray(e.attempts) ? e.attempts : [],
      ...e
    }));
    items.push(...out);
    await this.replaceAll(items);
    return out;
  }

  async update(id, patch) {
    const items = await this.list();
    const idx = items.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    items[idx] = { ...items[idx], ...patch };
    await this.replaceAll(items);
    return items[idx];
  }

  async recordAttempt(id, { error = null } = {}) {
    const items = await this.list();
    const idx = items.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const attempt = { at: new Date().toISOString() };
    if (error) attempt.error = String(error);
    const attempts = Array.isArray(items[idx].attempts) ? [...items[idx].attempts, attempt] : [attempt];
    items[idx] = { ...items[idx], attempts };
    await this.replaceAll(items);
    return items[idx];
  }

  async clear() {
    await this.storage.set({ [STORAGE_KEY]: [] });
  }

  /**
   * Remove entries matching a predicate. Returns the removed entries.
   */
  async remove(predicate) {
    if (typeof predicate !== 'function') throw new TypeError('remove: predicate must be a function');
    const items = await this.list();
    const kept = [];
    const removed = [];
    for (const e of items) {
      if (predicate(e)) removed.push(e);
      else kept.push(e);
    }
    await this.replaceAll(kept);
    return removed;
  }
}

export const __test__ = { STORAGE_KEY };
