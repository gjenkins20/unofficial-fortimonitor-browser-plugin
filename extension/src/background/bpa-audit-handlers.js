// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Background handlers for the BPA Audit tool (FMN-133).
//
// Drives FMN-131's BpaFetcher to crawl ~25 v2 endpoints, then runs
// FMN-132's analyzers in-process. Returns the combined { inventory,
// analysis } so the wizard's review step can render the 11-tab viewer
// without a second round-trip.
//
// Auth: v2 API key via createProductionPanoptaClient (same as SD-WAN).
// Read-only.
//
// Cancellation: single-flight; bpa:abort aborts the active run.
//
// Result delivery: the inventory + analysis payload is multi-megabyte on
// real tenants (1000+ outages, hundreds of servers, deep-dive multipliers).
// chrome.runtime.sendMessage round-trips of that size are unreliable - in
// FMN-133 first-tenant QA the popup never received the response after a
// 5-minute run. We sidestep the transport entirely by writing the result
// to chrome.storage.session under BPA_RUN_KEY and returning a small handle;
// the popup reads it back via bpa:get-run-result, which clears the slot
// after consumption so a stale run can never bleed into a fresh one.

import { PanoptaError } from '../lib/panopta-client.js';
import { BpaFetcher, createBpaFetch } from '../lib/bpa-fetcher.js';
import { PanoptaClient } from '../lib/panopta-client.js';
import { runAllAnalyzers } from '../lib/bpa-analyzers/index.js';
import { BpaFrontendFetcher } from '../lib/bpa-frontend-fetcher.js';

export const BPA_RUN_KEY = 'bpa.lastRun';

/**
 * Build a paced + retrying PanoptaClient for the BPA crawl. Pulled out
 * so tests can swap the fetch.
 */
async function defaultClientFactory({ fetch, storage } = {}) {
  const baseFetch = fetch ?? globalThis.fetch.bind(globalThis);
  const wrappedFetch = createBpaFetch(baseFetch);
  const apiKeyStorage = storage ?? chrome.storage.local;
  const stored = await apiKeyStorage.get('panopta.apiKey');
  const apiKey = stored?.['panopta.apiKey'];
  if (!apiKey) {
    throw new PanoptaError(
      'No API key configured. Open the extension settings and paste a FortiMonitor RW API key.',
      { phase: 'auth' }
    );
  }
  return new PanoptaClient({ apiKey, fetch: wrappedFetch });
}

/**
 * Top-level audit runner. Returns the wire shape the UI consumes.
 *
 * @param {object} options
 * @param {PanoptaClient} options.client
 * @param {boolean} [options.deep]
 * @param {number} [options.maxServers]
 * @param {boolean} [options.includeFrontend]
 *   FMN-135: when true, after BpaFetcher finishes, walk the FortiMonitor
 *   UI's EditUser page per user (session-auth, requires the operator to
 *   be logged in) to collect last_login and created_on. Errors are
 *   recorded under inventory.errors and do not abort the run, except
 *   that "not logged in" on the very first user is fatal so the operator
 *   isn't told 50 times in a row to log in.
 * @param {typeof fetch} [options.frontendFetch]
 *   Test seam for the session-auth fetch. Production callers omit;
 *   globalThis.fetch is used and the SW's host_permissions +
 *   credentials:'include' attach the session cookie.
 * @param {AbortSignal} [options.signal]
 * @param {(evt:object) => void} [options.onProgress]
 */
export async function runBpaAudit({
  client,
  deep = false,
  maxServers = 0,
  includeFrontend = false,
  frontendFetch,
  frontendOrigin,
  signal,
  onProgress
} = {}) {
  if (!client) throw new TypeError('runBpaAudit: client is required');
  const startedAt = new Date().toISOString();

  onProgress?.({ phase: 'collect:start', deep, maxServers });
  const fetcher = new BpaFetcher({
    client,
    signal,
    onProgress: (evt) => onProgress?.({ phase: 'collect:event', ...evt })
  });
  const inventory = await fetcher.collectInventory({ deep, maxServers });

  if (signal?.aborted) {
    const err = new Error('aborted'); err.name = 'AbortError'; throw err;
  }

  // FMN-144: resolve the tenant origin once, up front, so it's available
  // both to the frontend fetcher (FMN-144) and to the result blob for
  // viewer-side link construction (FMN-147). frontendOrigin is a string
  // OR an async thunk returning one; both forms supported.
  let resolvedOrigin;
  if (typeof frontendOrigin === 'function') {
    try { resolvedOrigin = await frontendOrigin(); } catch { resolvedOrigin = undefined; }
  } else if (typeof frontendOrigin === 'string' && frontendOrigin.length > 0) {
    resolvedOrigin = frontendOrigin;
  }

  if (includeFrontend) {
    const baseFetch = frontendFetch ?? globalThis.fetch.bind(globalThis);
    const wrappedFetch = createBpaFetch(baseFetch);
    const frontendFetcher = new BpaFrontendFetcher({
      fetch: wrappedFetch,
      origin: resolvedOrigin,
      signal,
      onProgress: (evt) => onProgress?.({ phase: 'frontend:event', ...evt })
    });

    // ---- Phase 3a: per-user activity (last_login + created_on) -----------
    onProgress?.({ phase: 'frontend:start', total: Array.isArray(inventory.users) ? inventory.users.length : 0 });
    let userPhaseFatal = false;
    try {
      const result = await frontendFetcher.collect(inventory.users);
      inventory.frontend_user_data = result.users;
      if (Array.isArray(inventory.errors) && result.errors.length > 0) {
        for (const e of result.errors) inventory.errors.push(`frontend: ${e}`);
      }
      onProgress?.({ phase: 'frontend:done', stats: result.stats });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // Fatal-on-first-failure (auth) bubbles up here. Record on
      // inventory.errors so the analyzer can run on the v2-only data,
      // but emit a phase event so the UI shows what happened.
      const reason = err?.message ?? String(err);
      if (Array.isArray(inventory.errors)) inventory.errors.push(`frontend: ${reason}`);
      onProgress?.({ phase: 'frontend:error', error: reason });
      // If user phase failed on auth, the template phase will fail the
      // same way - skip it to avoid spamming inventory.errors.
      if (/session|auth/i.test(reason)) userPhaseFatal = true;
    }

    // ---- Phase 3b: per-template monitoring config (metrics + thresholds) -
    if (!userPhaseFatal) {
      const templates = Array.isArray(inventory.server_templates) ? inventory.server_templates : [];
      onProgress?.({ phase: 'frontend-templates:start', total: templates.length });
      try {
        const result = await frontendFetcher.collectTemplateConfigs(templates);
        inventory.template_monitoring_configs = result.configs;
        if (Array.isArray(inventory.errors) && result.errors.length > 0) {
          for (const e of result.errors) inventory.errors.push(`frontend: ${e}`);
        }
        onProgress?.({ phase: 'frontend-templates:done', stats: result.stats });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        const reason = err?.message ?? String(err);
        if (Array.isArray(inventory.errors)) inventory.errors.push(`frontend: ${reason}`);
        onProgress?.({ phase: 'frontend-templates:error', error: reason });
      }
    }
  }

  onProgress?.({ phase: 'analyze:start' });
  const analysis = runAllAnalyzers(inventory);
  onProgress?.({ phase: 'analyze:done' });

  const finishedAt = new Date().toISOString();
  return {
    started_at: startedAt,
    finished_at: finishedAt,
    deep,
    max_servers: maxServers,
    include_frontend: includeFrontend,
    // FMN-147: viewer uses this to build links to the FortiMonitor
    // template-edit pages. Null when no resolver is wired.
    tenant_origin: resolvedOrigin ?? null,
    inventory,
    analysis
  };
}

// ---- Message handlers ------------------------------------------------------

/**
 * Build a small "did the run finish?" handle that fits comfortably in a
 * chrome.runtime.sendMessage payload. The popup uses this to decide
 * whether to read the full result back via bpa:get-run-result.
 */
function summarizeResult(result) {
  const inv = result?.inventory ?? {};
  const arr = (k) => Array.isArray(inv[k]) ? inv[k].length : 0;
  return {
    started_at: result?.started_at,
    finished_at: result?.finished_at,
    deep: result?.deep,
    error_count: Array.isArray(inv.errors) ? inv.errors.length : 0,
    counts: {
      servers: arr('servers'),
      outages: arr('outages'),
      outages_recent: arr('outages_recent'),
      users: arr('users'),
      contacts: arr('contacts'),
      server_groups: arr('server_groups'),
      server_templates: arr('server_templates')
    }
  };
}

export function createBpaAuditHandlers({
  events = {},
  getClient,
  resolveOrigin,
  storage
} = {}) {
  const emit = events.emit ?? (() => {});
  const factory = getClient ?? (() => defaultClientFactory());
  // Default to chrome.storage.session (MV3, in-memory, cleared on browser
  // restart - the right scope for a one-shot run handoff). Tests inject
  // a Map-backed mock.
  const sessionStorage = storage ?? (typeof chrome !== 'undefined' ? chrome.storage?.session : null);

  let currentRun = null;

  return {
    'bpa:run-audit': async (payload) => {
      if (currentRun) throw new Error('A BPA audit run is already in progress');
      const ac = new AbortController();
      currentRun = { ac };
      try {
        const client = await factory();
        const result = await runBpaAudit({
          client,
          deep: Boolean(payload?.deep),
          maxServers: Number.isFinite(payload?.maxServers) ? payload.maxServers : 0,
          includeFrontend: Boolean(payload?.includeFrontend),
          frontendOrigin: resolveOrigin,
          signal: ac.signal,
          onProgress: (evt) => emit('bpa:progress', evt)
        });
        if (!sessionStorage?.set) {
          throw new Error('chrome.storage.session is unavailable; cannot stage BPA run result');
        }
        await sessionStorage.set({ [BPA_RUN_KEY]: result });
        return { runKey: BPA_RUN_KEY, summary: summarizeResult(result) };
      } catch (err) {
        if (err?.name === 'AbortError') {
          const e = new Error('BPA audit cancelled');
          e.name = 'AbortError';
          throw e;
        }
        if (err instanceof PanoptaError || err?.name === 'PanoptaError') throw err;
        throw err;
      } finally {
        currentRun = null;
      }
    },

    'bpa:get-run-result': async (payload) => {
      const key = payload?.runKey ?? BPA_RUN_KEY;
      if (!sessionStorage?.get) {
        throw new Error('chrome.storage.session is unavailable');
      }
      const stored = await sessionStorage.get(key);
      const result = stored?.[key] ?? null;
      if (!result) {
        throw new Error('No staged BPA run result. The previous run may have been evicted.');
      }
      // One-shot: clear the slot so a stale run can't be misread as fresh.
      if (sessionStorage.remove) {
        try { await sessionStorage.remove(key); } catch { /* best-effort */ }
      }
      return result;
    },

    'bpa:abort': async () => {
      if (!currentRun) return { aborted: false, reason: 'no active run' };
      currentRun.ac.abort();
      return { aborted: true };
    }
  };
}
