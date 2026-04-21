// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Background-side handlers for the Add Fabric Connection (Bulk) tool.
//
// Pattern mirrors message-handlers.js: pure factory that returns an
// object of { messageType: handler } maps. The service worker merges
// this into the main router.
//
// Auth: each request reads the API key from chrome.storage.local on
// demand (via createProductionPanoptaClient) so storage updates take
// effect without a service-worker reload.

import {
  createProductionPanoptaClient,
  PanoptaError
} from '../lib/panopta-client.js';
import { mapConcurrent } from '../lib/concurrency.js';
import { withRetry, backoffDelayMs } from '../lib/retry.js';

// HTTP statuses where retry stands a chance of succeeding.
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
 * Execute a batch of fabric-connection creates with bounded
 * concurrency, retry-on-transient, and progress events.
 *
 * @param {object} params
 * @param {Array<{serial:string, ip:string, port:number}>} params.devices
 * @param {string} params.onsightUrl
 * @param {string} params.serverGroupUrl
 * @param {string|null} [params.applianceGroupUrl]
 * @param {number} [params.discoverFrequency]
 * @param {object} [params.client] - PanoptaClient (factory call result)
 * @param {number} [params.concurrency=1]
 * @param {number} [params.maxAttempts=3]
 * @param {boolean} [params.dryRun=false]
 * @param {AbortSignal} [params.signal]
 * @param {(i:number, device:object) => void} [params.onEntryStart]
 * @param {(i:number, result:object) => void} [params.onEntryDone]
 */
export async function executeFabricBatch({
  devices,
  onsightUrl,
  serverGroupUrl,
  applianceGroupUrl = null,
  discoverFrequency = 60,
  client,
  concurrency = 1,
  maxAttempts = 3,
  dryRun = false,
  signal,
  onEntryStart,
  onEntryDone,
  sleep,
  backoff = backoffDelayMs
} = {}) {
  if (!Array.isArray(devices)) throw new TypeError('executeFabricBatch: devices must be an array');
  if (!onsightUrl) throw new TypeError('executeFabricBatch: onsightUrl is required');
  if (!serverGroupUrl) throw new TypeError('executeFabricBatch: serverGroupUrl is required');
  if (!dryRun && !client) throw new TypeError('executeFabricBatch: client is required when not dryRun');

  const settled = await mapConcurrent(devices, async (device, i) => {
    onEntryStart?.(i, device);
    let attempts = 0;
    try {
      if (dryRun) {
        // Build the payload the way the client would, without POSTing.
        // Use the client's helper if available; otherwise inline minimal preview.
        const preview = {
          integration_type: 'onsight_csf_tunnel',
          label: device.ip,
          onsight: onsightUrl,
          server_group: serverGroupUrl,
          ...(applianceGroupUrl ? { appliance_group: applianceGroupUrl } : {}),
          upstream_host: device.ip,
          upstream_port: Number(device.port),
          upstream_sn: device.serial,
          discover_frequency: discoverFrequency
        };
        const result = { device, status: 'succeeded', dryRun: true, preview, attempts: 1 };
        onEntryDone?.(i, result);
        return result;
      }
      const value = await withRetry(
        async (attempt) => {
          attempts = attempt + 1;
          return client.createFabricConnection({
            serial: device.serial,
            ip: device.ip,
            port: device.port,
            onsightUrl,
            serverGroupUrl,
            applianceGroupUrl,
            discoverFrequency
          });
        },
        {
          maxAttempts,
          shouldRetry: isRetryable,
          backoff,
          sleep,
          signal
        }
      );
      const result = { device, status: 'succeeded', value, attempts };
      onEntryDone?.(i, result);
      return result;
    } catch (reason) {
      const result = {
        device,
        status: 'failed',
        attempts: attempts || 1,
        error: reason?.message ?? String(reason),
        errorStatus: reason?.status ?? null,
        errorBody: reason?.responseBody ?? null
      };
      onEntryDone?.(i, result);
      return result;
    }
  }, { concurrency, signal });

  return settled.map((r) => r.value);
}

/**
 * Build the message handlers map. Service worker merges this with the
 * port-scope handlers from message-handlers.js.
 *
 * @param {object} deps
 * @param {{ emit?: (event: string, payload: any) => void }} [deps.events]
 * @param {() => Promise<object>} [deps.getClient] - factory; defaults to createProductionPanoptaClient
 */
export function createFabricHandlers({ events = {}, getClient } = {}) {
  const emit = events.emit ?? (() => {});
  const factory = getClient ?? (() => createProductionPanoptaClient());

  let currentRun = null;

  return {
    'panopta:test-connection': async () => {
      const client = await factory();
      return await client.testConnection();
    },

    'panopta:list-onsight': async () => {
      const client = await factory();
      return await client.listOnsight();
    },

    'panopta:list-server-groups': async () => {
      const client = await factory();
      return await client.listServerGroups();
    },

    'panopta:list-onsight-groups': async () => {
      const client = await factory();
      return await client.listOnsightGroups();
    },

    'fc:create-batch': async (payload) => {
      if (currentRun) throw new Error('A fabric-connection batch is already running');
      const ac = new AbortController();
      currentRun = { ac, startedAt: new Date().toISOString() };
      try {
        const client = payload.dryRun ? null : await factory();
        const results = await executeFabricBatch({
          devices: payload.devices ?? [],
          onsightUrl: payload.onsightUrl,
          serverGroupUrl: payload.serverGroupUrl,
          applianceGroupUrl: payload.applianceGroupUrl ?? null,
          discoverFrequency: payload.discoverFrequency ?? 60,
          client,
          concurrency: payload.concurrency ?? 1,
          maxAttempts: payload.maxAttempts ?? 3,
          dryRun: !!payload.dryRun,
          signal: ac.signal,
          onEntryStart: (i, device) => emit('fc:entry-start', { index: i, serial: device.serial }),
          onEntryDone: (i, result) => emit('fc:entry-done', {
            index: i,
            serial: result.device.serial,
            status: result.status,
            attempts: result.attempts,
            error: result.error ?? null,
            resourceId: result.value?.resourceId ?? null
          })
        });
        return { results, startedAt: currentRun.startedAt, finishedAt: new Date().toISOString() };
      } finally {
        currentRun = null;
      }
    },

    'fc:abort': async () => {
      if (!currentRun) return { aborted: false, reason: 'no active run' };
      currentRun.ac.abort();
      return { aborted: true };
    }
  };
}
