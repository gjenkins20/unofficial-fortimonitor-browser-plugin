// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-152: in-page omni-search across every searchable server field.
//
// Caches a single denormalized search corpus per tenant origin:
//   { tenantOrigin, fetchedAt, servers: [{id, name, fqdn, additional_fqdns,
//     description, tags, attributes, device_type, device_sub_type,
//     agent_version, group_name, template_names, status, server_key,
//     partner_server_id, detail_path}], corpus: [string-per-server] }
//
// The corpus string for each server is lowercased and joined with newlines
// so substring-search is a single .indexOf() against the joined string.
// Memory mv3_sendmessage_multimb_stall: we only return MATCHED results
// to the content script (max ~20), never the full corpus. The cache
// itself stays in chrome.storage.session backed by an in-memory mirror,
// so a SW wake re-reads from storage rather than re-fetching from the
// FortiMonitor API.

import {
  createProductionPanoptaClient,
  PanoptaError
} from '../lib/panopta-client.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const STORAGE_KEY_PREFIX = 'fm:omni-search-cache:';
const MAX_RESULTS_DEFAULT = 20;

// FMN-153: classify address-shaped strings locally. Duplicate of the
// classifier in src/content/augment.js (intentionally inline - content
// scripts can't ES-import). Returns 'ipv4' | 'ipv6' | 'dns' | null.
// Hostname rule requires at least one dot to reject bare-word values
// (e.g., the literal "server" observed as fqdn on some instances).
const FMN153_IPV4_RE = /^(25[0-5]|2[0-4]\d|[01]?\d?\d)(\.(25[0-5]|2[0-4]\d|[01]?\d?\d)){3}$/;
const FMN153_IPV6_RE = /^[0-9a-fA-F:]+:[0-9a-fA-F:]+$/;
const FMN153_HOST_RE = /^[a-zA-Z0-9]([-a-zA-Z0-9]{0,62}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([-a-zA-Z0-9]{0,62}[a-zA-Z0-9])?)+\.?$/;
function classifyAddressToken(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  if (FMN153_IPV4_RE.test(v)) return 'ipv4';
  if (v.includes(':') && FMN153_IPV6_RE.test(v)) return 'ipv6';
  if (FMN153_HOST_RE.test(v) && v.includes('.')) return 'dns';
  return null;
}
// Split a list of FQDN strings into deduped ips[] / dnsNames[] arrays.
function partitionAddresses(tokens) {
  const ips = [];
  const ipSet = new Set();
  const dnsNames = [];
  const dnsSet = new Set();
  for (const t of tokens) {
    const kind = classifyAddressToken(t);
    if (!kind) continue;
    const v = t.trim();
    if (kind === 'ipv4' || kind === 'ipv6') {
      if (!ipSet.has(v)) { ipSet.add(v); ips.push(v); }
    } else if (kind === 'dns') {
      if (!dnsSet.has(v)) { dnsSet.add(v); dnsNames.push(v); }
    }
  }
  return { ips, dnsNames };
}

let memCache = new Map(); // tenantOrigin -> { fetchedAt, servers, corpus }
let pendingBuilds = new Map(); // tenantOrigin -> Promise<cache>, dedupes concurrent builds

function cacheKey(tenantOrigin) {
  return STORAGE_KEY_PREFIX + tenantOrigin;
}

async function readCacheFromStorage(tenantOrigin) {
  try {
    const data = await chrome.storage.session.get(cacheKey(tenantOrigin));
    return data?.[cacheKey(tenantOrigin)] ?? null;
  } catch {
    return null;
  }
}

async function writeCacheToStorage(tenantOrigin, cache) {
  try {
    await chrome.storage.session.set({ [cacheKey(tenantOrigin)]: cache });
  } catch {
    // chrome.storage.session has a per-extension quota; cache may be too
    // large on very big tenants. Mem-only is acceptable then.
  }
}

function isFresh(cache) {
  if (!cache || typeof cache.fetchedAt !== 'number') return false;
  return Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

export function extractIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/(\d+)\/?$/);
  return m ? Number(m[1]) : null;
}

// Build a {id -> name} map from a list of records that each have
// {url, name}.
export function buildIdNameMap(records, fallbackName = null) {
  const map = new Map();
  for (const r of records ?? []) {
    if (!r || typeof r !== 'object') continue;
    const id = extractIdFromUrl(r.url) ?? r.id ?? null;
    const name = typeof r.name === 'string' && r.name ? r.name : fallbackName;
    if (id != null && name) map.set(id, name);
  }
  return map;
}

export function buildServerCorpus(server, groupNameById, templateNameById) {
  const parts = [];
  const push = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) {
      for (const x of v) push(x);
      return;
    }
    if (typeof v === 'object') return; // ignore nested unless caller flattens first
    const s = String(v).trim();
    if (s) parts.push(s);
  };
  push(server.name);
  push(server.fqdn);
  push(server.additional_fqdns);
  push(server.description);
  push(server.tags);
  push(server.device_type);
  push(server.device_sub_type);
  push(server.agent_version);
  push(server.status);
  push(server.server_key);
  push(server.partner_server_id);
  // Flatten attributes: include both name and value so a query like
  // "operating system" matches the attribute name and "Linux" matches
  // the value.
  if (Array.isArray(server.attributes)) {
    for (const a of server.attributes) {
      push(a?.name);
      push(a?.textkey);
      push(a?.value);
    }
  }
  // Resolved group + template names so a query like "Default Monitoring
  // Templates" matches without needing to traverse URLs.
  const groupId = extractIdFromUrl(server.server_group);
  if (groupId != null && groupNameById.has(groupId)) push(groupNameById.get(groupId));
  if (Array.isArray(server.server_template)) {
    for (const t of server.server_template) {
      const tid = extractIdFromUrl(typeof t === 'string' ? t : t?.url);
      if (tid != null && templateNameById.has(tid)) push(templateNameById.get(tid));
    }
  }
  return parts.join('\n').toLowerCase();
}

// Compact per-server entry for the result dropdown. Keeps payload small
// (per memory mv3_sendmessage_multimb_stall).
function buildServerEntry(server, groupNameById, templateNameById) {
  const id = extractIdFromUrl(server.url) ?? server.id ?? null;
  const groupId = extractIdFromUrl(server.server_group);
  const templateNames = [];
  if (Array.isArray(server.server_template)) {
    for (const t of server.server_template) {
      const tid = extractIdFromUrl(typeof t === 'string' ? t : t?.url);
      if (tid != null && templateNameById.has(tid)) templateNames.push(templateNameById.get(tid));
    }
  }
  // FMN-153: classify fqdn + additional_fqdns into ips[] / dns_names[]
  // so the scorer and snippet renderer can label matches correctly. The
  // raw additional_fqdns array is kept for back-compat with any reader
  // that depends on it.
  const additional = Array.isArray(server.additional_fqdns) ? server.additional_fqdns : [];
  const { ips, dnsNames } = partitionAddresses([server.fqdn, ...additional]);
  return {
    id,
    name: server.name ?? '',
    fqdn: server.fqdn ?? '',
    additional_fqdns: additional,
    ips,
    dns_names: dnsNames,
    description: server.description ?? '',
    tags: Array.isArray(server.tags) ? server.tags : [],
    attributes: Array.isArray(server.attributes)
      ? server.attributes.map((a) => ({ name: a?.name ?? '', value: a?.value ?? '' }))
      : [],
    device_type: server.device_type ?? '',
    device_sub_type: server.device_sub_type ?? '',
    agent_version: server.agent_version ?? '',
    status: server.status ?? '',
    group_name: groupId != null ? (groupNameById.get(groupId) ?? '') : '',
    template_names: templateNames,
  };
}

// Paginate /v2/server at a high page size. limit=0 (the Swagger
// "give me everything" mode) was actually slower in practice on a
// real tenant - the giant single response took longer to transfer and
// parse than several 200-row pages with the parser running in parallel
// with subsequent network requests. 200 is a sweet spot for tenants up
// to a few thousand servers; bigger pages stall earlier rendering.
async function buildCache(tenantOrigin, factory) {
  const client = await factory();
  const [servers, groups, templates] = await Promise.all([
    client.listAllServers({ pageSize: 200 }),
    client._paginatedList('/server_group', { pageSize: 200 }).catch(() => []),
    client._paginatedList('/server_template', { pageSize: 200 }).catch(() => []),
  ]);
  const groupNameById = buildIdNameMap(groups);
  const templateNameById = buildIdNameMap(templates);
  const entries = [];
  const corpus = [];
  for (const s of servers ?? []) {
    if (!s) continue;
    entries.push(buildServerEntry(s, groupNameById, templateNameById));
    corpus.push(buildServerCorpus(s, groupNameById, templateNameById));
  }
  return { fetchedAt: Date.now(), tenantOrigin, servers: entries, corpus };
}

async function getCache(tenantOrigin, factory, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    let cache = memCache.get(tenantOrigin);
    if (!isFresh(cache)) {
      cache = await readCacheFromStorage(tenantOrigin);
      if (cache) memCache.set(tenantOrigin, cache);
    }
    if (isFresh(cache)) return cache;
  }
  // Dedupe concurrent builds: if a warm + a query land in the same window,
  // both await one fetch instead of triggering two parallel /v2/server walks.
  const inflight = pendingBuilds.get(tenantOrigin);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const fresh = await buildCache(tenantOrigin, factory);
      memCache.set(tenantOrigin, fresh);
      await writeCacheToStorage(tenantOrigin, fresh);
      return fresh;
    } finally {
      pendingBuilds.delete(tenantOrigin);
    }
  })();
  pendingBuilds.set(tenantOrigin, promise);
  return promise;
}

// Score a server against the (already-lowercased) query. Higher is more
// relevant; we sort matches by score so an exact-name hit always beats
// a record that incidentally contains the query in a different field.
//   1000 exact name
//    900 fqdn exact
//    800 name starts-with
//    700 fqdn starts-with
//    600 name contains
//    500 additional_fqdns (IP) contains
//    400 fqdn contains
//    300 tag exact
//    250 attribute name or value contains
//    200 description contains
//    150 group / template contains
//    100 device_type / agent_version / status contains
//      0 anything else (corpus hit but we can't classify)
// Returns { score, field } where field labels the strongest signal.
export function scoreServer(server, q) {
  const name = (server.name || '').toLowerCase();
  const fqdn = (server.fqdn || '').toLowerCase();
  if (name === q) return { score: 1000, field: 'name' };
  if (fqdn === q) return { score: 900, field: 'fqdn' };
  if (name.startsWith(q)) return { score: 800, field: 'name' };
  if (fqdn.startsWith(q)) return { score: 700, field: 'fqdn' };
  if (name.includes(q)) return { score: 600, field: 'name' };
  // FMN-153: differentiate IP matches from DNS-name matches so the
  // snippet renderer can label them accurately. ips[] and dns_names[]
  // are classified at ingest time (buildServerEntry).
  if ((server.ips || []).some((a) => String(a).toLowerCase().includes(q))) {
    return { score: 500, field: 'ip' };
  }
  if ((server.dns_names || []).some((a) => String(a).toLowerCase().includes(q))) {
    return { score: 500, field: 'dns' };
  }
  // Fallback: legacy additional_fqdns hit (token didn't pass strict
  // classification but the operator pre-FMN-153 corpus would have
  // matched it). Score it the same; field label is generic.
  if ((server.additional_fqdns || []).some((a) => String(a).toLowerCase().includes(q))) {
    return { score: 480, field: 'fqdn' };
  }
  if (fqdn.includes(q)) return { score: 400, field: 'fqdn' };
  if ((server.tags || []).some((t) => String(t).toLowerCase() === q)) {
    return { score: 350, field: 'tag' };
  }
  if ((server.tags || []).some((t) => String(t).toLowerCase().includes(q))) {
    return { score: 300, field: 'tag' };
  }
  if ((server.attributes || []).some(
    (a) => String(a.value).toLowerCase().includes(q) || String(a.name).toLowerCase().includes(q)
  )) return { score: 250, field: 'attribute' };
  if ((server.description || '').toLowerCase().includes(q)) return { score: 200, field: 'description' };
  if ((server.group_name || '').toLowerCase().includes(q)) return { score: 150, field: 'group' };
  if ((server.template_names || []).some((t) => String(t).toLowerCase().includes(q))) {
    return { score: 150, field: 'template' };
  }
  if ((server.device_type || '').toLowerCase().includes(q)) return { score: 100, field: 'device_type' };
  if ((server.device_sub_type || '').toLowerCase().includes(q)) return { score: 100, field: 'device_type' };
  if ((server.agent_version || '').toLowerCase().includes(q)) return { score: 100, field: 'agent_version' };
  if ((server.status || '').toLowerCase().includes(q)) return { score: 100, field: 'status' };
  return { score: 0, field: 'other' };
}

export function searchCache(cache, query, max = MAX_RESULTS_DEFAULT) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return { query: '', total: 0, matches: [] };
  // Two-pass scan: substring filter against the denormalized corpus
  // (fast), then per-row relevance score. We materialize ALL scored hits
  // and sort, then trim to `max`. The relevance step is O(n) where n is
  // total hits, which on a 1k-server tenant is bounded by tenant size.
  const scored = [];
  for (let i = 0; i < cache.corpus.length; i++) {
    if (cache.corpus[i].indexOf(q) === -1) continue;
    const server = cache.servers[i];
    const { score, field } = scoreServer(server, q);
    scored.push({ score, server, field });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable secondary: name asc so equal-score results have a
    // deterministic order rather than API-order.
    const an = (a.server.name || '').toLowerCase();
    const bn = (b.server.name || '').toLowerCase();
    return an.localeCompare(bn);
  });
  const matches = scored.slice(0, max).map(({ server, field }) => ({
    ...server,
    matched_field: field,
  }));
  return { query: q, total: scored.length, matches };
}

export function createOmniSearchHandlers({ events = {}, getClient } = {}) {
  const factory = getClient ?? (() => createProductionPanoptaClient());

  return {
    'omni-search:status': async ({ tenantOrigin } = {}) => {
      const origin = tenantOrigin || 'api2.panopta.com';
      let cache = memCache.get(origin);
      if (!cache) cache = await readCacheFromStorage(origin);
      if (!cache) return { cached: false };
      return {
        cached: true,
        fetchedAt: cache.fetchedAt,
        ageMs: Date.now() - cache.fetchedAt,
        fresh: isFresh(cache),
        serverCount: Array.isArray(cache.servers) ? cache.servers.length : 0,
      };
    },

    'omni-search:query': async ({ query, tenantOrigin, max } = {}) => {
      const origin = tenantOrigin || 'api2.panopta.com';
      const cache = await getCache(origin, factory);
      return searchCache(cache, query, Number.isFinite(max) ? max : MAX_RESULTS_DEFAULT);
    },

    'omni-search:refresh': async ({ tenantOrigin } = {}) => {
      const origin = tenantOrigin || 'api2.panopta.com';
      const cache = await getCache(origin, factory, { forceRefresh: true });
      return { fetchedAt: cache.fetchedAt, serverCount: cache.servers.length };
    },

    // Background warm: build the cache if it's missing or stale, so the
    // operator's first typed query doesn't wait for the network. Idempotent
    // and safe to call eagerly from the content-script mount path.
    'omni-search:warm': async ({ tenantOrigin } = {}) => {
      const origin = tenantOrigin || 'api2.panopta.com';
      const cache = await getCache(origin, factory);
      return { fetchedAt: cache.fetchedAt, serverCount: cache.servers.length };
    },
  };
}
