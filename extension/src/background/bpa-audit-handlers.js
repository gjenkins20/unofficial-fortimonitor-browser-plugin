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

import { PanoptaError } from '../lib/panopta-client.js';
import { BpaFetcher, createBpaFetch } from '../lib/bpa-fetcher.js';
import { PanoptaClient } from '../lib/panopta-client.js';
import { runAllAnalyzers } from '../lib/bpa-analyzers/index.js';

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
 * @param {AbortSignal} [options.signal]
 * @param {(evt:object) => void} [options.onProgress]
 */
export async function runBpaAudit({
  client,
  deep = false,
  maxServers = 0,
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

  onProgress?.({ phase: 'analyze:start' });
  const analysis = runAllAnalyzers(inventory);
  onProgress?.({ phase: 'analyze:done' });

  const finishedAt = new Date().toISOString();
  return {
    started_at: startedAt,
    finished_at: finishedAt,
    deep,
    max_servers: maxServers,
    inventory,
    analysis
  };
}

// ---- Message handlers ------------------------------------------------------

export function createBpaAuditHandlers({ events = {}, getClient } = {}) {
  const emit = events.emit ?? (() => {});
  const factory = getClient ?? (() => defaultClientFactory());

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
          signal: ac.signal,
          onProgress: (evt) => emit('bpa:progress', evt)
        });
        return result;
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

    'bpa:abort': async () => {
      if (!currentRun) return { aborted: false, reason: 'no active run' };
      currentRun.ac.abort();
      return { aborted: true };
    }
  };
}
