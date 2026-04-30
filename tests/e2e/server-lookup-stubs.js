// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-119 Server Lookup stubs. Same surgical-patch shape as the
// FMN-115 handoff stubs: only chrome.runtime.sendMessage is overridden,
// real chrome.runtime / chrome.storage / chrome.tabs are preserved.

export const serverLookupStubScript = `
(() => {
  if (globalThis.__fmn_server_lookup_stub_installed__) return;
  globalThis.__fmn_server_lookup_stub_installed__ = true;

  // Canned tenant. Names are exact-match; ids 1001/1002 exist; 9999 is
  // the not-found id; 'edge-win' name returns 2 candidates (ambiguous).
  const SERVERS = {
    1001: { id: 1001, name: 'edge-win-01' },
    1002: { id: 1002, name: 'edge-win-02' }
  };
  function nameLookup(name) {
    if (name === 'edge-win-01') return [{ id: 1001, name }];
    if (name === 'edge-win-02') return [{ id: 1002, name }];
    if (name === 'edge-win')    return [{ id: 1001, name: 'edge-win-01' }, { id: 1002, name: 'edge-win-02' }];
    return [];
  }

  const realRuntime = (globalThis.chrome && globalThis.chrome.runtime) || {};
  const messageListeners = new Set();
  realRuntime.lastError = null;

  function shapeFound(entry) {
    if (entry.kind === 'name') {
      const matches = nameLookup(entry.name);
      if (matches.length === 0) {
        return { name: entry.name, kind: 'name', status: 'not_found', matches: [] };
      }
      if (matches.length > 1) {
        return { name: entry.name, kind: 'name', status: 'ambiguous', matches };
      }
      return { name: matches[0].name, kind: 'name', status: 'found', serverId: matches[0].id, matches };
    }
    // url / id
    const id = entry.serverId;
    if (SERVERS[id]) return { raw: entry.raw, kind: entry.kind, status: 'found', serverId: id };
    return { raw: entry.raw, kind: entry.kind, status: 'not_found' };
  }

  realRuntime.sendMessage = function (message, callback) {
    const type = message && message.type;
    const payload = (message && message.payload) || {};
    setTimeout(() => {
      try {
        if (type === 'lookup:server-ids') {
          const entries = Array.isArray(payload.entries) ? payload.entries : [];
          const results = entries.map(shapeFound);
          // Synthetic per-entry events to drive the start step's progress
          // rows.
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const label = e.kind === 'name' ? e.name : e.raw;
            for (const fn of messageListeners) {
              try { fn({ type: '__event__', event: 'lookup:entry-start', payload: { index: i, name: label, kind: e.kind } }, {}, () => {}); } catch {}
              try { fn({ type: '__event__', event: 'lookup:entry-done',  payload: { index: i, name: label, kind: e.kind, status: results[i].status, serverId: results[i].serverId ?? null, matchCount: results[i].matches?.length ?? 0 } }, {}, () => {}); } catch {}
            }
          }
          return callback({ ok: true, result: { results, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } });
        }
        if (type === 'lookup:abort') return callback({ ok: true, result: { aborted: false } });
        callback({ ok: false, error: 'no-stub-for-' + type });
      } catch (err) { callback({ ok: false, error: String(err && err.message || err) }); }
    }, 0);
  };
  realRuntime.onMessage = {
    addListener: (fn) => messageListeners.add(fn),
    removeListener: (fn) => messageListeners.delete(fn)
  };
})();
`;
