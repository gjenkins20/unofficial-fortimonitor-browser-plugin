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
// real tenants - a 3047-server tenant blew past chrome.storage.session's
// hard 10MB cap entirely ("Session storage quota bytes exceeded"; FMN-256
// live QA). So the payload goes to chrome.storage.LOCAL (which the
// unlimitedStorage permission frees from the 10MB cap) under
// OBSERVATIONS_RESULT_KEY, and the small status envelope lives alongside
// under OBSERVATIONS_RUN_KEY. The page polls observations:get-run-status
// (small) and, on 'done', reads the result KEY directly from
// chrome.storage.local - it is never shipped over sendMessage, which is
// unreliable at this size. get-run-result is retained as an SW-side
// accessor (tests, fallbacks) and clears both keys.

import { PanoptaError } from '../lib/panopta-client.js';
import { ObservationsFetcher, createObservationsFetch } from '../lib/observations-fetcher.js';
import { PanoptaClient } from '../lib/panopta-client.js';
import { runAllAnalyzers } from '../lib/observation-analyzers/index.js';
import { ObservationsFrontendFetcher, fetchCustomerIdentity, fetchAccountHistory } from '../lib/observations-frontend-fetcher.js';
import { sanitize as sanitizeSections } from '../ui/tenant-observations/section-selection.js';
import { needsFrontendUsers, needsFrontendTemplates } from '../lib/observations-section-deps.js';
import { progressPhaseToStepperPhase } from '../ui/tenant-observations/collect-phases.js';
// FMN-299: session-only template extraction (no v2 API key).
import { collectTemplateSlice } from '../lib/session-template-collector.js';
import { analyzeTemplates } from '../lib/observation-analyzers/template.js';

// Small run-status envelope: { status, started_at, finished_at, summary,
// error, name }. Polled frequently; always tiny.
export const OBSERVATIONS_RUN_KEY = 'observations.lastRun';
// The multi-megabyte { inventory, analysis, ... } payload. Stored under a
// SEPARATE key so a status poll never has to load it, and read by the page
// directly out of chrome.storage (NOT shipped over sendMessage - that path
// is unreliable at this size; see [[mv3_sendmessage_multimb_stall]]).
export const OBSERVATIONS_RESULT_KEY = 'observations.lastResult';

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
// FMN-261: exported so observations-snapshot-handlers.js reuses the exact
// same worker-survival mechanism. The snapshot :take runs the same
// multi-minute crawl and was evicted mid-run without it.
export function defaultKeepAlive() {
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
  // chrome.storage.LOCAL (not session): the result blob exceeds session's
  // hard 10MB cap on large tenants, and the unlimitedStorage permission
  // frees local from the 10MB limit. Holds both the small status envelope
  // (OBSERVATIONS_RUN_KEY) and the big result (OBSERVATIONS_RESULT_KEY).
  // Tests inject a Map-backed mock.
  const store = storage ?? (typeof chrome !== 'undefined' ? chrome.storage?.local : null);
  const startKeepAlive = keepAlive ?? defaultKeepAlive;

  // Set for the lifetime of a detached run. Its presence is also how a
  // poll distinguishes a live run from an orphaned 'running' record left
  // behind by a worker that died mid-crawl (see get-run-status).
  let currentRun = null;

  async function writeStatus(state) {
    if (store?.set) await store.set({ [OBSERVATIONS_RUN_KEY]: state });
  }

  return {
    'observations:run-audit': async (payload) => {
      if (currentRun) throw new Error('A tenant observations run is already in progress');
      if (!store?.set) {
        throw new Error('chrome.storage is unavailable; cannot stage Observations run result');
      }
      const ac = new AbortController();
      const startedAt = new Date().toISOString();
      // FMN-257: track the latest stepper phase the run has entered so the
      // status poll can carry it. The page's persistent phase stepper reads
      // this when broadcast progress events don't arrive (MV3 may drop them
      // for a backgrounded SW), keeping the indicator truthful.
      currentRun = { ac, startedAt, phase: null };
      // Clear any stale result from a prior run, then seed a 'running'
      // record synchronously so a poll arriving before the crawl's first
      // state write still sees the right status.
      if (store.remove) { try { await store.remove(OBSERVATIONS_RESULT_KEY); } catch { /* best-effort */ } }
      await writeStatus({ status: 'running', started_at: startedAt, phase: null });

      const stopKeepAlive = startKeepAlive();

      // FMN-257: broadcast every progress event (live UI), AND persist the
      // current stepper phase into the run-status record whenever the run
      // crosses a phase boundary. Per-endpoint detail events do not cross a
      // boundary, so this writes at most ~5 times per run, not per event.
      const onProgress = (evt) => {
        emit('observations:progress', evt);
        if (!currentRun) return;
        const stepperPhase = progressPhaseToStepperPhase(evt?.phase, evt);
        if (stepperPhase && stepperPhase !== currentRun.phase) {
          currentRun.phase = stepperPhase;
          // Best-effort: the broadcast already happened; a failed phase
          // write must not break the run. The running status carries the
          // latest phase for poll-driven recovery.
          writeStatus({ status: 'running', started_at: startedAt, phase: stepperPhase })
            .catch(() => { /* best-effort phase persistence */ });
        }
      };

      // Detach: run the crawl WITHOUT holding this message channel open.
      // The page polls observations:get-run-status and reads the result KEY
      // directly from chrome.storage on 'done'. Progress events still
      // stream to the page over the broadcast.
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
            onProgress
          });
          // Stage the big payload FIRST, then flip status to 'done'. If the
          // result write fails (e.g. quota), the catch records 'error' and
          // the page never sees a 'done' with no readable result.
          await store.set({ [OBSERVATIONS_RESULT_KEY]: result });
          await writeStatus({
            status: 'done',
            started_at: startedAt,
            finished_at: result.finished_at,
            phase: currentRun?.phase ?? null,
            summary: summarizeResult(result)
          });
          emit('observations:run-status', { status: 'done' });
        } catch (err) {
          const aborted = err?.name === 'AbortError';
          const message = aborted
            ? 'tenant observations cancelled'
            : (err?.message ?? String(err));
          // Drop any partial result so a failed run can't be half-read.
          if (store.remove) { try { await store.remove(OBSERVATIONS_RESULT_KEY); } catch { /* best-effort */ } }
          await writeStatus({
            status: aborted ? 'cancelled' : 'error',
            started_at: startedAt,
            phase: currentRun?.phase ?? null,
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

      return {
        runKey: OBSERVATIONS_RUN_KEY,
        resultKey: OBSERVATIONS_RESULT_KEY,
        status: 'started',
        started_at: startedAt
      };
    },

    // Lightweight poll target. Reads only the small status key; never the
    // result. Never clears.
    'observations:get-run-status': async () => {
      if (!store?.get) throw new Error('chrome.storage is unavailable');
      const stored = await store.get(OBSERVATIONS_RUN_KEY);
      const state = stored?.[OBSERVATIONS_RUN_KEY] ?? null;
      if (!state) return { status: 'none' };
      // Orphan detection: 'running' on disk but no in-memory run means the
      // worker was terminated mid-crawl and the detached run died with it.
      // Report 'lost' so the page stops polling and offers a retry instead
      // of spinning forever.
      if (state.status === 'running' && !currentRun) {
        // FMN-257: forward the last persisted phase so the stepper can mark
        // the phase the worker died in as failed rather than resetting.
        return { status: 'lost', started_at: state.started_at, phase: state.phase ?? null };
      }
      const { result, ...rest } = state; // defensive: status key never holds result
      return rest;
    },

    // SW-side result accessor (tests / fallback). The page normally reads
    // OBSERVATIONS_RESULT_KEY directly from chrome.storage rather than
    // shipping multi-MB over sendMessage. Clears BOTH keys on read.
    'observations:get-run-result': async () => {
      if (!store?.get) {
        throw new Error('chrome.storage is unavailable');
      }
      const statusStored = await store.get(OBSERVATIONS_RUN_KEY);
      const status = statusStored?.[OBSERVATIONS_RUN_KEY]?.status;
      if (status && status !== 'done') {
        throw new Error(`Observations run is "${status}", not done`);
      }
      const stored = await store.get(OBSERVATIONS_RESULT_KEY);
      const result = stored?.[OBSERVATIONS_RESULT_KEY] ?? null;
      if (!result) {
        throw new Error('No staged Observations run result. The previous run may have been evicted.');
      }
      // One-shot: clear both keys so a stale run can't be misread as fresh.
      if (store.remove) {
        try { await store.remove([OBSERVATIONS_RESULT_KEY, OBSERVATIONS_RUN_KEY]); } catch { /* best-effort */ }
      }
      return result;
    },

    'observations:abort': async () => {
      if (!currentRun) return { aborted: false, reason: 'no active run' };
      currentRun.ac.abort();
      return { aborted: true };
    },

    // FMN-299: extract this tenant's templates using ONLY the browser session
    // (no v2 API key). The per-template config crawl is slow (minutes on a
    // large tenant), so this DETACHES exactly like observations:run-audit -
    // it reuses the same run-status / result keys, so the page polls
    // observations:get-run-status and reads OBSERVATIONS_RESULT_KEY. The
    // collector fetches configs with a bounded worker pool for speed.
    'session-templates:extract': async () => {
      if (currentRun) throw new Error('A tenant observations run is already in progress');
      if (!store?.set) throw new Error('chrome.storage is unavailable; cannot stage the extraction');
      const ac = new AbortController();
      const startedAt = new Date().toISOString();
      currentRun = { ac, startedAt, phase: 'collect' };
      if (store.remove) { try { await store.remove(OBSERVATIONS_RESULT_KEY); } catch { /* best-effort */ } }
      await writeStatus({ status: 'running', started_at: startedAt, phase: 'collect' });

      const stopKeepAlive = startKeepAlive();

      // Detach: run the crawl without holding the message channel open.
      const run = (async () => {
        try {
          let origin;
          try { origin = resolveOrigin ? await resolveOrigin() : undefined; } catch { origin = undefined; }
          const onProgress = (evt) => {
            emit('observations:progress', evt);
            if (currentRun && evt?.phase === 'session-templates:config-done') {
              writeStatus({ status: 'running', started_at: startedAt, phase: 'collect', done: evt.done, total: evt.total })
                .catch(() => { /* best-effort progress */ });
            }
          };
          const slice = await collectTemplateSlice({
            fetch: globalThis.fetch.bind(globalThis),
            origin,
            signal: ac.signal,
            onProgress
          });
          const inventory = {
            server_templates: slice.server_templates,
            server_group_details: slice.server_group_details,
            template_monitoring_configs: slice.template_monitoring_configs,
            errors: slice.errors
          };
          const finishedAt = new Date().toISOString();
          const result = {
            inventory,
            analysis: { templates: analyzeTemplates(inventory) },
            sections: ['template-recommendations'],
            tenant_origin: origin ?? null,
            template_only: true,
            customer: '',
            started_at: startedAt,
            finished_at: finishedAt
          };
          await store.set({ [OBSERVATIONS_RESULT_KEY]: result });
          await writeStatus({ status: 'done', started_at: startedAt, finished_at: finishedAt });
        } catch (err) {
          const aborted = err?.name === 'AbortError';
          await writeStatus({
            status: aborted ? 'cancelled' : 'error',
            started_at: startedAt,
            error: aborted ? 'cancelled' : (err?.message ?? String(err))
          }).catch(() => { /* best-effort */ });
        } finally {
          stopKeepAlive();
          currentRun = null;
        }
      })();
      void run;
      return { started: true, resultKey: OBSERVATIONS_RESULT_KEY };
    }
  };
}
