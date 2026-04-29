// FMN-111 / FMN-112: tests for the bulk_operations and composite hand-port modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from '../src/lib/claude-tools/handwritten/concurrency.js';
import { buildBulkOpsHandlers } from '../src/lib/claude-tools/handwritten/bulk_operations.js';
import { buildCompositeHandlers } from '../src/lib/claude-tools/handwritten/composite.js';

// ---------- mapWithConcurrency ----------------------------------------

test('mapWithConcurrency caps simultaneous in-flight tasks', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const results = await mapWithConcurrency(items, 3, async (i) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return i * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results.map((r) => r.value), items.map((i) => i * 2));
});

test('mapWithConcurrency captures rejections without poisoning the batch', async () => {
  const results = await mapWithConcurrency([1, 2, 3], 2, async (i) => {
    if (i === 2) throw new Error('boom');
    return i;
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error, 'boom');
  assert.equal(results[2].ok, true);
});

// ---------- bulk_acknowledge_outages ---------------------------------

test('bulk_acknowledge_outages calls acknowledgeOutage for each id and reports counts', async () => {
  const calls = [];
  const client = {
    acknowledgeOutage: async (id, opts) => {
      calls.push({ id, message: opts?.message ?? null });
      return { status: 200 };
    }
  };
  const handlers = buildBulkOpsHandlers(client);
  const r = await handlers.bulk_acknowledge_outages({ outage_ids: [1, 2, 3], message: 'note' });
  assert.equal(r.acknowledged, 3);
  assert.equal(r.failed, 0);
  assert.deepEqual(calls.map((c) => c.id), [1, 2, 3]);
  assert.ok(calls.every((c) => c.message === 'note'));
});

test('bulk_acknowledge_outages caps at 50 outages per call', async () => {
  const ids = Array.from({ length: 75 }, (_, i) => i);
  let calls = 0;
  const client = { acknowledgeOutage: async () => { calls++; return { status: 200 }; } };
  const r = await buildBulkOpsHandlers(client).bulk_acknowledge_outages({ outage_ids: ids });
  assert.equal(calls, 50);
  assert.equal(r.acknowledged, 50);
  assert.equal(r.capped, true);
});

test('bulk_acknowledge_outages tolerates per-item failures', async () => {
  const client = {
    acknowledgeOutage: async (id) => {
      if (id === 2) throw new Error('not found');
      return { status: 200 };
    }
  };
  const r = await buildBulkOpsHandlers(client).bulk_acknowledge_outages({ outage_ids: [1, 2, 3] });
  assert.equal(r.acknowledged, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.results[1].error, 'not found');
});

// ---------- bulk_add_tags / bulk_remove_tags --------------------------

test('bulk_add_tags merges new tags into the existing list (read-modify-write)', async () => {
  const writes = [];
  const client = {
    getServer: async (id) => ({ id, name: `s${id}`, tags: ['existing'] }),
    _request: async (method, path, opts) => {
      writes.push({ method, path, body: opts?.body });
      return { res: { status: 200 }, body: {} };
    }
  };
  const r = await buildBulkOpsHandlers(client).bulk_add_tags({
    server_ids: [10, 11],
    tags: ['new1', 'new2']
  });
  assert.equal(r.updated, 2);
  assert.deepEqual(writes[0].body.tags.sort(), ['existing', 'new1', 'new2']);
  assert.equal(writes[0].method, 'PUT');
});

test('bulk_remove_tags strips listed tags and leaves others', async () => {
  const writes = [];
  const client = {
    getServer: async (id) => ({ id, tags: ['keep', 'drop'] }),
    _request: async (method, path, opts) => {
      writes.push({ body: opts?.body });
      return { res: { status: 200 }, body: {} };
    }
  };
  await buildBulkOpsHandlers(client).bulk_remove_tags({
    server_ids: [1, 2],
    tags: ['drop']
  });
  assert.deepEqual(writes[0].body.tags, ['keep']);
});

// ---------- search_servers_advanced ----------------------------------

test('search_servers_advanced filters by name_contains case-insensitively', async () => {
  const client = {
    listServers: async ({ offset = 0 }) => {
      if (offset > 0) return { server_list: [], meta: { total_count: 3 } };
      return {
        server_list: [
          { id: 1, name: 'Prod-Web-01', status: 'active' },
          { id: 2, name: 'staging-db-01', status: 'active' },
          { id: 3, name: 'prod-db-01', status: 'active' }
        ],
        meta: { total_count: 3 }
      };
    }
  };
  const r = await buildBulkOpsHandlers(client).search_servers_advanced({ name_contains: 'PROD' });
  assert.equal(r.servers.length, 2);
  assert.deepEqual(r.servers.map((s) => s.id).sort(), [1, 3]);
});

test('search_servers_advanced filters by has_active_outages via /outage/active join', async () => {
  const client = {
    listOutages: async ({ active }) => {
      assert.equal(active, true);
      return { outage_list: [{ id: 100, server: { id: 2 } }], meta: { total_count: 1 } };
    },
    listServers: async () => ({
      server_list: [
        { id: 1, name: 'a', status: 'active' },
        { id: 2, name: 'b', status: 'active' }
      ],
      meta: { total_count: 2 }
    })
  };
  const r = await buildBulkOpsHandlers(client).search_servers_advanced({ has_active_outages: true });
  assert.deepEqual(r.servers.map((s) => s.id), [2]);
});

// ---------- composite: investigate_server -----------------------------

test('investigate_server fans out parallel reads and aggregates them', async () => {
  const client = {
    getServer: async (id) => ({ id, name: 's1', status: 'active', tags: ['alpha'] }),
    listOutages: async () => ({ outage_list: [{ id: 9, severity: 'critical', start: '2026-04-01T00:00:00Z' }] }),
    listAgentResourcesForServer: async () => ({
      agent_resource_list: [{ id: 5, agent_resource_type: 'foo', resource_option: 'port1', status: 'up' }],
      meta: { total_count: 1 }
    }),
    listServerTemplateMappings: async () => [
      { templateId: 42, continuous: true, templateUrl: 'x' }
    ],
    listServerAttributes: async () => [
      { name: 'Model', value: 'FGT60F', textkey: 'dem.model' }
    ]
  };
  const r = await buildCompositeHandlers(client).investigate_server({ server_id: 1 });
  assert.equal(r.server.id, 1);
  assert.equal(r.outages.length, 1);
  assert.equal(r.agent_resources.length, 1);
  assert.equal(r.templates[0].template_id, 42);
  assert.equal(r.attributes[0].name, 'Model');
});

// ---------- composite: find_flapping_servers --------------------------

test('find_flapping_servers ranks servers by outage count above threshold', async () => {
  const client = {
    listOutages: async ({ offset = 0 }) => {
      if (offset > 0) return { outage_list: [], meta: { total_count: 6 } };
      return {
        outage_list: [
          { id: 1, server: { id: 10, name: 'flap' } },
          { id: 2, server: { id: 10, name: 'flap' } },
          { id: 3, server: { id: 10, name: 'flap' } },
          { id: 4, server: { id: 11, name: 'stable' } },
          { id: 5, server: { id: 12, name: 'flap2' } },
          { id: 6, server: { id: 12, name: 'flap2' } }
        ],
        meta: { total_count: 6 }
      };
    }
  };
  const r = await buildCompositeHandlers(client).find_flapping_servers({ min_outages: 2 });
  assert.deepEqual(r.flapping.map((s) => [s.id, s.outage_count]), [
    [10, 3],
    [12, 2]
  ]);
});

test('compare_servers returns one entry per server with counts', async () => {
  const client = {
    getServer: async (id) => ({ id, name: `s${id}`, status: 'active' }),
    listAgentResourcesForServer: async () => ({ agent_resource_list: [], meta: { total_count: 7 } }),
    listServerTemplateMappings: async () => [{ templateId: 1, continuous: true, templateUrl: 'u' }]
  };
  const r = await buildCompositeHandlers(client).compare_servers({ server_ids: [1, 2] });
  assert.equal(r.servers.length, 2);
  for (const s of r.servers) {
    assert.equal(s.agent_resource_count, 7);
    assert.equal(s.attached_template_count, 1);
  }
});
