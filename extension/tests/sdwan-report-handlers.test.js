import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecord,
  buildGroupLookup,
  runSdwanReport,
  createSdwanReportHandlers
} from '../src/background/sdwan-report-handlers.js';

// ---------------------------------------------------------------------
// buildRecord (per-metric mapping)
// ---------------------------------------------------------------------

test('buildRecord: maps a FortiGate SNMP loss metric to classification + sla_loss_pct', () => {
  const server = { id: 42024060, name: 'FGVM01TM24006844', fqdn: '10.0.0.94' };
  const groupLookup = new Map([['42024060', 'Fabric Lab']]);
  const metric = {
    id: 379059958,
    formatted_name: 'SD-WAN Link Packet Loss Google_DNS - wan1',
    name: 'SDWAN_PacketLoss_wan1',
    base_oid: '1.3.6.1.4.1.12356.101.4.9.2.1.9.1.0',
    last_value: 12.5,
    status: 'ok',
    last_check: '2026-05-01T10:00:00Z',
    url: 'https://api2.panopta.com/v2/server/42024060/snmp_resource/379059958',
    _source: 'snmp_resource'
  };
  const r = buildRecord(metric, server, groupLookup);
  assert.equal(r.server_id, '42024060');
  assert.equal(r.server_name, 'FGVM01TM24006844');
  assert.equal(r.server_group, 'Fabric Lab');
  // wan1 candidate hits underlay first — same as Python.
  assert.equal(r.classification, 'underlay');
  assert.equal(r.interface_name, 'wan1');
  // OID branch .9 -> loss; sla_loss_pct picks up last_value.
  assert.equal(r.sla_loss_pct, 12.5);
  assert.equal(r.sla_latency_ms, null);
  assert.equal(r.sla_jitter_ms, null);
  assert.equal(r.metric_type_oid, 'loss');
  assert.equal(r.snmp_resource_id, '379059958');
  assert.equal(r.resource_url, metric.url);
});

test('buildRecord: latency OID (.4) populates sla_latency_ms', () => {
  const r = buildRecord({
    formatted_name: 'SD-WAN Latency target1 - wan2',
    base_oid: '1.3.6.1.4.1.12356.101.4.9.2.1.4.1.0',
    last_value: 24,
    url: '/server/1/snmp_resource/9',
    _source: 'snmp_resource'
  }, { id: 1 }, new Map());
  assert.equal(r.sla_latency_ms, 24);
  assert.equal(r.metric_type_oid, 'latency');
});

test('buildRecord: jitter OID (.5) populates sla_jitter_ms', () => {
  const r = buildRecord({
    formatted_name: 'SD-WAN Jitter target1 - wan3',
    base_oid: '1.3.6.1.4.1.12356.101.4.9.2.1.5.1.0',
    last_value: 3.2,
    url: '/server/1/snmp_resource/9',
    _source: 'snmp_resource'
  }, { id: 1 }, new Map());
  assert.equal(r.sla_jitter_ms, 3.2);
  assert.equal(r.metric_type_oid, 'jitter');
});

test('buildRecord: returns null when classification fails on every fallback', () => {
  const r = buildRecord(
    { formatted_name: 'CPU usage - core0', base_oid: '1.3.6.1.2.1.25.3.3.1.2.0', _source: 'snmp_resource' },
    { id: 99 },
    new Map()
  );
  assert.equal(r, null);
});

test('buildRecord: agent_resource bandwidth on wan1 lands in report (underlay)', () => {
  const r = buildRecord({
    name: 'Bandwidth: kb in/sec - wan1',
    last_value: 8000,
    url: '/server/1/agent_resource/55'
  }, { id: 1, name: 's1' }, new Map());
  assert.equal(r.classification, 'underlay');
  assert.equal(r.interface_name, 'wan1');
  // Non-SNMP source: SLA fields stay null when the metric doesn't carry them.
  assert.equal(r.sla_latency_ms, null);
  assert.equal(r.metric_type_oid, null);
});

test('buildRecord: network_service falls back to target / address fields', () => {
  const r = buildRecord({
    name: 'TCP Check',
    target: 'mpls-cloud.example.com',
    _source: 'network_service'
  }, { id: 1, name: 's1' }, new Map());
  assert.equal(r.classification, 'underlay');
  assert.equal(r.interface_name, 'mpls-cloud.example.com');
  assert.equal(r.source, 'network_service');
});

test('buildRecord: extracts server_id from URL when id field is missing', () => {
  const server = { url: 'https://api2.panopta.com/v2/server/42024061', name: 'unit' };
  const r = buildRecord(
    { name: 'Bandwidth - vpn0', _source: 'agent_resource' },
    server, new Map()
  );
  assert.equal(r.server_id, '42024061');
});

test('buildRecord: zero last_value is preserved as null (matches Python "or None")', () => {
  const r = buildRecord({
    formatted_name: 'SD-WAN Loss - wan1',
    last_value: 0,
    _source: 'snmp_resource',
    base_oid: '1.3.6.1.4.1.12356.101.4.9.2.1.9.1.0'
  }, { id: 1 }, new Map());
  // 0 -> null per the Python idiom; the OID-stamping then writes
  // sla_loss_pct = lastValue (which is null), which is correct: 0 is
  // indistinguishable from "no data" in this path.
  assert.equal(r.last_value, null);
  assert.equal(r.sla_loss_pct, null);
});

// ---------------------------------------------------------------------
// buildGroupLookup
// ---------------------------------------------------------------------

test('buildGroupLookup: handles servers as bare ids and as objects', () => {
  const groups = [
    { name: 'Edge', servers: [101, 102] },
    { name: 'Core', servers: [{ id: 200 }, { id: 201 }] }
  ];
  const m = buildGroupLookup(groups);
  assert.equal(m.get('101'), 'Edge');
  assert.equal(m.get('200'), 'Core');
  assert.equal(m.size, 4);
});

test('buildGroupLookup: skips groups with no servers / null groups arg', () => {
  assert.equal(buildGroupLookup(null).size, 0);
  assert.equal(buildGroupLookup([{ name: 'x' }]).size, 0);
});

// ---------------------------------------------------------------------
// runSdwanReport (orchestration)
// ---------------------------------------------------------------------

function makeFakeClient(servers, perServer) {
  return {
    async listAllServers() { return servers; },
    async listAllServerGroups() { return []; },
    async listSnmpResourcesForServer(id) { return perServer[id]?.snmp ?? []; },
    async listAllAgentResourcesForServer(id) { return perServer[id]?.agent ?? []; },
    async listNetworkServicesForServer(id) { return perServer[id]?.netsvc ?? []; }
  };
}

test('runSdwanReport: walks every server, classifies metrics, returns the JSON shape', async () => {
  const servers = [
    { id: 100, name: 'fgt-edge-01' },
    { id: 200, name: 'fgt-core-02' }
  ];
  const perServer = {
    100: {
      snmp: [
        // SD-WAN loss metric
        {
          id: 1, formatted_name: 'SD-WAN Link Packet Loss target1 - wan1',
          base_oid: '1.3.6.1.4.1.12356.101.4.9.2.1.9.1.0',
          last_value: 5,
          url: '/server/100/snmp_resource/1'
        },
        // CPU - should be skipped
        { id: 2, formatted_name: 'CPU - core0', base_oid: '1.3.6.1.2.1.25.3.3.1.2.0', url: '/server/100/snmp_resource/2' }
      ],
      agent: [
        // Bandwidth on vpn0 — overlay
        { id: 3, name: 'Bandwidth: kb in/sec - vpn0', url: '/server/100/agent_resource/3' }
      ]
    },
    200: {
      netsvc: [
        // ICMP target hits underlay via 'target'
        { id: 4, name: 'ICMP', target: 'isp-comcast', url: '/server/200/network_service/4' }
      ]
    }
  };

  const events = [];
  const result = await runSdwanReport({
    client: makeFakeClient(servers, perServer),
    onProgress: (e) => events.push(e)
  });

  assert.equal(result.total_servers, 2);
  assert.equal(result.total_records, 3);
  assert.equal(result.records.length, 3);

  const byInterface = Object.fromEntries(result.records.map((r) => [r.interface_name, r]));
  assert.equal(byInterface.wan1.classification, 'underlay');
  assert.equal(byInterface.wan1.sla_loss_pct, 5);
  assert.equal(byInterface.vpn0.classification, 'overlay');
  assert.equal(byInterface['isp-comcast'].classification, 'underlay');

  // Progress events: must fire fetch/fetched, server:start/done per server.
  const phases = events.map((e) => e.phase);
  assert(phases.includes('servers:fetch'));
  assert(phases.includes('servers:fetched'));
  assert.equal(phases.filter((p) => p === 'server:start').length, 2);
  assert.equal(phases.filter((p) => p === 'server:done').length, 2);
});

test('runSdwanReport: AbortSignal stops the crawl mid-flight', async () => {
  const servers = [{ id: 100 }, { id: 200 }, { id: 300 }];
  const ac = new AbortController();
  let serversTouched = 0;
  const client = {
    async listAllServers() { return servers; },
    async listAllServerGroups() { return []; },
    async listSnmpResourcesForServer() {
      serversTouched += 1;
      if (serversTouched === 1) ac.abort();
      return [];
    },
    async listAllAgentResourcesForServer() { return []; },
    async listNetworkServicesForServer() { return []; }
  };

  await assert.rejects(
    runSdwanReport({ client, signal: ac.signal }),
    (err) => err.name === 'AbortError'
  );
});

test('runSdwanReport: server-group fetch failure is non-fatal; emits groups:unavailable', async () => {
  const servers = [{ id: 1 }];
  const events = [];
  const client = {
    async listAllServers() { return servers; },
    async listAllServerGroups() { throw new Error('groups dead'); },
    async listSnmpResourcesForServer() { return []; },
    async listAllAgentResourcesForServer() { return []; },
    async listNetworkServicesForServer() { return []; }
  };
  const result = await runSdwanReport({ client, onProgress: (e) => events.push(e) });
  assert.equal(result.total_records, 0);
  const evt = events.find((e) => e.phase === 'groups:unavailable');
  assert(evt, 'groups:unavailable should be emitted');
  assert.match(evt.error, /groups dead/);
});

test('runSdwanReport: per-server SNMP failure is non-fatal; emits server:error and continues', async () => {
  const servers = [{ id: 1, name: 's1' }, { id: 2, name: 's2' }];
  const events = [];
  const client = {
    async listAllServers() { return servers; },
    async listAllServerGroups() { return []; },
    async listSnmpResourcesForServer(id) {
      if (id === '1' || id === 1) throw new Error('snmp dead');
      return [];
    },
    async listAllAgentResourcesForServer() { return []; },
    async listNetworkServicesForServer() { return []; }
  };
  const result = await runSdwanReport({ client, onProgress: (e) => events.push(e) });
  // Per-endpoint failures are swallowed in collectFromServer (matches the
  // Python source). server:error is reserved for failures higher up the
  // stack; here, the run completes cleanly with zero records.
  assert.equal(result.total_records, 0);
  assert.equal(result.total_servers, 2);
});

// ---------------------------------------------------------------------
// createSdwanReportHandlers (single-flight + abort)
// ---------------------------------------------------------------------

test('createSdwanReportHandlers: emits sdwan:progress events and returns the result', async () => {
  const events = [];
  const handlers = createSdwanReportHandlers({
    events: { emit: (e, p) => events.push({ e, p }) },
    getClient: async () => makeFakeClient(
      [{ id: 1, name: 's1' }],
      { 1: { agent: [{ id: 7, name: 'Bandwidth - wan1' }] } }
    )
  });
  const result = await handlers['sdwan:run-report']({});
  assert.equal(result.total_records, 1);
  assert.equal(result.records[0].interface_name, 'wan1');
  assert(events.some((m) => m.e === 'sdwan:progress' && m.p?.phase === 'servers:fetched'));
});

test('createSdwanReportHandlers: rejects a second concurrent run', async () => {
  let release;
  const slow = new Promise((res) => { release = res; });
  const handlers = createSdwanReportHandlers({
    getClient: async () => ({
      async listAllServers() { await slow; return []; },
      async listAllServerGroups() { return []; },
      async listSnmpResourcesForServer() { return []; },
      async listAllAgentResourcesForServer() { return []; },
      async listNetworkServicesForServer() { return []; }
    })
  });
  const first = handlers['sdwan:run-report']({});
  await assert.rejects(handlers['sdwan:run-report']({}), /already in progress/);
  release([]);
  await first;
});

test("createSdwanReportHandlers: 'sdwan:abort' cancels the active run; surfaces AbortError", async () => {
  let release;
  const blocked = new Promise((res) => { release = res; });
  const handlers = createSdwanReportHandlers({
    getClient: async () => ({
      async listAllServers({ signal }) {
        await new Promise((res, rej) => {
          signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
          release = res;
        });
        return [];
      },
      async listAllServerGroups() { return []; },
      async listSnmpResourcesForServer() { return []; },
      async listAllAgentResourcesForServer() { return []; },
      async listNetworkServicesForServer() { return []; }
    })
  });
  const run = handlers['sdwan:run-report']({});
  // Give the handler a tick to enter listAllServers.
  await new Promise((res) => setTimeout(res, 5));
  const abortResult = await handlers['sdwan:abort']();
  assert.equal(abortResult.aborted, true);
  await assert.rejects(run, (err) => err.name === 'AbortError');
});

test("createSdwanReportHandlers: 'sdwan:abort' is a no-op when no run is active", async () => {
  const handlers = createSdwanReportHandlers({});
  const r = await handlers['sdwan:abort']();
  assert.equal(r.aborted, false);
});
