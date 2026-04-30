// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-119 Manage Templates (Bulk) stubs.

export const manageTemplatesStubScript = `
(() => {
  if (globalThis.__fmn_tmpl_stub_installed__) return;
  globalThis.__fmn_tmpl_stub_installed__ = true;

  const TEMPLATES = [
    { id: 501, name: 'Critical Infra', resourceUrl: '/server_template/501', templateType: 'standard', appliedServerUrls: ['/server/1001'] },
    { id: 502, name: 'Standard Linux',  resourceUrl: '/server_template/502', templateType: 'standard', appliedServerUrls: [] }
  ];

  const realRuntime = (globalThis.chrome && globalThis.chrome.runtime) || {};
  const messageListeners = new Set();
  realRuntime.lastError = null;

  realRuntime.sendMessage = function (message, callback) {
    const type = message && message.type;
    const payload = (message && message.payload) || {};
    setTimeout(() => {
      try {
        if (type === 'tmpl:list-templates') return callback({ ok: true, result: TEMPLATES });

        if (type === 'tmpl:plan-batch') {
          const entries = Array.isArray(payload.entries) ? payload.entries : [];
          // For attach: every row is an 'attach' plan unless the server
          // already has the template (1001 already has 501 in TEMPLATES).
          const op = payload.operation === 'detach' ? 'detach' : 'attach';
          const targetUrl = String(payload.templateUrl || '');
          const tmpl = TEMPLATES.find((t) => t.resourceUrl === targetUrl);
          const attached = new Set(
            (tmpl?.appliedServerUrls || []).map((u) => { const m = String(u).match(/\\/server\\/(\\d+)/); return m ? Number(m[1]) : null; }).filter(Boolean)
          );
          const plan = entries.map((entry, i) => {
            const serverId = 1000 + i + 1;
            const isAttached = attached.has(serverId);
            let action;
            if (op === 'attach') action = isAttached ? 'skip' : 'attach';
            else action = isAttached ? 'detach' : 'skip';
            return {
              input: entry,
              serverId,
              displayName: 'srv-' + serverId,
              plan: action,
              currentlyAttached: isAttached,
              templateUrl: targetUrl,
              templateName: tmpl?.name ?? null,
              error: null
            };
          });
          return callback({ ok: true, result: { plan } });
        }

        if (type === 'tmpl:execute-batch') {
          const plan = Array.isArray(payload.plan) ? payload.plan : [];
          const results = plan.map((p) => ({
            input: p.input, serverId: p.serverId, plan: p.plan,
            status: p.plan === 'skip' ? 'skipped' : 'ok', error: null
          }));
          return callback({ ok: true, result: { results, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } });
        }

        if (type === 'tmpl:abort') return callback({ ok: true, result: { aborted: false } });

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
