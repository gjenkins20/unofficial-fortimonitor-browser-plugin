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

function extractIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/(\d+)\/?$/);
  return m ? Number(m[1]) : null;
}

// Build a {id -> name} map from a list of records that each have
// {url, name}.
function buildIdNameMap(records, fallbackName = null) {
  const map = new Map();
  for (const r of records ?? []) {
    if (!r || typeof r !== 'object') continue;
    const id = extractIdFromUrl(r.url) ?? r.id ?? null;
    const name = typeof r.name === 'string' && r.name ? r.name : fallbackName;
    if (id != null && name) map.set(id, name);
  }
  return map;
}

function buildServerCorpus(server, groupNameById, templateNameById) {
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
  return {
    id,
    name: server.name ?? '',
    fqdn: server.fqdn ?? '',
    additional_fqdns: Array.isArray(server.additional_fqdns) ? server.additional_fqdns : [],
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

// Identify which top-level field matched, for the result row's "matched
// in" badge. First-hit wins. Returns one of: name, fqdn, ip, description,
// tag, attribute, device_type, agent_version, group, template, status,
// or null.
function classifyMatch(server, q) {
  if (server.name && server.name.toLowerCase().includes(q)) return 'name';
  if (server.fqdn && server.fqdn.toLowerCase().includes(q)) return 'fqdn';
  if (server.additional_fqdns?.some((a) => String(a).toLowerCase().includes(q))) return 'ip';
  if (server.description && server.description.toLowerCase().includes(q)) return 'description';
  if (server.tags?.some((t) => String(t).toLowerCase().includes(q))) return 'tag';
  if (server.attributes?.some(
    (a) => String(a.value).toLowerCase().includes(q) || String(a.name).toLowerCase().includes(q)
  )) return 'attribute';
  if (server.device_type && server.device_type.toLowerCase().includes(q)) return 'device_type';
  if (server.device_sub_type && server.device_sub_type.toLowerCase().includes(q)) return 'device_type';
  if (server.agent_version && server.agent_version.toLowerCase().includes(q)) return 'agent_version';
  if (server.group_name && server.group_name.toLowerCase().includes(q)) return 'group';
  if (server.template_names?.some((t) => String(t).toLowerCase().includes(q))) return 'template';
  if (server.status && server.status.toLowerCase().includes(q)) return 'status';
  return null;
}

function searchCache(cache, query, max = MAX_RESULTS_DEFAULT) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return { query: '', total: 0, matches: [] };
  const matches = [];
  for (let i = 0; i < cache.corpus.length; i++) {
    if (cache.corpus[i].indexOf(q) === -1) continue;
    const server = cache.servers[i];
    matches.push({
      ...server,
      matched_field: classifyMatch(server, q) ?? 'other',
    });
    if (matches.length >= max) break;
  }
  return { query: q, total: matches.length, matches };
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
