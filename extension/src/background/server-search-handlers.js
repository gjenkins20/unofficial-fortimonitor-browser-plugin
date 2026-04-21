// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Background handlers for the Search Servers tool (FMN-65).
//
// Filters a tenant's /server records by a specific attribute. Callers pick
// an attribute type by name (e.g., "Model") from the tenant's
// /server_attribute_type list, then enter a value to match
// (e.g., "FGT60F"). This is deliberately narrower than a cross-field
// free-text search - it is the shape the operator actually wants for
// questions like "which devices have Model=FGT60F".
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

/**
 * Decide whether a single /server record has an attribute that matches the
 * operator's filter. Only considers the `attributes[]` array - not tags,
 * not name, not fqdn. Filtering is keyed by `name` OR `textkey` (either
 * can be supplied as `attributeName`) so the operator can use whichever
 * appears in their tenant.
 *
 * @param {object} server                    - raw /server record
 * @param {object} opts
 * @param {string} opts.attributeName        - attribute display name OR textkey
 * @param {string} opts.value                - value to match
 * @param {boolean} [opts.exactMatch=true]   - true: attr.value === value; false: contains
 * @param {boolean} [opts.caseInsensitive=true]
 * @returns {{ matched: boolean, attributeName?: string, textkey?: string, value?: string }}
 */
export function matchesAttribute(server, {
  attributeName,
  value,
  exactMatch = true,
  caseInsensitive = true
} = {}) {
  if (!server || !attributeName || value == null) return { matched: false };
  if (!Array.isArray(server.attributes)) return { matched: false };

  const nameNeedle = caseInsensitive ? String(attributeName).toLowerCase() : String(attributeName);
  const valueNeedle = caseInsensitive ? String(value).toLowerCase() : String(value);

  const nameEq = (s) => {
    if (s == null) return false;
    const t = caseInsensitive ? String(s).toLowerCase() : String(s);
    return t === nameNeedle;
  };
  const valueMatches = (s) => {
    if (s == null) return false;
    const t = caseInsensitive ? String(s).toLowerCase() : String(s);
    return exactMatch ? t === valueNeedle : t.includes(valueNeedle);
  };

  for (const attr of server.attributes) {
    if (!nameEq(attr?.name) && !nameEq(attr?.textkey)) continue;
    if (!valueMatches(attr?.value)) continue;
    return {
      matched: true,
      attributeName: attr.name ?? null,
      textkey: attr.textkey ?? null,
      value: attr.value ?? null
    };
  }
  return { matched: false };
}

/**
 * Shape a matched raw /server record into the compact result row the UI
 * and CSV consume.
 */
export function shapeMatch(server, matchInfo) {
  return {
    id: extractServerId(server),
    name: server.name ?? null,
    fqdn: server.fqdn ?? null,
    additionalFqdns: Array.isArray(server.additional_fqdns) ? server.additional_fqdns.slice() : [],
    deviceType: server.device_type ?? null,
    deviceSubType: server.device_sub_type ?? null,
    matchedAttributeName: matchInfo.attributeName ?? null,
    matchedAttributeTextkey: matchInfo.textkey ?? null,
    matchedValue: matchInfo.value ?? null
  };
}

/**
 * Page through /server and return every record whose attributes contain a
 * match for the operator's filter. Emits `onPage` after every page so the
 * UI can show live progress.
 *
 * @param {object} args
 * @param {object} args.client                   - PanoptaClient (listServers)
 * @param {string} args.attributeName
 * @param {string} args.value
 * @param {boolean} [args.exactMatch=true]
 * @param {boolean} [args.caseInsensitive=true]
 * @param {number}  [args.pageSize=100]
 * @param {number}  [args.maxPages=1000]
 * @param {AbortSignal} [args.signal]
 * @param {(evt:{fetched:number,total:number,matches:number}) => void} [args.onPage]
 */
export async function searchServersByAttribute({
  client,
  attributeName,
  value,
  exactMatch = true,
  caseInsensitive = true,
  pageSize = 100,
  maxPages = 1000,
  signal,
  onPage
} = {}) {
  if (!client) throw new TypeError('searchServersByAttribute: client is required');
  if (!attributeName) throw new TypeError('searchServersByAttribute: attributeName is required');
  if (value == null || value === '') throw new TypeError('searchServersByAttribute: value is required');

  const matches = [];
  let offset = 0;
  let totalAvailable = Infinity;
  let fetched = 0;

  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    const body = await client.listServers({ limit: pageSize, offset });
    const list = Array.isArray(body?.server_list) ? body.server_list : [];
    if (typeof body?.meta?.total_count === 'number') {
      totalAvailable = body.meta.total_count;
    }

    for (const server of list) {
      const info = matchesAttribute(server, { attributeName, value, exactMatch, caseInsensitive });
      if (info.matched) matches.push(shapeMatch(server, info));
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
    totalAvailable: Number.isFinite(totalAvailable) ? totalAvailable : fetched
  };
}

/**
 * Message-handler factory. Service worker merges this into the main
 * router alongside the other v2 API tool handlers.
 */
export function createServerSearchHandlers({ events = {}, getClient } = {}) {
  const emit = events.emit ?? (() => {});
  const factory = getClient ?? (() => createProductionPanoptaClient());

  let currentRun = null;

  return {
    'search:list-attribute-types': async (payload) => {
      // The /server_attribute_type catalog only returns *customer-defined*
      // attribute types. System/built-in types like "Model" (textkey
      // dem.model) and "Operating System" (textkey server.os) live on
      // server records but never appear in that catalog. To surface them
      // as suggestions, we also sample the first page of /server and
      // extract the distinct attribute names/textkeys seen there.
      const client = await factory();
      const sampleSize = Number.isFinite(payload?.sampleSize) ? payload.sampleSize : 100;

      const [catalog, sample] = await Promise.all([
        client.listAttributeTypes().catch(() => []),
        client.listServers({ limit: sampleSize, offset: 0 }).catch(() => ({ server_list: [] }))
      ]);

      const merged = new Map(); // key: lowercased name → { name, textkey, sources:Set }
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

    'search:servers': async (payload) => {
      if (currentRun) throw new Error('A server-search run is already in progress');
      const ac = new AbortController();
      const startedAt = new Date().toISOString();
      currentRun = { ac, startedAt };
      try {
        const attributeName = String(payload?.attributeName ?? '').trim();
        const value = String(payload?.value ?? '').trim();
        if (!attributeName) throw new Error('attributeName is required');
        if (!value) throw new Error('value is required');
        const exactMatch = payload?.exactMatch !== false;            // default true
        const caseInsensitive = payload?.caseInsensitive !== false;  // default true
        const pageSize = Number.isFinite(payload?.pageSize) ? payload.pageSize : 100;

        const client = await factory();
        const { matches, totalScanned, totalAvailable } = await searchServersByAttribute({
          client,
          attributeName,
          value,
          exactMatch,
          caseInsensitive,
          pageSize,
          signal: ac.signal,
          onPage: (evt) => emit('search:page', evt)
        });
        return {
          attributeName,
          value,
          exactMatch,
          caseInsensitive,
          matches,
          totalScanned,
          totalAvailable,
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
