// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Stub script source for FMN-116 Playwright E2E. Mirrors the canned
// tenant data + matchers in docs/harnesses/find-servers.html so the
// suite is deterministic and tenant-independent.
//
// Exported as a string. Tests pass it to page.addInitScript BEFORE
// page.goto so the patched chrome.runtime is in place when the tool's
// app.js evaluates.

export const findServersStubScript = `
(() => {
  const SUGGESTIONS = [
    { name: 'Environment',      textkey: 'Environment',  sources: ['catalog'] },
    { name: 'Model',            textkey: 'dem.model',    sources: ['server'] },
    { name: 'Operating System', textkey: 'server.os',    sources: ['server'] }
  ];
  const DEVICE_TYPES = ['fortigate', 'network_device', 'server'];

  // Canned tenant.
  const SERVERS = [
    { id: 1001, url: '/server/1001', name: 'edge-win-01', fqdn: 'edge-win-01.local', additional_fqdns: [], status: 'active', tags: ['production', 'edge'], device_type: 'server', device_sub_type: null,
      attributes: [
        { name: 'Operating System', textkey: 'server.os', value: 'Windows Server 2022' },
        { name: 'Model',            textkey: 'dem.model', value: 'PowerEdge R750' }
      ]
    },
    { id: 1002, url: '/server/1002', name: 'edge-win-02', fqdn: 'edge-win-02.local', additional_fqdns: [], status: 'active', tags: ['production'], device_type: 'server', device_sub_type: null,
      attributes: [
        { name: 'Operating System', textkey: 'server.os', value: 'Windows Server 2019' }
      ]
    },
    { id: 1003, url: '/server/1003', name: 'staging-lnx-01', fqdn: 'staging-lnx.local', additional_fqdns: [], status: 'paused', tags: ['staging'], device_type: 'server', device_sub_type: null,
      attributes: [
        { name: 'Operating System', textkey: 'server.os', value: 'Ubuntu 22.04' }
      ]
    },
    { id: 1004, url: '/server/1004', name: 'edge-fgt-01', fqdn: 'edge-fgt-01.local', additional_fqdns: [], status: 'active', tags: ['production', 'wan'], device_type: 'network_device', device_sub_type: 'fortigate',
      attributes: [
        { name: 'Model', textkey: 'dem.model', value: 'FGT60F' }
      ]
    }
  ];
  const ACTIVE_OUTAGE_IDS = new Set([1003]);

  // FMN-121: applied-template fixtures. Two templates; "Critical Infra"
  // is attached to 1001 + 1004; "Standard Linux" is attached to 1003.
  const TEMPLATES = [
    { id: 501, name: 'Critical Infra', templateType: 'standard', resourceUrl: '/server_template/501', appliedServerUrls: ['/server/1001', '/server/1004'] },
    { id: 502, name: 'Standard Linux',  templateType: 'standard', resourceUrl: '/server_template/502', appliedServerUrls: ['/server/1003'] }
  ];
  const TEMPLATE_APPLIED_SETS = {
    '/server_template/501': new Set([1001, 1004]),
    '/server_template/502': new Set([1003])
  };

  // Field-type matchers (kept minimal; mirrors background handler).
  const eq  = (a, b, ci) => a == null || b == null ? false : (ci ? String(a).toLowerCase() === String(b).toLowerCase() : String(a) === String(b));
  const inc = (a, b, ci) => a == null || b == null ? false : (ci ? String(a).toLowerCase().includes(String(b).toLowerCase()) : String(a).includes(String(b)));
  const valMatch = (a, b, exact, ci) => exact ? eq(a, b, ci) : inc(a, b, ci);

  function matchOne(server, c) {
    const ci = c.caseInsensitive !== false;
    const ex = c.exactMatch !== false;
    if (c.fieldType === 'attribute') {
      for (const a of (server.attributes || [])) {
        if ((eq(a.name, c.attributeName, ci) || eq(a.textkey, c.attributeName, ci))
            && valMatch(a.value, c.value, ex, ci)) return { value: a.value, attributeName: a.name };
      }
      return null;
    }
    if (c.fieldType === 'name') return valMatch(server.name, c.value, ex, ci) ? { value: server.name } : null;
    if (c.fieldType === 'fqdn') {
      if (valMatch(server.fqdn, c.value, ex, ci)) return { value: server.fqdn };
      for (const f of (server.additional_fqdns || [])) if (valMatch(f, c.value, ex, ci)) return { value: f };
      return null;
    }
    if (c.fieldType === 'tag') {
      for (const t of (server.tags || [])) if (valMatch(t, c.value, ex, ci)) return { value: t };
      return null;
    }
    if (c.fieldType === 'status') return eq(server.status, c.value, true) ? { value: server.status } : null;
    if (c.fieldType === 'device_type') {
      if (valMatch(server.device_type, c.value, ex, ci)) return { value: server.device_type };
      if (valMatch(server.device_sub_type, c.value, ex, ci)) return { value: server.device_sub_type };
      return null;
    }
    if (c.fieldType === 'has_active_outage') {
      const has = ACTIVE_OUTAGE_IDS.has(server.id);
      return Boolean(c.value) === has ? { value: has } : null;
    }
    if (c.fieldType === 'applied_template') {
      const set = TEMPLATE_APPLIED_SETS[c.templateUrl] || new Set();
      const isAttached = set.has(server.id);
      const want = c.match === 'not_attached' ? !isAttached : isAttached;
      return want ? { templateUrl: c.templateUrl, templateName: c.templateName, attached: isAttached } : null;
    }
    return null;
  }

  function matchesByCriteria(server, criteria, mode) {
    if (!criteria.length) return { matched: false, info: [] };
    const info = [];
    let any = false;
    for (let i = 0; i < criteria.length; i++) {
      const r = matchOne(server, criteria[i]);
      if (r) { any = true; info.push({ index: i, fieldType: criteria[i].fieldType, ...r }); }
      else if (mode === 'all') return { matched: false, info: [] };
    }
    return { matched: mode === 'all' ? true : any, info };
  }

  function shape(server, info, source) {
    return {
      id: server.id, name: server.name, fqdn: server.fqdn,
      additionalFqdns: server.additional_fqdns || [],
      deviceType: server.device_type, deviceSubType: server.device_sub_type,
      status: server.status, tags: server.tags || [], attributes: server.attributes || [],
      matchedCriteria: info, source: source || null
    };
  }

  function classifyId(raw) {
    const m = raw.match(/\\/instance\\/(\\d+)\\b/i);
    if (m) return { kind: 'url', raw, serverId: Number(m[1]) };
    if (/^\\d+$/.test(raw)) return { kind: 'id', raw, serverId: Number(raw) };
    return { kind: 'name', raw, name: raw };
  }
  const getById = (id) => SERVERS.find((s) => s.id === id) || null;
  const getByName = (name) => SERVERS.filter((s) => s.name === name);

  // Patch chrome.runtime.sendMessage / onMessage. The toolkit's
  // messaging.js layer reads chrome.runtime via the global, so replacing
  // window.chrome is sufficient and runs before any module evaluates
  // because addInitScript executes on every page navigation before
  // document scripts load.
  const messageListeners = new Set();
  function emit(event, payload) {
    const msg = { type: '__event__', event, payload };
    for (const fn of messageListeners) {
      try { fn(msg, {}, () => {}); } catch (e) { /* swallow */ }
    }
  }

  window.chrome = {
    runtime: {
      id: 'fmtoolkit-e2e-stub',
      getURL: (p) => p,
      lastError: null,
      sendMessage: (message, callback) => {
        const type = message && message.type;
        const payload = (message && message.payload) || {};
        // Defer to next microtask so callers that immediately read
        // chrome.runtime.lastError get null first.
        setTimeout(() => {
          try {
            if (type === 'search:list-attribute-types') {
              return callback({ ok: true, result: SUGGESTIONS });
            }
            if (type === 'search:list-device-types') {
              return callback({ ok: true, result: DEVICE_TYPES });
            }
            if (type === 'search:servers') {
              const ids = Array.isArray(payload.identifiers) ? payload.identifiers : [];
              const criteria = (Array.isArray(payload.criteria) ? payload.criteria : []).map((c) => {
                const out = { ...c };
                if (out.caseInsensitive == null) out.caseInsensitive = payload.caseInsensitive !== false;
                return out;
              });
              const mode = payload.mode === 'any' ? 'any' : 'all';

              const matches = [];
              if (ids.length > 0) {
                for (const raw of ids) {
                  const cls = classifyId(raw);
                  let server = null;
                  if (cls.kind === 'name') {
                    const ms = getByName(cls.name);
                    if (ms.length === 1) server = ms[0];
                  } else {
                    server = getById(cls.serverId);
                  }
                  if (!server) continue;
                  if (criteria.length === 0) { matches.push(shape(server, [], cls)); continue; }
                  const r = matchesByCriteria(server, criteria, mode);
                  if (r.matched) matches.push(shape(server, r.info, cls));
                }
                emit('search:page', { fetched: ids.length, total: ids.length, matches: matches.length });
              } else {
                for (const s of SERVERS) {
                  const r = matchesByCriteria(s, criteria, mode);
                  if (r.matched) matches.push(shape(s, r.info, null));
                }
                emit('search:page', { fetched: SERVERS.length, total: SERVERS.length, matches: matches.length });
              }

              return callback({ ok: true, result: {
                identifiers: ids, criteria, mode,
                caseInsensitive: payload.caseInsensitive !== false,
                matches,
                totalScanned: ids.length > 0 ? ids.length : SERVERS.length,
                totalAvailable: ids.length > 0 ? ids.length : SERVERS.length,
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString()
              }});
            }
            if (type === 'search:abort') {
              return callback({ ok: true, result: { aborted: false, reason: 'stub' } });
            }
            if (type === 'search:list-templates') {
              return callback({ ok: true, result: TEMPLATES });
            }
            callback({ ok: false, error: 'stub: unknown message type ' + type });
          } catch (err) {
            callback({ ok: false, error: String(err && err.message || err) });
          }
        }, 0);
      },
      onMessage: {
        addListener: (fn) => messageListeners.add(fn),
        removeListener: (fn) => messageListeners.delete(fn)
      }
    }
  };
})();
`;
