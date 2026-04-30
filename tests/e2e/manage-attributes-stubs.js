// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-119 Manage Attributes (Bulk) stubs.

export const manageAttributesStubScript = `
(() => {
  if (globalThis.__fmn_attr_stub_installed__) return;
  globalThis.__fmn_attr_stub_installed__ = true;

  const ATTRIBUTE_TYPES = [
    { resourceUrl: '/server_attribute_type/1', name: 'Environment', textkey: 'Environment' },
    { resourceUrl: '/server_attribute_type/2', name: 'Owner',       textkey: 'owner' }
  ];

  const realRuntime = (globalThis.chrome && globalThis.chrome.runtime) || {};
  const messageListeners = new Set();
  realRuntime.lastError = null;

  realRuntime.sendMessage = function (message, callback) {
    const type = message && message.type;
    const payload = (message && message.payload) || {};
    setTimeout(() => {
      try {
        if (type === 'attr:list-types') return callback({ ok: true, result: ATTRIBUTE_TYPES });

        if (type === 'attr:plan-batch') {
          const entries = Array.isArray(payload.entries) ? payload.entries : [];
          const attributes = Array.isArray(payload.attributes) ? payload.attributes : [];
          const plan = [];
          // One plan row per (entry × attribute). Mark all as 'add' (new
          // value) for set ops, 'remove' for remove ops. Server-id resolution
          // is the entry's ordinal +1000 to keep things deterministic.
          entries.forEach((e, ei) => {
            attributes.forEach((a, ai) => {
              const serverId = 1000 + ei + 1;
              const planAction = a.operation === 'remove' ? 'remove' : 'add';
              plan.push({
                input: e.raw ?? e.name ?? String(e),
                attrIndex: ai,
                plan: planAction,
                serverId,
                displayName: 'srv-' + serverId,
                typeUrl: a.typeUrl,
                typeName: a.typeName,
                currentValue: null,
                newValue: a.value ?? null,
                error: null
              });
            });
          });
          return callback({ ok: true, result: { plan } });
        }

        if (type === 'attr:execute-batch') {
          // Stubbed execute: return success per plan row.
          const plan = Array.isArray(payload.plan) ? payload.plan : [];
          const results = plan.map((p) => ({
            input: p.input, attrIndex: p.attrIndex, serverId: p.serverId,
            plan: p.plan, status: 'ok', error: null
          }));
          return callback({ ok: true, result: { results, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } });
        }

        if (type === 'attr:abort') return callback({ ok: true, result: { aborted: false } });

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
