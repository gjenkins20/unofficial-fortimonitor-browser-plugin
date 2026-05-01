// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Background handlers for the SD-WAN Report tool (FMN-129).
//
// Crawls the v2 API for SNMP / agent / network-service resources across
// every monitored server, classifies each metric against the SD-WAN
// regex lists ported from the BPA Python script, and returns a flat
// records array whose JSON shape is the input contract for the Tag
// Applier (FMN-130). The CSV format is regenerated from the same array
// in the UI step.
//
// Auth: v2 API key via createProductionPanoptaClient. Read-only.
//
// Cancellation: a single-flight pattern; only one report run can be
// active at a time. The 'sdwan:abort' message aborts the active run via
// AbortController.

import {
  createProductionPanoptaClient,
  PanoptaError
} from '../lib/panopta-client.js';
import {
  classifyMetric,
  classifyOidMetricType,
  compilePatterns
} from '../lib/sdwan-classifier.js';

function extractServerId(server) {
  if (server == null) return '';
  if (server.id != null) return String(server.id);
  if (typeof server.url === 'string') {
    const m = server.url.match(/\/server\/(\d+)\/?$/);
    if (m) return m[1];
  }
  return '';
}

function snmpResourceIdFromUrl(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.replace(/\/+$/, '');
  const last = trimmed.split('/').pop();
  return last ?? '';
}

function toFiniteNumberOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // Match the Python `float(...) or None` idiom: 0 returns null. Keeping
  // this pattern matters for the Tag Applier's downstream consumption -
  // empty cells are nulls, not zeros.
  return n === 0 ? null : n;
}

/**
 * Map a raw metric record to the SD-WAN report row, when the metric
 * classifies as overlay/underlay/generic. Returns null when the metric
 * is not SD-WAN-related.
 */
export function buildRecord(metric, server, groupLookup, compiledPatterns) {
  const serverId = extractServerId(server);
  const serverName = server?.name ?? '';
  const serverFqdn = server?.fqdn ?? '';
  const serverGroup = groupLookup.get(serverId) ?? '';

  // First try the metric name suffix; for network_service items, fall
  // back to target/check_type/address (the Python source does the same).
  let { interfaceName, classification } = classifyMetric(metric, compiledPatterns);
  if (!classification) {
    for (const f of ['target', 'check_type', 'address']) {
      const v = metric?.[f];
      if (!v) continue;
      const cls = classifyMetric({ name: String(v) }, compiledPatterns);
      if (cls.classification) {
        interfaceName = String(v);
        classification = cls.classification;
        break;
      }
    }
  }
  if (!classification) return null;

  const formattedName = metric?.formatted_name ?? '';
  const rawName = metric?.name ?? '';
  const metricName = formattedName || rawName;

  const artUrl = metric?.agent_resource_type;
  const metricType = typeof artUrl === 'string' && artUrl
    ? artUrl.split('/').filter(Boolean).pop()
    : (metric?.type_id ?? metric?._source ?? '');

  const lastValue = toFiniteNumberOrNull(metric?.last_value ?? metric?.value);
  const lastStatus = metric?.status ?? '';
  const lastChecked = metric?.last_check ?? '';

  let slaLatency = toFiniteNumberOrNull(metric?.latency ?? metric?.avg_latency);
  let slaJitter = toFiniteNumberOrNull(metric?.jitter ?? metric?.avg_jitter);
  let slaLoss = toFiniteNumberOrNull(metric?.loss ?? metric?.packet_loss);

  // FortiGate SD-WAN MIB: stamp the right SLA field from the OID.
  if (metric?._source === 'snmp_resource') {
    const oid = metric?.base_oid ?? '';
    const oidMetric = classifyOidMetricType(oid);
    if (oidMetric === 'loss') slaLoss = lastValue;
    else if (oidMetric === 'latency') slaLatency = lastValue;
    else if (oidMetric === 'jitter') slaJitter = lastValue;
  }

  const oidMetricType = metric?._source === 'snmp_resource'
    ? classifyOidMetricType(metric?.base_oid ?? '')
    : null;

  const resourceUrl = metric?.url ?? '';
  const snmpResourceId = resourceUrl ? snmpResourceIdFromUrl(resourceUrl) : '';

  return {
    server_id: serverId,
    server_name: serverName,
    server_fqdn: serverFqdn,
    server_group: serverGroup,
    interface_name: interfaceName || metricName,
    interface_type: classification,
    metric_id: metric?.id != null ? String(metric.id) : '',
    metric_name: metricName,
    metric_type: metricType ? String(metricType) : '',
    metric_label: metric?.label ?? '',
    metric_unit: metric?.unit ?? '',
    resource_url: resourceUrl,
    snmp_resource_id: snmpResourceId,
    last_value: lastValue,
    last_status: lastStatus,
    last_checked: lastChecked,
    sla_latency_ms: slaLatency,
    sla_jitter_ms: slaJitter,
    sla_loss_pct: slaLoss,
    sla_status: metric?.sla_status ?? '',
    classification: classification,
    metric_type_oid: oidMetricType,
    source: metric?._source ?? null
  };
}

/**
 * Map server_group records to a Map<serverId, groupName>. Tolerates the
 * two shapes seen in the wild: `servers: [123, 456]` and
 * `servers: [{id: 123}, {id: 456}]`.
 */
export function buildGroupLookup(groups) {
  const lookup = new Map();
  if (!Array.isArray(groups)) return lookup;
  for (const g of groups) {
    const name = g?.name ?? '';
    const list = Array.isArray(g?.servers) ? g.servers : [];
    for (const s of list) {
      const id = typeof s === 'object' && s ? s.id : s;
      if (id == null) continue;
      lookup.set(String(id), name);
    }
  }
  return lookup;
}

/**
 * Walk one server's three resource endpoints, classify, return the
 * subset that's SD-WAN-related.
 */
async function collectFromServer(client, server, groupLookup, compiledPatterns, { signal, onMetric } = {}) {
  const sid = extractServerId(server);
  if (!sid) return [];
  const out = [];

  // SNMP (primary for FortiGate SD-WAN SLA metrics)
  try {
    const snmp = await client.listSnmpResourcesForServer(sid, { signal });
    for (const m of snmp) m._source = 'snmp_resource';
    for (const m of snmp) {
      const rec = buildRecord(m, server, groupLookup, compiledPatterns);
      if (rec) { out.push(rec); onMetric?.(rec); }
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    // Per Python source: warn and continue. The /server may simply not
    // expose SNMP - we don't want one failure to abort the whole crawl.
  }

  // Agent resources
  try {
    const ar = await client.listAllAgentResourcesForServer(sid, { signal });
    for (const m of ar) m._source = m._source ?? 'agent_resource';
    for (const m of ar) {
      const rec = buildRecord(m, server, groupLookup, compiledPatterns);
      if (rec) { out.push(rec); onMetric?.(rec); }
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
  }

  // Network services
  try {
    const ns = await client.listNetworkServicesForServer(sid, { signal });
    for (const m of ns) m._source = 'network_service';
    for (const m of ns) {
      const rec = buildRecord(m, server, groupLookup, compiledPatterns);
      if (rec) { out.push(rec); onMetric?.(rec); }
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
  }

  return out;
}

/**
 * Top-level report runner. Returns the JSON-shape required by FMN-130
 * (the Tag Applier consumes this without translation).
 */
export async function runSdwanReport({
  client,
  patterns = null,
  signal,
  onProgress
} = {}) {
  if (!client) throw new TypeError('runSdwanReport: client is required');
  const compiledPatterns = compilePatterns(patterns ?? {});

  const startedAt = new Date().toISOString();

  onProgress?.({ phase: 'servers:fetch' });
  const servers = await client.listAllServers({ signal });
  const totalServers = servers.length;
  onProgress?.({ phase: 'servers:fetched', totalServers });

  // Server groups are non-fatal labelling. If the call fails, group
  // labels are blank but the rest of the report still runs.
  let groups = [];
  try {
    groups = await client.listAllServerGroups({ signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    onProgress?.({ phase: 'groups:unavailable', error: err?.message ?? String(err) });
  }
  const groupLookup = buildGroupLookup(groups);

  const records = [];
  let processed = 0;
  for (const server of servers) {
    if (signal?.aborted) {
      const err = new Error('aborted'); err.name = 'AbortError'; throw err;
    }
    const sid = extractServerId(server);
    const sname = server?.name ?? '';
    onProgress?.({
      phase: 'server:start',
      processed,
      totalServers,
      serverId: sid,
      serverName: sname,
      matched: records.length
    });
    let perServer = [];
    try {
      perServer = await collectFromServer(client, server, groupLookup, compiledPatterns, {
        signal,
        onMetric: () => onProgress?.({ phase: 'metric:matched' })
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      onProgress?.({
        phase: 'server:error',
        processed,
        totalServers,
        serverId: sid,
        serverName: sname,
        error: err?.message ?? String(err)
      });
    }
    for (const r of perServer) records.push(r);
    processed += 1;
    onProgress?.({
      phase: 'server:done',
      processed,
      totalServers,
      serverId: sid,
      serverName: sname,
      matched: records.length
    });
  }

  const finishedAt = new Date().toISOString();
  return {
    report_generated: finishedAt,
    started_at: startedAt,
    total_servers: totalServers,
    total_records: records.length,
    records
  };
}

// ---- Message handlers --------------------------------------------------

export function createSdwanReportHandlers({ events = {}, getClient } = {}) {
  const emit = events.emit ?? (() => {});
  const factory = getClient ?? (() => createProductionPanoptaClient());

  let currentRun = null;

  return {
    'sdwan:run-report': async (payload) => {
      if (currentRun) throw new Error('An SD-WAN report run is already in progress');
      const ac = new AbortController();
      const startedAt = new Date().toISOString();
      currentRun = { ac, startedAt };
      try {
        const client = await factory();
        const patterns = payload?.patterns ?? null;
        const result = await runSdwanReport({
          client,
          patterns,
          signal: ac.signal,
          onProgress: (evt) => emit('sdwan:progress', evt)
        });
        return result;
      } catch (err) {
        if (err?.name === 'AbortError') {
          // Re-shape so the UI sees an explicit cancellation rather than
          // a generic error string.
          const e = new Error('SD-WAN report cancelled');
          e.name = 'AbortError';
          throw e;
        }
        // Surface PanoptaError messages verbatim; they already carry
        // the redacted bits and the auth hint when relevant.
        if (err instanceof PanoptaError || err?.name === 'PanoptaError') throw err;
        throw err;
      } finally {
        currentRun = null;
      }
    },

    'sdwan:abort': async () => {
      if (!currentRun) return { aborted: false, reason: 'no active run' };
      currentRun.ac.abort();
      return { aborted: true };
    }
  };
}
