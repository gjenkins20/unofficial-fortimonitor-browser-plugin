import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../src/lib/bulk-actions/set-agent-resource-status.js';

// =====================================================================
// FMN-171: Set Agent Resource Status descriptor
// =====================================================================

// ---------- validate ----------

test('validate: requires filter + valid status', () => {
  assert.equal(a.validate({}).ok, false);
  assert.equal(a.validate({ filter: 'fortigate.bandwidth' }).ok, false);
  assert.equal(a.validate({ filter: 'x', status: 'paused' }).ok, false);
  const ok = a.validate({ filter: 'fortigate.bandwidth', status: 'suspended' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.status, 'suspended');
});

test('validate: empty filter rejected (foot-gun prevention)', () => {
  const r = a.validate({ filter: '   ', status: 'active' });
  assert.equal(r.ok, false);
});

// ---------- describe ----------

const RULE = { filter: 'bandwidth', status: 'suspended' };

test('describe: agentResources=undefined -> placeholder branch', () => {
  const d = a.describe({ id: 1, name: 's1' }, RULE);
  assert.equal(d.willChange, true);
  assert.equal(d.prev, '(resources unknown)');
});

test('describe: agentResources=null -> skip with not-found copy', () => {
  const d = a.describe({ id: 1, name: 's1', agentResources: null }, RULE);
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
});

test('describe: zero matches -> skip', () => {
  const d = a.describe({ id: 1, name: 's1', agentResources: { matched: [], total: 50 } }, RULE);
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /No agent_resource matched filter "bandwidth"/);
});

test('describe: all matched already in target status -> skip', () => {
  const target = {
    id: 1, name: 's1',
    agentResources: {
      matched: [
        { id: 1, name: 'port1.bandwidth', status: 'suspended' },
        { id: 2, name: 'port2.bandwidth', status: 'suspended' }
      ],
      total: 50
    }
  };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /already "suspended"/);
});

test('describe: some matched will flip -> will-change with count', () => {
  const target = {
    id: 1, name: 's1',
    agentResources: {
      matched: [
        { id: 1, name: 'port1.bandwidth', status: 'active' },
        { id: 2, name: 'port2.bandwidth', status: 'suspended' },
        { id: 3, name: 'port3.bandwidth', status: 'active' }
      ],
      total: 50
    }
  };
  const d = a.describe(target, RULE);
  assert.equal(d.willChange, true);
  assert.match(d.next, /2 → suspended/);
  assert.match(d.note, /Will flip 2 of 3/);
});

// ---------- commit ----------

test('commit: matches existing items, flips only the non-matching status', async () => {
  const calls = [];
  const client = {
    async listAgentResourcesForServer() {
      return {
        agent_resource_list: [
          { url: 'https://api2/v2/server/42/agent_resource/1/', name: 'port1.bandwidth', status: 'active' },
          { url: 'https://api2/v2/server/42/agent_resource/2/', name: 'port2.bandwidth', status: 'suspended' },
          { url: 'https://api2/v2/server/42/agent_resource/3/', name: 'port3.bandwidth', status: 'active' },
          { url: 'https://api2/v2/server/42/agent_resource/4/', name: 'mem.available', status: 'active' }
        ]
      };
    },
    async setAgentResourceStatus(serverId, arId, status) {
      calls.push({ arId, status });
      return { status: 200, before: 'active', after: status, noop: false };
    }
  };
  const out = await a.commit({ id: 42 }, RULE, { client });
  assert.equal(out.noop, false);
  assert.equal(out.matched, 3); // 3 bandwidth resources match
  assert.equal(out.flipped, 2); // 2 were active, 1 already suspended
  assert.deepEqual(calls.map((c) => c.arId).sort((a, b) => a - b), [1, 3]);
});

test('commit: no matches -> noop with reason', async () => {
  const client = {
    async listAgentResourcesForServer() { return { agent_resource_list: [] }; },
    async setAgentResourceStatus() { throw new Error('should not call'); }
  };
  const out = await a.commit({ id: 42 }, RULE, { client });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'no-matches');
});

test('commit: all matched already in target status -> noop, no PUTs', async () => {
  let putCalled = false;
  const client = {
    async listAgentResourcesForServer() {
      return {
        agent_resource_list: [
          { url: 'https://api2/v2/server/42/agent_resource/1/', name: 'port1.bandwidth', status: 'suspended' }
        ]
      };
    },
    async setAgentResourceStatus() { putCalled = true; return { noop: true }; }
  };
  const out = await a.commit({ id: 42 }, RULE, { client });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'already-in-status');
  assert.equal(putCalled, false);
});

test('commit: per-resource failure surfaces in failures[], does not abort the run', async () => {
  const client = {
    async listAgentResourcesForServer() {
      return {
        agent_resource_list: [
          { url: 'https://api2/v2/server/42/agent_resource/1/', name: 'a.bandwidth', status: 'active' },
          { url: 'https://api2/v2/server/42/agent_resource/2/', name: 'b.bandwidth', status: 'active' }
        ]
      };
    },
    async setAgentResourceStatus(_, arId) {
      if (arId === 1) throw new Error('boom');
      return { status: 200, before: 'active', after: 'suspended', noop: false };
    }
  };
  const out = await a.commit({ id: 42 }, RULE, { client });
  assert.equal(out.matched, 2);
  assert.equal(out.flipped, 1);
  assert.equal(out.failures?.length, 1);
  assert.equal(out.failures[0].id, 1);
});

test('commit: 404 on the list surfaces friendly error', async () => {
  const client = {
    async listAgentResourcesForServer() {
      const err = new Error('Not found');
      err.status = 404;
      throw err;
    }
  };
  await assert.rejects(
    () => a.commit({ id: 42 }, RULE, { client }),
    /Instance #42 not found/
  );
});

test('commit: missing client throws', async () => {
  await assert.rejects(() => a.commit({ id: 1 }, RULE, {}), /PanoptaClient required/);
});
