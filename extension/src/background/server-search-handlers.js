// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Background handlers for the unified Find Servers tool (FMN-65, FMN-114).
//
// Finds servers by any combination of:
//   1. Identifiers (server names, FortiMonitor instance URLs, server IDs)
//   2. Filter criteria (one or more, AND or OR'd)
// and reports per-server records the UI can shape into operator-chosen
// output columns.
//
// Per FMN-65, the v2 API has no per-attribute filter and no compound filter,
// so all matching is client-side over the paged /server list.
//
// CRITERION SHAPES
//
// Every criterion has { fieldType }. Per fieldType:
//   attribute       : { fieldType, attributeName, value, exactMatch?, caseInsensitive? }
//   name            : { fieldType, value, exactMatch?, caseInsensitive? }
//   fqdn            : { fieldType, value, exactMatch?, caseInsensitive? }
//   tag             : { fieldType, value, exactMatch?, caseInsensitive? }
//   device_type     : { fieldType, value, exactMatch?, caseInsensitive? }
//   status          : { fieldType, value }   // 'active' | 'paused' | 'inactive'
//   has_active_outage: { fieldType, value }  // true | false
//   applied_template: { fieldType, templateUrl, templateName?, match }   // FMN-121: 'attached' | 'not_attached'
//
// Auth: v2 API key via createProductionPanoptaClient (read-only).

import {
  createProductionPanoptaClient,
  PanoptaError
} from '../lib/panopta-client.js';

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryable(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  if (err instanceof PanoptaError || err?.name === 'PanoptaError') {
    if (err.phase === 'auth') return false;
    if (err.status === null || err.status === undefined) return true;
    return RETRYABLE_STATUSES.has(err.status);
  }
  return true;
}

function extractServerId(server) {
  if (server == null) return null;
  if (server.id != null) return server.id;
  if (typeof server.url === 'string') {
    const m = server.url.match(/\/server\/(\d+)\/?$/);
    if (m) return Number(m[1]);
  }
  return null;
}

// ---- Per-field-type matchers --------------------------------------
//
// Each returns { matched, info? } where info is a compact description of
// the hit (used by the UI to show per-row source/match-detail).

function eqMaybeCI(a, b, caseInsensitive) {
  if (a == null || b == null) return false;
  if (!caseInsensitive) return String(a) === String(b);
  return String(a).toLowerCase() === String(b).toLowerCase();
}
function containsMaybeCI(haystack, needle, caseInsensitive) {
  if (haystack == null || needle == null) return false;
  if (!caseInsensitive) return String(haystack).includes(String(needle));
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}
function valueMatch(haystack, want, exact, caseInsensitive) {
  return exact
    ? eqMaybeCI(haystack, want, caseInsensitive)
    : containsMaybeCI(haystack, want, caseInsensitive);
}

export function matchesAttribute(server, {
  attributeName,
  value,
  exactMatch = true,
  caseInsensitive = true
} = {}) {
  if (!server || !attributeName || value == null) return { matched: false };
  if (!Array.isArray(server.attributes)) return { matched: false };
  for (const attr of server.attributes) {
    if (!eqMaybeCI(attr?.name, attributeName, caseInsensitive)
        && !eqMaybeCI(attr?.textkey, attributeName, caseInsensitive)) continue;
    if (!valueMatch(attr?.value, value, exactMatch, caseInsensitive)) continue;
    return { matched: true, info: { attributeName: attr.name ?? null, textkey: attr.textkey ?? null, value: attr.value ?? null } };
  }
  return { matched: false };
}

export function matchesName(server, { value, exactMatch = true, caseInsensitive = true } = {}) {
  if (!server || value == null) return { matched: false };
  if (!valueMatch(server.name, value, exactMatch, caseInsensitive)) return { matched: false };
  return { matched: true, info: { value: server.name } };
}

export function matchesFqdn(server, { value, exactMatch = true, caseInsensitive = true } = {}) {
  if (!server || value == null) return { matched: false };
  if (valueMatch(server.fqdn, value, exactMatch, caseInsensitive)) {
    return { matched: true, info: { value: server.fqdn } };
  }
  if (Array.isArray(server.additional_fqdns)) {
    for (const f of server.additional_fqdns) {
      if (valueMatch(f, value, exactMatch, caseInsensitive)) {
        return { matched: true, info: { value: f } };
      }
    }
  }
  return { matched: false };
}

export function matchesTag(server, { value, exactMatch = true, caseInsensitive = true } = {}) {
  if (!server || value == null) return { matched: false };
  if (!Array.isArray(server.tags)) return { matched: false };
  for (const tag of server.tags) {
    if (valueMatch(tag, value, exactMatch, caseInsensitive)) {
      return { matched: true, info: { value: tag } };
    }
  }
  return { matched: false };
}

export function matchesStatus(server, { value } = {}) {
  if (!server || value == null) return { matched: false };
  // Status comparison is always exact + case-insensitive (the API enum is
  // a fixed set: active / paused / inactive).
  if (eqMaybeCI(server.status, value, true)) {
    return { matched: true, info: { value: server.status } };
  }
  return { matched: false };
}

export function matchesDeviceType(server, { value, exactMatch = true, caseInsensitive = true } = {}) {
  if (!server || value == null) return { matched: false };
  for (const field of ['device_type', 'device_sub_type']) {
    if (valueMatch(server[field], value, exactMatch, caseInsensitive)) {
      return { matched: true, info: { value: server[field], field } };
    }
  }
  return { matched: false };
}

export function matchesHasActiveOutage(server, { value } = {}, ctx = {}) {
  // Boolean criterion. The active-outage server-id Set is precomputed
  // before the page loop and lives in ctx.activeOutageServerIds.
  const set = ctx.activeOutageServerIds;
  if (!set) return { matched: false };
  const id = extractServerId(server);
  const has = id != null && set.has(id);
  if (Boolean(value) === has) {
    return { matched: true, info: { value: has } };
  }
  return { matched: false };
}

export function matchesAppliedTemplate(server, { templateUrl, templateName, match = 'attached' } = {}, ctx = {}) {
  // FMN-121: ctx.appliedTemplateSets is a Map<templateUrl, Set<serverId>>
  // populated before the criteria loop. matchesByCriteria reads it via
  // ctx; we don't fetch lazily per-server (would be N+1 over the result
  // set, defeating the single-call advantage of /server_template/{id}).
  const sets = ctx.appliedTemplateSets;
  if (!sets || !templateUrl) return { matched: false };
  const set = sets.get(templateUrl);
  if (!set) return { matched: false };
  const id = extractServerId(server);
  const isAttached = id != null && set.has(id);
  const want = match === 'not_attached' ? !isAttached : isAttached;
  if (!want) return { matched: false };
  return {
    matched: true,
    info: { templateUrl, templateName: templateName ?? null, attached: isAttached }
  };
}

const FIELD_MATCHERS = {
  attribute: matchesAttribute,
  name: matchesName,
  fqdn: matchesFqdn,
  tag: matchesTag,
  device_type: matchesDeviceType,
  status: matchesStatus,
  has_active_outage: matchesHasActiveOutage,
  applied_template: matchesAppliedTemplate
};

/**
 * Apply a single criterion to a server. Dispatches on fieldType.
 */
export function matchOneCriterion(server, criterion, ctx = {}) {
  const fn = FIELD_MATCHERS[criterion?.fieldType];
  if (!fn) return { matched: false };
  return fn(server, criterion, ctx);
}

/**
 * Apply N criteria to a server with AND or OR semantics. Returns
 * { matched, criteriaInfo } where criteriaInfo is a parallel array of
 * per-criterion match details (only populated for criteria that hit).
 *
 * @param {object} server
 * @param {Array<object>} criteria
 * @param {'all'|'any'} [mode='all']
 * @param {object} [ctx]
 */
export function matchesByCriteria(server, criteria, mode = 'all', ctx = {}) {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { matched: false, criteriaInfo: [] };
  }
  const info = [];
  let anyMatched = false;
  for (let i = 0; i < criteria.length; i++) {
    const r = matchOneCriterion(server, criteria[i], ctx);
    if (r.matched) {
      anyMatched = true;
      info.push({ index: i, fieldType: criteria[i].fieldType, ...r.info });
    } else if (mode === 'all') {
      return { matched: false, criteriaInfo: [] };
    }
  }
  return { matched: mode === 'all' ? true : anyMatched, criteriaInfo: info };
}

/**
 * Shape a matched raw /server record into the result row consumed by the
 * UI. The full server record is included so the UI can pick output
 * columns dynamically (id, name, fqdn, status, tags, device_type, plus
 * any chosen attribute).
 */
export function shapeMatch(server, criteriaInfo, source = null) {
  return {
    id: extractServerId(server),
    name: server.name ?? null,
    fqdn: server.fqdn ?? null,
    additionalFqdns: Array.isArray(server.additional_fqdns) ? server.additional_fqdns.slice() : [],
    deviceType: server.device_type ?? null,
    deviceSubType: server.device_sub_type ?? null,
    status: server.status ?? null,
    tags: Array.isArray(server.tags) ? server.tags.slice() : [],
    attributes: Array.isArray(server.attributes) ? server.attributes.slice() : [],
    matchedCriteria: Array.isArray(criteriaInfo) ? criteriaInfo.slice() : [],
    source: source ?? null
  };
}

// ---- Criterion normalization ---------------------------------------

const STRING_FIELDS = new Set(['attribute', 'name', 'fqdn', 'tag', 'device_type']);

function normalizeCriterion(raw, index, toolCaseInsensitive) {
  const fieldType = String(raw?.fieldType ?? '').trim();
  if (!FIELD_MATCHERS[fieldType]) {
    throw new Error(`criterion ${index}: unknown fieldType "${fieldType}"`);
  }
  if (fieldType === 'has_active_outage') {
    return { fieldType, value: raw?.value === true };
  }
  if (fieldType === 'status') {
    const v = String(raw?.value ?? '').trim();
    if (!v) throw new Error(`criterion ${index}: value is required`);
    return { fieldType, value: v };
  }
  if (fieldType === 'attribute') {
    const attributeName = String(raw?.attributeName ?? '').trim();
    const value = String(raw?.value ?? '').trim();
    if (!attributeName) throw new Error(`criterion ${index}: attributeName is required`);
    if (!value) throw new Error(`criterion ${index}: value is required`);
    return {
      fieldType,
      attributeName,
      value,
      exactMatch: raw?.exactMatch !== false,
      caseInsensitive: raw?.caseInsensitive !== false ? true : false
    };
  }
  if (STRING_FIELDS.has(fieldType)) {
    const value = String(raw?.value ?? '').trim();
    if (!value) throw new Error(`criterion ${index}: value is required`);
    return {
      fieldType,
      value,
      exactMatch: raw?.exactMatch !== false,
      caseInsensitive: raw?.caseInsensitive !== false ? true : false
    };
  }
  if (fieldType === 'applied_template') {
    const templateUrl = String(raw?.templateUrl ?? '').trim();
    if (!templateUrl) throw new Error(`criterion ${index}: templateUrl is required`);
    const match = raw?.match === 'not_attached' ? 'not_attached' : 'attached';
    const templateName = raw?.templateName ? String(raw.templateName).trim() : null;
    return { fieldType, templateUrl, templateName, match };
  }
  // unreachable
  throw new Error(`criterion ${index}: cannot normalise`);
}

// ---- Active-outage prefetch ---------------------------------------

/**
 * Pre-fetch the set of server IDs that currently have an active outage.
 * Only called when at least one criterion has fieldType='has_active_outage'.
 */
export async function fetchActiveOutageServerIds(client, { pageSize = 200, signal } = {}) {
  const ids = new Set();
  let offset = 0;
  let total = Infinity;
  for (let page = 0; page < 1000; page++) {
    if (signal?.aborted) {
      const err = new Error('aborted'); err.name = 'AbortError'; throw err;
    }
    const body = await client.listOutages({ limit: pageSize, offset, active: true });
    const list = Array.isArray(body?.outage_list) ? body.outage_list : (Array.isArray(body) ? body : []);
    if (typeof body?.meta?.total_count === 'number') total = body.meta.total_count;
    for (const o of list) {
      // Outage records reference their server via a URL like /server/N or
      // a server_id field; cover both shapes.
      let id = null;
      if (typeof o?.server === 'string') {
        const m = o.server.match(/\/server\/(\d+)/);
        if (m) id = Number(m[1]);
      }
      if (id == null && o?.server_id != null) id = Number(o.server_id);
      if (id != null && Number.isFinite(id)) ids.add(id);
    }
    offset += list.length;
    if (list.length === 0) break;
    if (Number.isFinite(total) && offset >= total) break;
  }
  return ids;
}

// ---- Applied-template prefetch (FMN-121) --------------------------

/**
 * For each template URL in the input list, fetch the template's
 * applied_servers via GET /server_template/{id} and return a
 * Map<templateUrl, Set<serverId>>. One round-trip per unique template.
 */
export async function fetchAppliedTemplateSets(client, templateUrls, { signal } = {}) {
  const out = new Map();
  for (const url of templateUrls) {
    if (signal?.aborted) {
      const err = new Error('aborted'); err.name = 'AbortError'; throw err;
    }
    const m = String(url).match(/\/server_template\/(\d+)\/?$/);
    const id = m ? m[1] : null;
    if (!id) {
      out.set(url, new Set());
      continue;
    }
    try {
      const tpl = await client.getServerTemplate(id);
      out.set(url, new Set(tpl.appliedServerIds));
    } catch (err) {
      // 404 -> empty set (template doesn't exist on this tenant); other
      // errors propagate.
      if ((err instanceof PanoptaError || err?.name === 'PanoptaError') && err.status === 404) {
        out.set(url, new Set());
        continue;
      }
      throw err;
    }
  }
  return out;
}

// ---- Identifier resolution ----------------------------------------

const URL_INSTANCE_PATTERN = /\/instance\/(\d+)\b/i;

function classifyIdentifier(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(URL_INSTANCE_PATTERN);
  if (urlMatch) {
    const id = Number(urlMatch[1]);
    if (Number.isFinite(id) && id > 0) return { kind: 'url', raw: trimmed, serverId: id };
  }
  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    if (Number.isFinite(id) && id > 0) return { kind: 'id', raw: trimmed, serverId: id };
  }
  return { kind: 'name', raw: trimmed, name: trimmed };
}

/**
 * Resolve identifier inputs (mixed names / URLs / IDs) to full server
 * records. Names are looked up via lookupServersByName + getServer (to
 * fetch the full record for filtering). URL/ID entries fire getServer
 * directly. Each result row carries a `source` describing where the id
 * came from.
 *
 * Skipped name entries (ambiguous, not_found, or error) are reported in
 * the result list with status set, but with no full server record.
 */
export async function resolveIdentifiers(client, identifiers, { signal } = {}) {
  const resolved = [];
  for (const raw of identifiers) {
    if (signal?.aborted) {
      const err = new Error('aborted'); err.name = 'AbortError'; throw err;
    }
    const cls = typeof raw === 'string' ? classifyIdentifier(raw) : raw;
    if (!cls) continue;
    if (cls.kind === 'name') {
      try {
        const matches = await client.lookupServersByName(cls.name);
        if (matches.length === 0) {
          resolved.push({ source: cls, status: 'not_found', server: null });
        } else if (matches.length > 1) {
          resolved.push({ source: cls, status: 'ambiguous', server: null, matches });
        } else {
          // Fetch the full record so the criteria matcher has every field.
          try {
            const server = await client.getServer(matches[0].id);
            resolved.push({ source: cls, status: 'found', server });
          } catch (err) {
            resolved.push({ source: cls, status: 'error', server: null, error: err?.message ?? String(err) });
          }
        }
      } catch (err) {
        resolved.push({ source: cls, status: 'error', server: null, error: err?.message ?? String(err) });
      }
      continue;
    }
    // url or id - fetch the full record; 404 -> not_found.
    try {
      const server = await client.getServer(cls.serverId);
      resolved.push({ source: cls, status: 'found', server });
    } catch (err) {
      if ((err instanceof PanoptaError || err?.name === 'PanoptaError') && err.status === 404) {
        resolved.push({ source: cls, status: 'not_found', server: null });
      } else {
        resolved.push({ source: cls, status: 'error', server: null, error: err?.message ?? String(err) });
      }
    }
  }
  return resolved;
}

// ---- Top-level search ---------------------------------------------

/**
 * Find servers by any combination of identifiers and criteria.
 *
 * @param {object} args
 * @param {object} args.client
 * @param {Array<string|object>} [args.identifiers]
 * @param {Array<object>} [args.criteria]
 * @param {'all'|'any'} [args.mode='all']
 * @param {boolean} [args.caseInsensitive=true]
 * @param {number}  [args.pageSize=100]
 * @param {AbortSignal} [args.signal]
 * @param {(evt) => void} [args.onPage]
 */
export async function findServers({
  client,
  identifiers = [],
  criteria = [],
  mode = 'all',
  caseInsensitive = true,
  pageSize = 100,
  maxPages = 1000,
  signal,
  onPage
} = {}) {
  if (!client) throw new TypeError('findServers: client is required');
  if ((!identifiers || identifiers.length === 0) && (!criteria || criteria.length === 0)) {
    throw new Error('findServers: at least one of identifiers or criteria is required');
  }

  // Stamp tool-level case-insensitive onto string criteria when callers
  // omit it; explicit per-criterion settings always win.
  const normalizedCriteria = (criteria || []).map((c, i) => {
    const merged = { ...c };
    if (STRING_FIELDS.has(c?.fieldType) && c?.caseInsensitive == null) {
      merged.caseInsensitive = caseInsensitive;
    }
    return normalizeCriterion(merged, i, caseInsensitive);
  });

  // Pre-fetch active-outage set if any criterion needs it.
  const ctx = {};
  if (normalizedCriteria.some((c) => c.fieldType === 'has_active_outage')) {
    ctx.activeOutageServerIds = await fetchActiveOutageServerIds(client, { signal });
  }
  // FMN-121: pre-fetch applied_servers per template URL when applied_template
  // criteria are present. One GET /server_template/{id} per unique template.
  const templateUrls = new Set();
  for (const c of normalizedCriteria) {
    if (c.fieldType === 'applied_template' && c.templateUrl) templateUrls.add(c.templateUrl);
  }
  if (templateUrls.size > 0) {
    ctx.appliedTemplateSets = await fetchAppliedTemplateSets(client, [...templateUrls], { signal });
  }

  // Path A: identifiers given. Resolve them; if criteria also given,
  // intersect by applying matchesByCriteria to each resolved server.
  if (identifiers && identifiers.length > 0) {
    const resolved = await resolveIdentifiers(client, identifiers, { signal });
    const matches = [];
    for (const entry of resolved) {
      if (entry.status !== 'found') continue;
      if (normalizedCriteria.length === 0) {
        matches.push(shapeMatch(entry.server, [], entry.source));
        continue;
      }
      const r = matchesByCriteria(entry.server, normalizedCriteria, mode, ctx);
      if (r.matched) matches.push(shapeMatch(entry.server, r.criteriaInfo, entry.source));
    }
    onPage?.({ fetched: resolved.length, total: resolved.length, matches: matches.length });
    return { matches, totalScanned: resolved.length, totalAvailable: resolved.length, resolved };
  }

  // Path B: criteria-only. Page through /server.
  const matches = [];
  let offset = 0;
  let totalAvailable = Infinity;
  let fetched = 0;
  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) {
      const err = new Error('aborted'); err.name = 'AbortError'; throw err;
    }
    const body = await client.listServers({ limit: pageSize, offset });
    const list = Array.isArray(body?.server_list) ? body.server_list : [];
    if (typeof body?.meta?.total_count === 'number') totalAvailable = body.meta.total_count;
    for (const server of list) {
      const r = matchesByCriteria(server, normalizedCriteria, mode, ctx);
      if (r.matched) matches.push(shapeMatch(server, r.criteriaInfo, null));
    }
    fetched += list.length;
    offset += list.length;
    onPage?.({
      fetched,
      total: Number.isFinite(totalAvailable) ? totalAvailable : fetched,
      matches: matches.length
    });
    if (list.length === 0) break;
    if (Number.isFinite(totalAvailable) && fetched >= totalAvailable) break;
  }
  return {
    matches,
    totalScanned: fetched,
    totalAvailable: Number.isFinite(totalAvailable) ? totalAvailable : fetched,
    resolved: null
  };
}

// ---- Message handlers ---------------------------------------------

export function createServerSearchHandlers({ events = {}, getClient } = {}) {
  const emit = events.emit ?? (() => {});
  const factory = getClient ?? (() => createProductionPanoptaClient());

  let currentRun = null;

  return {
    'search:list-attribute-types': async (payload) => {
      // Same as before: union /server_attribute_type catalog with attributes
      // discovered on a sample of /server records (covers built-ins like
      // Model and Operating System that the catalog never lists).
      const client = await factory();
      const sampleSize = Number.isFinite(payload?.sampleSize) ? payload.sampleSize : 100;

      const [catalog, sample] = await Promise.all([
        client.listAttributeTypes().catch(() => []),
        client.listServers({ limit: sampleSize, offset: 0 }).catch(() => ({ server_list: [] }))
      ]);

      const merged = new Map();
      const add = (name, textkey, source) => {
        if (!name) return;
        const key = String(name).toLowerCase();
        const existing = merged.get(key);
        if (existing) {
          if (!existing.textkey && textkey) existing.textkey = textkey;
          existing.sources.add(source);
        } else {
          merged.set(key, { name, textkey: textkey ?? null, sources: new Set([source]) });
        }
      };

      for (const t of catalog) add(t.name, t.textkey, 'catalog');

      const servers = Array.isArray(sample?.server_list) ? sample.server_list : [];
      for (const server of servers) {
        if (!Array.isArray(server?.attributes)) continue;
        for (const attr of server.attributes) add(attr?.name, attr?.textkey, 'server');
      }

      return Array.from(merged.values())
        .map((v) => ({ name: v.name, textkey: v.textkey, sources: Array.from(v.sources) }))
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    },

    'search:list-device-types': async (payload) => {
      // Sample /server records and surface the distinct device_type +
      // device_sub_type values seen, so the UI can offer a combobox.
      const client = await factory();
      const sampleSize = Number.isFinite(payload?.sampleSize) ? payload.sampleSize : 200;
      const sample = await client.listServers({ limit: sampleSize, offset: 0 }).catch(() => ({ server_list: [] }));
      const seen = new Set();
      const list = Array.isArray(sample?.server_list) ? sample.server_list : [];
      for (const s of list) {
        if (s?.device_type) seen.add(String(s.device_type));
        if (s?.device_sub_type) seen.add(String(s.device_sub_type));
      }
      return Array.from(seen).sort((a, b) => a.localeCompare(b));
    },

    'search:list-templates': async () => {
      // FMN-121: Find Servers's applied_template criterion needs a
      // template name picker. Reuses the same client method that drives
      // Manage Templates' picker; payload not needed (the catalog is
      // fully paginated client-side).
      const client = await factory();
      return client.listTemplates();
    },

    'search:servers': async (payload) => {
      if (currentRun) throw new Error('A server-search run is already in progress');
      const ac = new AbortController();
      const startedAt = new Date().toISOString();
      currentRun = { ac, startedAt };
      try {
        const identifiers = Array.isArray(payload?.identifiers) ? payload.identifiers : [];
        const criteria = Array.isArray(payload?.criteria) ? payload.criteria : [];
        if (identifiers.length === 0 && criteria.length === 0) {
          throw new Error('at least one of identifiers or criteria is required');
        }
        const mode = payload?.mode === 'any' ? 'any' : 'all';
        const caseInsensitive = payload?.caseInsensitive !== false;
        const pageSize = Number.isFinite(payload?.pageSize) ? payload.pageSize : 100;

        const client = await factory();
        const result = await findServers({
          client,
          identifiers,
          criteria,
          mode,
          caseInsensitive,
          pageSize,
          signal: ac.signal,
          onPage: (evt) => emit('search:page', evt)
        });
        return {
          identifiers,
          criteria,
          mode,
          caseInsensitive,
          ...result,
          startedAt,
          finishedAt: new Date().toISOString()
        };
      } finally {
        currentRun = null;
      }
    },

    'search:abort': async () => {
      if (!currentRun) return { aborted: false, reason: 'no active run' };
      currentRun.ac.abort();
      return { aborted: true };
    }
  };
}
