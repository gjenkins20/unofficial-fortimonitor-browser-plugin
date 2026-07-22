// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-299: session-only template slice collector.
//
// Builds the { server_templates, server_group_details, template_monitoring_configs }
// slice that analyzeTemplates() / anonymizeTemplateInventory() consume, using
// ONLY the FortiMonitor browser session - no v2 API key. This is the no-key
// substitute for Tenant Observations' v2 `/server_template` + `/server_group`
// fetches, for clients who don't have an API key.
//
// Two session-auth sources (both cookie-only, verified live FMN-299 2026-07-22):
//   - GET /util/monitoring_tree?include_templates=1  -> template list + group
//     names + membership (parsed by buildTemplateSliceFromTree).
//   - GET /report/get_monitoring_config_data?server_id={tid}  -> per-template
//     metrics/thresholds.
//
// Resilience (FMN-299 review): the per-template config crawl reuses the same
// createObservationsFetch wrapper the v2 crawl uses - timeout + retry/backoff +
// rate-limit pacing - so 4 concurrent workers don't hammer the endpoint into
// rate-limiting. Per-template errors are ISOLATED: the tree fetch up front
// already proves the session is valid, so a config that returns HTML / an HTTP
// error / a timeout is a per-template problem (deleted template, bad input,
// transient), recorded in `errors[]` and skipped - it never aborts the whole
// crawl. Only a genuine RUN cancel (the caller's AbortSignal) stops the pool.

import { buildTemplateSliceFromTree } from './monitoring-tree.js';
import { createObservationsFetch } from './observations-fetcher.js';
import {
  FORTIMONITOR_ORIGIN,
  MONITORING_CONFIG_PATH,
  parseMonitoringConfig
} from './observations-frontend-fetcher.js';

export const MONITORING_TREE_PATH = '/util/monitoring_tree?include_templates=1';

// 4 workers pull from a shared cursor (load-balanced). The paced fetch caps the
// actual request rate, so this is a ceiling, not a hammer.
export const CONFIG_CONCURRENCY = 4;

// Per-request settings for the config crawl. 20s timeout (the endpoint can
// legitimately take ~12s), a single retry, 5 req/s pacing.
export const CONFIG_TIMEOUT_MS = 20_000;
export const CONFIG_BACKOFF_MS = [2_000];
export const CONFIG_RATE_LIMIT = 5;

/**
 * @param {Object} opts
 * @param {Function} opts.fetch     fetch implementation (SW global or window.fetch;
 *                                   attaches FortiMonitor session cookies via host_permissions)
 * @param {string}   [opts.origin]  resolved tenant origin; defaults to the federation origin
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.onProgress]
 * @returns {Promise<{server_templates:Object[], server_group_details:Object, template_monitoring_configs:Object, errors:string[]}>}
 */
export async function collectTemplateSlice({ fetch: fetchImpl, origin, signal, onProgress, fetchOptions } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('collectTemplateSlice requires a fetch implementation');
  // Bind to the global: the wrappers call fetch plainly, but a raw global fetch
  // invoked via a stored reference can throw "Illegal invocation" (FMN-299).
  const boundFetch = fetchImpl.bind(globalThis);
  // fetchOptions is a test seam to control timeout/backoff/pacing timing.
  const resilientFetch = createObservationsFetch(boundFetch, {
    timeoutMs: fetchOptions?.timeoutMs ?? CONFIG_TIMEOUT_MS,
    backoffSchedule: fetchOptions?.backoffSchedule ?? CONFIG_BACKOFF_MS,
    rateLimit: fetchOptions?.rateLimit ?? CONFIG_RATE_LIMIT
  });
  const host = (typeof origin === 'string' && origin.length > 0) ? origin : FORTIMONITOR_ORIGIN;

  // ---- template list + group names (session-auth tree) ----------------------
  onProgress?.({ phase: 'session-templates:tree' });
  let res;
  try {
    res = await resilientFetch(`${host}${MONITORING_TREE_PATH}`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      signal
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(`Failed to fetch the FortiMonitor monitoring tree at ${host}: ${err?.message || err}`);
  }
  const text = await res.text();
  let tree;
  try {
    tree = JSON.parse(text);
  } catch {
    throw new Error(
      `FortiMonitor session not detected at ${host} (monitoring_tree returned a non-JSON `
      + `response - likely a login/SPA shell). Log into FortiMonitor in this browser and retry.`
    );
  }
  const { server_templates, server_group_details } = buildTemplateSliceFromTree(tree);

  // ---- per-template configs (bounded, paced, per-template error isolation) --
  const total = server_templates.length;
  onProgress?.({ phase: 'session-templates:configs', total });

  const configs = {};
  const errors = [];
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const i = cursor++;
      if (i >= total) break;
      const t = server_templates[i];
      try {
        configs[t.id] = await fetchTemplateConfig(resilientFetch, host, t.id, signal);
      } catch (e) {
        // Only a genuine RUN cancel stops the pool; every other failure
        // (timeout, HTML/bad-input, HTTP error) is a per-template error.
        if (signal?.aborted) throw e;
        errors.push(`template ${t.id}: ${e?.message ?? String(e)}`);
      }
      done += 1;
      onProgress?.({ phase: 'session-templates:config-done', done, total });
    }
  };
  const workerCount = Math.max(1, Math.min(CONFIG_CONCURRENCY, total));
  await Promise.all(Array.from({ length: workerCount }, worker));

  return { server_templates, server_group_details, template_monitoring_configs: configs, errors };
}

// Fetch + parse one template's monitoring config. Throws on any non-JSON /
// non-OK / unparseable response so the caller records it per-template. Never
// escalates to a whole-run "session not detected" - the tree fetch already
// proved the session is valid.
async function fetchTemplateConfig(fetchImpl, host, tid, signal) {
  const url = `${host}${MONITORING_CONFIG_PATH}?server_id=${encodeURIComponent(tid)}`;
  const res = await fetchImpl(url, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    signal
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = (typeof res.headers?.get === 'function' ? (res.headers.get('content-type') ?? '') : '') + '';
  if (!/json/i.test(ct)) throw new Error('non-JSON response (bad input or rate-limited)');
  const parsed = parseMonitoringConfig(await res.json());
  if (!parsed) throw new Error('unexpected response shape from get_monitoring_config_data');
  return parsed;
}
