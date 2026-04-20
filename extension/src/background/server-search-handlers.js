// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Background handlers for the Search Servers tool (FMN-65).
//
// Free-text search across a tenant's /server records. The /server endpoint
// has no server-side filter for model, device_sub_type, tags, or attribute
// values, so we paginate the full list and filter client-side against a
// superset of likely fields (name, fqdn, additional_fqdns[], device_type,
// device_sub_type, tags[], attributes[].value). This makes the tool robust
// to model/SKU info living in any of those fields.
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

/**
 * Extract the numeric server id from a record whose only id carrier is
 * the trailing segment of its `url` field.
 */
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
 * Check whether a single /server record matches `term`. Iterates over the
 * fields most likely to carry a FortiGate model / SKU / hostname. Returns
 * the first match for display so the operator can see *why* the record
 * hit — useful when the search target isn't where you expected.
 *
 * @param {object} server — raw /server record
 * @param {object} opts
 * @param {string} opts.term
 * @param {boolean} [opts.caseInsensitive=true]
 * @returns {{ matched: boolean, field?: string, value?: string }}
 */
export function matchesServer(server, { term, caseInsensitive = true } = {}) {
  if (!server || !term) return { matched: false };
  const needle = caseInsensitive ? String(term).toLowerCase() : String(term);
  const test = (v) => {
    if (v == null) return false;
    const s = caseInsensitive ? String(v).toLowerCase() : String(v);
    return s.includes(needle);
  };

  if (test(server.name)) return { matched: true, field: 'name', value: server.name };
  if (test(server.fqdn)) return { matched: true, field: 'fqdn', value: server.fqdn };

  if (Array.isArray(server.additional_fqdns)) {
    for (const fq of server.additional_fqdns) {
      if (test(fq)) return { matched: true, field: 'additional_fqdns', value: fq };
    }
  }

  if (test(server.device_type)) {
    return { matched: true, field: 'device_type', value: server.device_type };
  }
  if (test(server.device_sub_type)) {
    return { matched: true, field: 'device_sub_type', value: server.device_sub_type };
  }

  if (Array.isArray(server.tags)) {
    for (const tag of server.tags) {
      if (test(tag)) return { matched: true, field: 'tags', value: tag };
    }
  }

  if (Array.isArray(server.attributes)) {
    for (const attr of server.attributes) {
      if (test(attr?.value)) {
        return {
          matched: true,
          field: `attributes[${attr.name ?? attr.textkey ?? '?'}]`,
          value: attr.value
        };
      }
    }
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
    matchedField: matchInfo.field ?? null,
    matchedValue: matchInfo.value ?? null
  };
}

/**
 * Page through /server and return every record that matches `term`.
 * Emits `onPage` after every page so the UI can show live progress
 * ("scanned N of M, K matches so far").
 *
 * @param {object} args
 * @param {object} args.client           — PanoptaClient (listServers)
 * @param {string} args.term
 * @param {boolean} [args.caseInsensitive=true]
 * @param {number}  [args.pageSize=100]
 * @param {number}  [args.maxPages=1000] — safety guard against runaway pagination
 * @param {AbortSignal} [args.signal]
 * @param {(evt:{fetched:number,total:number,matches:number}) => void} [args.onPage]
 * @returns {Promise<{ matches: Array, totalScanned: number, totalAvailable: number }>}
 */
export async function searchServers({
  client,
  term,
  caseInsensitive = true,
  pageSize = 100,
  maxPages = 1000,
  signal,
  onPage
} = {}) {
  if (!client) throw new TypeError('searchServers: client is required');
  if (!term || typeof term !== 'string') {
    throw new TypeError('searchServers: term is required');
  }

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
      const info = matchesServer(server, { term, caseInsensitive });
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
    'search:servers': async (payload) => {
      if (currentRun) throw new Error('A server-search run is already in progress');
      const ac = new AbortController();
      const startedAt = new Date().toISOString();
      currentRun = { ac, startedAt };
      try {
        const client = await factory();
        const term = String(payload?.term ?? '').trim();
        if (!term) throw new Error('search term is required');
        const caseInsensitive = payload?.caseInsensitive !== false; // default true
        const pageSize = Number.isFinite(payload?.pageSize) ? payload.pageSize : 100;

        const { matches, totalScanned, totalAvailable } = await searchServers({
          client,
          term,
          caseInsensitive,
          pageSize,
          signal: ac.signal,
          onPage: (evt) => emit('search:page', evt)
        });
        return {
          term,
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
