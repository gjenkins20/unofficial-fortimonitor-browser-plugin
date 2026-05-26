// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Background handlers for the Tenant Observations tool (FMN-133).
//
// Drives FMN-131's ObservationsFetcher to crawl ~25 v2 endpoints, then runs
// FMN-132's analyzers in-process. Returns the combined { inventory,
// analysis } so the wizard's review step can render the 11-tab viewer
// without a second round-trip.
//
// Auth: v2 API key via createProductionPanoptaClient (same as SD-WAN).
// Read-only.
//
// Cancellation: single-flight; observations:abort aborts the active run.
//
// Run lifecycle (FMN-256): the crawl runs DETACHED from the message
// channel. observations:run-audit kicks off the run and returns
// immediately with { runKey, status: 'started' }; it does NOT hold the
// sendMessage channel open for the (multi-minute) crawl. Holding it open
// is what killed real runs on large tenants: MV3 terminates the service
// worker while the handler is still awaiting, and the page sees "the
// message channel closed before a response was received". The page polls
// observations:get-run-status for terminal state and pulls the full
// payload via observations:get-run-result once status === 'done'.
//
// Keep-alive: while a run is active we ping a cheap extension API on an
// interval to reset the MV3 idle timer across the crawl's paced sleeps,
// retry backoffs, and analyzer CPU work (the page's own polling helps too,
// but a backgrounded tab can be throttled past the idle threshold).
//
// Result delivery: the inventory + analysis payload is multi-megabyte on
// real tenants (1000+ outages, hundreds of servers, deep-dive multipliers).
// The run writes it to chrome.storage.session under OBSERVATIONS_RUN_KEY
// inside a { status, result } envelope. get-run-status strips the result
// (never ships MB over the poll channel); get-run-result returns it once
// over a fresh short-lived channel and clears the slot so a stale run can
// never bleed into a fresh one.

import { PanoptaError } from '../lib/panopta-client.js';
import { ObservationsFetcher, createObservationsFetch } from '../lib/observations-fetcher.js';
import { PanoptaClient } from '../lib/panopta-client.js';
import { runAllAnalyzers } from '../lib/observation-analyzers/index.js';
import { ObservationsFrontendFetcher, fetchCustomerIdentity, fetchAccountHistory } from '../lib/observations-frontend-fetcher.js';
import { sanitize as sanitizeSections } from '../ui/tenant-observations/section-selection.js';
import { needsFrontendUsers, needsFrontendTemplates } from '../lib/observations-section-deps.js';

export const OBSERVATIONS_RUN_KEY = 'observations.lastRun';

/**
 * Build a paced + retrying PanoptaClient for the Observations crawl. Pulled out
 * so tests can swap the fetch.
 */
async function defaultClientFactory({ fetch, storage } = {}) {
  const baseFetch = fetch ?? globalThis.fetch.bind(globalThis);
  const wrappedFetch = createObservationsFetch(baseFetch);
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
 *   FMN-135: when true, after ObservationsFetcher finishes, walk the FortiMonitor
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
export async function runTenantObservations({
  client,
  deep = false,
  maxServers = 0,
  includeFrontend = false,
  sections,
  frontendFetch,
  frontendOrigin,
  signal,
  onProgress
} = {}) {
  if (!client) throw new TypeError('runTenantObservations: client is required');
  // FMN-149: scope the run to the requested sections. ["all"] preserves
  // today's full-report behavior; analyzer-scoped subsets skip the
  // top-level lists / trending / detail / deep-dive blocks no requested
  // analyzer consumes (per docs/planning/tenant-observations-per-section-delivery.md §2).
  const stagedSections = sanitizeSections(sections);
  const startedAt = new Date().toISOString();

  onProgress?.({ phase: 'collect:start', deep, maxServers });
  const fetcher = new ObservationsFetcher({
    client,
    signal,
    onProgress: (evt) => onProgress?.({ phase: 'collect:event', ...evt })
  });
  const inventory = await fetcher.collectInventory({
    deep,
    maxServers,
    sections: stagedSections
  });

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

  // FMN-221: fetch tenant identity unconditionally. Snapshots take the
  // observations result through condenseForSnapshot, which expects
  // result.customer. Without this, snapshot.customer is null and the
  // export filename falls back to "unknown".
  const customer = await fetchCustomerIdentity({
    fetch: frontendFetch ?? globalThis.fetch.bind(globalThis),
    origin: resolvedOrigin,
    signal,
  });

  // FMN-223: fetch a slice of Account History so the diff viewer can
  // attribute each modified entity to a user/token. Cheap, single
  // request page; we cap at 200 rows. Best-effort: failures yield an
  // empty array and downstream renders "?" for changed_by.
  let accountHistory = [];
  try {
    accountHistory = await fetchAccountHistory({
      fetch: frontendFetch ?? globalThis.fetch.bind(globalThis),
      origin: resolvedOrigin,
      signal,
    });
  } catch {
    accountHistory = [];
  }

  // FMN-149: gate each frontend walk on whether its consuming section
  // was requested. In "all" mode both walks run (today's behavior). In
  // analyzer-scoped mode, User Activity drives the user walk and
  // Templates drives the template walk; either or neither may be needed.
  const wantFrontendUsers = needsFrontendUsers(stagedSections);
  const wantFrontendTemplates = needsFrontendTemplates(stagedSections);

  if (includeFrontend && (wantFrontendUsers || wantFrontendTemplates)) {
    const baseFetch = frontendFetch ?? globalThis.fetch.bind(globalThis);
    const wrappedFetch = createObservationsFetch(baseFetch);
    const frontendFetcher = new ObservationsFrontendFetcher({
      fetch: wrappedFetch,
      origin: resolvedOrigin,
      signal,
      onProgress: (evt) => onProgress?.({ phase: 'frontend:event', ...evt })
    });

    // ---- Phase 3a: per-user activity (last_login + created_on) -----------
    let userPhaseFatal = false;
    if (wantFrontendUsers) {
      onProgress?.({ phase: 'frontend:start', total: Array.isArray(inventory.users) ? inventory.users.length : 0 });
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
    }

    // ---- Phase 3b: per-template monitoring config (metrics + thresholds) -
    if (wantFrontendTemplates && !userPhaseFatal) {
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
  const analysis = runAllAnalyzers(inventory, { sections: stagedSections });
  onProgress?.({ phase: 'analyze:done' });

  const finishedAt = new Date().toISOString();
  return {
    started_at: startedAt,
    finished_at: finishedAt,
    deep,
    max_servers: maxServers,
    include_frontend: includeFrontend,
    sections: stagedSections,
    // FMN-147: viewer uses this to build links to the FortiMonitor
    // template-edit pages. Null when no resolver is wired.
    tenant_origin: resolvedOrigin ?? null,
    customer,
    account_history: accountHistory,
    inventory,
    analysis
  };
}

// ---- Message handlers ------------------------------------------------------

/**
 * Build a small "did the run finish?" handle that fits comfortably in a
 * chrome.runtime.sendMessage payload. The popup uses this to decide
 * whether to read the full result back via observations:get-run-result.
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

// FMN-256: ping interval. Comfortably under the MV3 ~30s idle threshold.
export const KEEPALIVE_INTERVAL_MS = 20000;

/**
 * Default keep-alive: ping a cheap extension API on an interval. Each
 * extension API call resets the MV3 service-worker idle timer, so the
 * worker survives the crawl's paced sleeps, retry backoffs, and analyzer
 * CPU work even if the page polling that would otherwise keep it warm is
 * throttled (backgrounded tab). Returns a stop function. No-op when chrome
 * APIs are unavailable (Node tests inject their own, or get this no-op).
 */
function defaultKeepAlive() {
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.getPlatformInfo !== 'function') {
    return () => {};
  }
  const timer = setInterval(() => {
    try {
      // Callback form swallows the result; touch lastError so Chrome
      // doesn't log an unchecked-error warning.
      chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; });
    } catch { /* ignore */ }
  }, KEEPALIVE_INTERVAL_MS);
  return () => clearInterval(timer);
}

export function createTenantObservationsHandlers({
  events = {},
  getClient,
  resolveOrigin,
  storage,
  keepAlive
} = {}) {
  const emit = events.emit ?? (() => {});
  const factory = getClient ?? (() => defaultClientFactory());
  // Default to chrome.storage.session (MV3, in-memory, cleared on browser
  // restart - the right scope for a one-shot run handoff). Tests inject
  // a Map-backed mock.
  const sessionStorage = storage ?? (typeof chrome !== 'undefined' ? chrome.storage?.session : null);
  const startKeepAlive = keepAlive ?? defaultKeepAlive;

  // Set for the lifetime of a detached run. Its presence is also how a
  // poll distinguishes a live run from an orphaned 'running' record left
  // behind by a worker that died mid-crawl (see get-run-status).
  let currentRun = null;

  async function writeState(state) {
    if (sessionStorage?.set) {
      await sessionStorage.set({ [OBSERVATIONS_RUN_KEY]: state });
    }
  }

  return {
    'observations:run-audit': async (payload) => {
      if (currentRun) throw new Error('A tenant observations run is already in progress');
      if (!sessionStorage?.set) {
        throw new Error('chrome.storage.session is unavailable; cannot stage Observations run result');
      }
      const ac = new AbortController();
      const startedAt = new Date().toISOString();
      currentRun = { ac, startedAt };
      // Seed a 'running' record synchronously so a poll arriving before
      // the crawl's first state write still sees the right status.
      await writeState({ status: 'running', started_at: startedAt });

      const stopKeepAlive = startKeepAlive();

      // Detach: run the crawl WITHOUT holding this message channel open.
      // The page polls observations:get-run-status and pulls the full
      // result via observations:get-run-result when status === 'done'.
      // Progress events still stream to the page over the broadcast.
      const run = (async () => {
        try {
          const client = await factory();
          const result = await runTenantObservations({
            client,
            deep: Boolean(payload?.deep),
            maxServers: Number.isFinite(payload?.maxServers) ? payload.maxServers : 0,
            includeFrontend: Boolean(payload?.includeFrontend),
            sections: payload?.sections,
            frontendOrigin: resolveOrigin,
            signal: ac.signal,
            onProgress: (evt) => emit('observations:progress', evt)
          });
          await writeState({
            status: 'done',
            started_at: startedAt,
            finished_at: result.finished_at,
            summary: summarizeResult(result),
            result
          });
          emit('observations:run-status', { status: 'done' });
        } catch (err) {
          const aborted = err?.name === 'AbortError';
          const message = aborted
            ? 'tenant observations cancelled'
            : (err?.message ?? String(err));
          await writeState({
            status: aborted ? 'cancelled' : 'error',
            started_at: startedAt,
            error: message,
            name: err?.name ?? 'Error'
          });
          emit('observations:run-status', { status: aborted ? 'cancelled' : 'error', error: message });
        } finally {
          try { stopKeepAlive?.(); } catch { /* best-effort */ }
          currentRun = null;
        }
      })();
      // Expose the run promise for tests; production fire-and-forgets it.
      if (currentRun) currentRun.promise = run;

      return { runKey: OBSERVATIONS_RUN_KEY, status: 'started', started_at: startedAt };
    },

    // Lightweight poll target. Returns the run-state envelope MINUS the
    // multi-MB result (which only get-run-result ships). Never clears.
    'observations:get-run-status': async () => {
      if (!sessionStorage?.get) throw new Error('chrome.storage.session is unavailable');
      const stored = await sessionStorage.get(OBSERVATIONS_RUN_KEY);
      const state = stored?.[OBSERVATIONS_RUN_KEY] ?? null;
      if (!state) return { status: 'none' };
      // Orphan detection: 'running' on disk but no in-memory run means the
      // worker was terminated mid-crawl and the detached run died with it.
      // Report 'lost' so the page stops polling and offers a retry instead
      // of spinning forever.
      if (state.status === 'running' && !currentRun) {
        return { status: 'lost', started_at: state.started_at };
      }
      const { result, ...rest } = state;
      return rest;
    },

    'observations:get-run-result': async (payload) => {
      const key = payload?.runKey ?? OBSERVATIONS_RUN_KEY;
      if (!sessionStorage?.get) {
        throw new Error('chrome.storage.session is unavailable');
      }
      const stored = await sessionStorage.get(key);
      const state = stored?.[key] ?? null;
      if (!state) {
        throw new Error('No staged Observations run result. The previous run may have been evicted.');
      }
      if (state.status && state.status !== 'done') {
        throw new Error(`Observations run is "${state.status}", not done`);
      }
      const result = state.result ?? state; // tolerate any legacy bare-result shape
      // One-shot: clear the slot so a stale run can't be misread as fresh.
      if (sessionStorage.remove) {
        try { await sessionStorage.remove(key); } catch { /* best-effort */ }
      }
      return result;
    },

    'observations:abort': async () => {
      if (!currentRun) return { aborted: false, reason: 'no active run' };
      currentRun.ac.abort();
      return { aborted: true };
    }
  };
}
