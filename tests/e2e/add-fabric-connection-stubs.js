// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-119 Add Fabric Connection (API) stubs.

export const fabricConnectionStubScript = `
(() => {
  if (globalThis.__fmn_fabric_stub_installed__) return;
  globalThis.__fmn_fabric_stub_installed__ = true;

  const ONSIGHT = [{ id: 7, name: 'on-east-1', resourceUrl: '/onsight/7' }];
  const SERVER_GROUPS = [{ id: 100, name: 'default-group', resourceUrl: '/server_group/100' }];
  const APPLIANCE_GROUPS = [{ id: 50, name: 'fortinet-csf', resourceUrl: '/onsight_group/50' }];

  const realRuntime = (globalThis.chrome && globalThis.chrome.runtime) || {};
  const messageListeners = new Set();
  realRuntime.lastError = null;

  realRuntime.sendMessage = function (message, callback) {
    const type = message && message.type;
    const payload = (message && message.payload) || {};
    setTimeout(() => {
      try {
        if (type === 'panopta:list-onsight')        return callback({ ok: true, result: ONSIGHT });
        if (type === 'panopta:list-server-groups')  return callback({ ok: true, result: SERVER_GROUPS });
        if (type === 'panopta:list-onsight-groups') return callback({ ok: true, result: APPLIANCE_GROUPS });

        if (type === 'fc:create-batch') {
          // Return success per row.
          const rows = Array.isArray(payload.devices) ? payload.devices : [];
          const results = rows.map((d, i) => ({
            input: d, status: 'ok', resourceId: String(20000 + i), error: null
          }));
          return callback({ ok: true, result: { results, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } });
        }
        if (type === 'fc:abort') return callback({ ok: true, result: { aborted: false } });
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
