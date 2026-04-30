// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-115 stub: cross-tool handoff Playwright fixtures.
//
// Surgically overrides chrome.runtime.sendMessage and onMessage at the
// context level so the new tab opened by chrome.tabs.create also sees
// it. Leaves chrome.runtime.id, getURL, chrome.tabs, chrome.storage
// untouched so the real handoff path (real new tab, real session
// storage shared across tabs) still works.

export const handoffCombinedStubScript = `
(() => {
  if (globalThis.__fmn_handoff_stub_installed__) return;
  globalThis.__fmn_handoff_stub_installed__ = true;

  // ---- Find Servers tenant (mirrors stubs.js) -----------------------
  const SUGGESTIONS = [
    { name: 'Environment',      textkey: 'Environment',  sources: ['catalog'] },
    { name: 'Operating System', textkey: 'server.os',    sources: ['server'] }
  ];
  const DEVICE_TYPES = ['server', 'network_device'];
  const SERVERS = [
    { id: 1001, url: '/server/1001', name: 'edge-win-01', fqdn: 'edge-win-01.local', additional_fqdns: [], status: 'active', tags: ['production'], device_type: 'server', device_sub_type: null,
      attributes: [{ name: 'Operating System', textkey: 'server.os', value: 'Windows Server 2022' }] },
    { id: 1002, url: '/server/1002', name: 'edge-win-02', fqdn: 'edge-win-02.local', additional_fqdns: [], status: 'active', tags: ['production'], device_type: 'server', device_sub_type: null,
      attributes: [{ name: 'Operating System', textkey: 'server.os', value: 'Windows Server 2019' }] }
  ];
  const TEMPLATES = [
    { id: 501, resourceUrl: '/server_template/501', name: 'Critical Infra', templateType: 'standard', appliedServerUrls: [] }
  ];
  const ATTR_TYPES = [
    { resourceUrl: '/server_attribute_type/1', name: 'Environment', textkey: 'Environment' }
  ];

  // Minimal criterion matcher (mirrors stubs.js but trimmed to what
  // these tests exercise).
  const eq  = (a, b, ci) => a == null || b == null ? false : (ci ? String(a).toLowerCase() === String(b).toLowerCase() : String(a) === String(b));
  function matchOne(server, c) {
    const ci = c.caseInsensitive !== false;
    const ex = c.exactMatch !== false;
    if (c.fieldType === 'tag') {
      for (const t of (server.tags || [])) {
        if (ex ? eq(t, c.value, ci) : (ci ? String(t).toLowerCase().includes(String(c.value).toLowerCase()) : String(t).includes(String(c.value)))) {
          return { value: t };
        }
      }
      return null;
    }
    if (c.fieldType === 'name') {
      const m = ex ? eq(server.name, c.value, ci) : (ci ? String(server.name || '').toLowerCase().includes(String(c.value).toLowerCase()) : false);
      return m ? { value: server.name } : null;
    }
    return null;
  }
  function matchesByCriteria(server, criteria, mode) {
    if (criteria.length === 0) return { matched: true, info: [] };
    const info = [];
    let any = false; let all = true;
    for (const c of criteria) {
      const r = matchOne(server, c);
      if (r) { info.push({ fieldType: c.fieldType, ...r }); any = true; }
      else { all = false; }
    }
    return { matched: mode === 'any' ? any : all, info };
  }
  function shape(server, info) {
    return {
      id: server.id, url: server.url, name: server.name, fqdn: server.fqdn,
      additional_fqdns: server.additional_fqdns || [], device_type: server.device_type,
      device_sub_type: server.device_sub_type || null, status: server.status,
      tags: server.tags || [], attributes: server.attributes || [],
      matchedCriteria: info, source: null
    };
  }

  // Save real onMessage so we keep service-worker event delivery alive
  // (we still patch sendMessage; onMessage stays real for handoff
  // unrelated message channels).
  const realRuntime = (globalThis.chrome && globalThis.chrome.runtime) || {};
  const messageListeners = new Set();
  realRuntime.lastError = null;

  realRuntime.sendMessage = function (message, callback) {
    const type = message && message.type;
    const payload = (message && message.payload) || {};
    setTimeout(() => {
      try {
        if (type === 'search:list-attribute-types') return callback({ ok: true, result: SUGGESTIONS });
        if (type === 'search:list-device-types')    return callback({ ok: true, result: DEVICE_TYPES });
        if (type === 'search:abort')                return callback({ ok: true, result: { aborted: false } });
        if (type === 'search:servers') {
          const ids = Array.isArray(payload.identifiers) ? payload.identifiers : [];
          const criteria = (Array.isArray(payload.criteria) ? payload.criteria : []).map((c) => {
            const out = { ...c };
            if (out.caseInsensitive == null) out.caseInsensitive = payload.caseInsensitive !== false;
            return out;
          });
          const mode = payload.mode === 'any' ? 'any' : 'all';
          const matches = [];
          for (const s of SERVERS) {
            const r = matchesByCriteria(s, criteria, mode);
            if (r.matched) matches.push(shape(s, r.info));
          }
          return callback({ ok: true, result: {
            identifiers: ids, criteria, mode,
            caseInsensitive: payload.caseInsensitive !== false,
            matches, totalScanned: SERVERS.length, totalAvailable: SERVERS.length,
            startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
          } });
        }
        if (type === 'tmpl:list-templates') return callback({ ok: true, result: TEMPLATES });
        if (type === 'attr:list-types')     return callback({ ok: true, result: ATTR_TYPES });
        callback({ ok: false, error: 'no-stub-for-' + type });
      } catch (err) {
        callback({ ok: false, error: String(err && err.message || err) });
      }
    }, 0);
  };

  realRuntime.onMessage = {
    addListener: (fn) => messageListeners.add(fn),
    removeListener: (fn) => messageListeners.delete(fn)
  };

  // Don't replace chrome.tabs or chrome.storage - the real ones drive
  // the new-tab open and session-storage handoff that this test
  // exercises end to end.
})();
`;
