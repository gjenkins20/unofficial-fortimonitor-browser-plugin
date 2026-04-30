// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-119 Port-Scope (Add / Remove) stubs.
//
// These tools talk to FortiMonitor session-auth endpoints (not the v2
// API), and a real live test would require a logged-in FortiMonitor
// session. This stub script covers scan-devices + session:probe so the
// start -> review handoff exercises with deterministic state.

export const portScopeStubScript = `
(() => {
  if (globalThis.__fmn_port_scope_stub_installed__) return;
  globalThis.__fmn_port_scope_stub_installed__ = true;

  // Two devices with identical port shape so they group into one
  // review fingerprint, exercising the grouping path.
  const PORTS = [
    { name: 'port1', index: 0, isActive: true,  admin_status: 'up',   oper_status: 'up' },
    { name: 'port2', index: 1, isActive: false, admin_status: 'down', oper_status: 'down' }
  ];
  const SCAN_RESULT = {
    groups: [{
      fingerprint: 'fp-1',
      devices: [
        { serverId: 1001, name: 'srv-1001', portFilters: { filter_type: 'manual' }, ports: PORTS },
        { serverId: 1002, name: 'srv-1002', portFilters: { filter_type: 'manual' }, ports: PORTS }
      ],
      ports: PORTS
    }],
    errored: [],
    nameById: { 1001: 'srv-1001', 1002: 'srv-1002' }
  };

  const realRuntime = (globalThis.chrome && globalThis.chrome.runtime) || {};
  const messageListeners = new Set();
  realRuntime.lastError = null;

  realRuntime.sendMessage = function (message, callback) {
    const type = message && message.type;
    setTimeout(() => {
      try {
        if (type === 'session:probe') return callback({ ok: true, result: { ok: true } });
        if (type === 'scan-devices')  return callback({ ok: true, result: SCAN_RESULT });
        if (type === 'queue:list')    return callback({ ok: true, result: [] });
        if (type === 'queue:replace') return callback({ ok: true, result: { count: 0 } });
        if (type === 'queue:add-many') return callback({ ok: true, result: { added: 0 } });
        if (type === 'queue:clear')   return callback({ ok: true, result: { ok: true } });
        if (type === 'execute-queue') return callback({ ok: true, result: { results: [], dryRun: true } });
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
