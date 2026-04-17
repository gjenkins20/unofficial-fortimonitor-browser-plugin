// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Device scanner: given a list of server IDs, read each device's port
// scope with bounded concurrency, fingerprint it, and return per-device
// results. Group-by-fingerprint produces the N-groups-from-M-devices
// collapse that drives the scale model.

import { mapConcurrent } from '../lib/concurrency.js';
import { fingerprintDevice } from '../lib/fingerprint.js';

/**
 * @param {Array<string|number>} serverIds
 * @param {object} options
 * @param {import('../lib/fortimonitor-client.js').FortimonitorClient} options.client
 * @param {number} [options.concurrency=3]
 * @param {(done:number, total:number, lastResult:object) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 */
export async function scanDevices(serverIds, { client, concurrency = 3, onProgress, signal } = {}) {
  if (!client) throw new TypeError('scanDevices requires a client');
  if (!Array.isArray(serverIds)) throw new TypeError('scanDevices: serverIds must be an array');

  const total = serverIds.length;
  let done = 0;
  const results = new Array(total);

  const settled = await mapConcurrent(
    serverIds,
    async (serverId) => {
      const portsData = await client.getDevicePorts(serverId);
      const fingerprint = await fingerprintDevice({ ports: portsData.ports });
      return { serverId, fingerprint, portsData };
    },
    {
      concurrency,
      signal,
      onItem: (i, res) => {
        if (res.status === 'fulfilled') {
          results[i] = { ...res.value, error: null };
        } else {
          results[i] = {
            serverId: serverIds[i],
            fingerprint: null,
            portsData: null,
            error: serializeError(res.reason)
          };
        }
        done++;
        onProgress?.(done, total, results[i]);
      }
    }
  );

  // Preserve order matching input serverIds.
  for (let i = 0; i < settled.length; i++) {
    if (results[i] === undefined) {
      // Defensive: if onItem wasn't called (shouldn't happen), synthesize.
      if (settled[i].status === 'fulfilled') {
        results[i] = { ...settled[i].value, error: null };
      } else {
        results[i] = {
          serverId: serverIds[i],
          fingerprint: null,
          portsData: null,
          error: serializeError(settled[i].reason)
        };
      }
    }
  }
  return results;
}

// Errors cross the service-worker → popup message boundary, which strips
// Error instances to {} and loses .message. Flatten to a POJO so the UI
// can actually display the failure reason. Diagnostic fields
// (responseUrl / contentType / bodyPreview) are carried through for
// developer-mode rendering; the UI gates their visibility, not this.
function serializeError(err) {
  if (err == null) return null;
  if (typeof err !== 'object') return { message: String(err) };
  return {
    name: err.name ?? 'Error',
    message: err.message ?? String(err),
    status: err.status ?? null,
    phase: err.phase ?? null,
    responseUrl: err.responseUrl ?? null,
    contentType: err.contentType ?? null,
    bodyPreview: err.bodyPreview ?? null
  };
}

/**
 * Collapse scan results into fingerprint groups. Results without a
 * fingerprint (i.e. errored scans) are excluded from grouping and
 * returned separately for operator attention.
 *
 * @param {Array<{serverId:any, fingerprint:string|null, portsData:any, error:any}>} scanResults
 * @returns {{
 *   groups: Array<{fingerprint:string, portsData:any, devices:Array<{serverId:any}>}>,
 *   errored: Array<{serverId:any, error:any}>
 * }}
 */
export function groupByFingerprint(scanResults) {
  const map = new Map();
  const errored = [];
  for (const r of scanResults) {
    if (!r.fingerprint) {
      errored.push({ serverId: r.serverId, error: r.error });
      continue;
    }
    if (!map.has(r.fingerprint)) {
      map.set(r.fingerprint, {
        fingerprint: r.fingerprint,
        portsData: r.portsData,
        devices: []
      });
    }
    map.get(r.fingerprint).devices.push({ serverId: r.serverId });
  }
  return { groups: [...map.values()], errored };
}
