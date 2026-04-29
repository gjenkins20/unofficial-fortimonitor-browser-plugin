// FMN-120 followup: regressions for the two changes that landed
// after the matrix-driven analysis showed open models were re-querying
// because they read explicit nulls as "missing data."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt,
  SYSTEM_PROMPT,
  buildToolHandlers
} from '../src/lib/claude-tools.js';

// ---------- system prompt ----------

test('buildSystemPrompt(default) includes the trust-summaries directive', () => {
  const p = buildSystemPrompt();
  assert.match(p, /Tool results are intentionally summarized/);
  assert.match(p, /PRESENT what the tool returned/);
});

test('buildSystemPrompt(default) includes the markdown-table directive', () => {
  const p = buildSystemPrompt();
  assert.match(p, /markdown table/);
});

test('buildSystemPrompt({promptHints:false}) keeps trust-summaries (it is a guideline, not a hint)', () => {
  // The trust-summaries directive lives in the guidelines block, not
  // the per-query hint block. Toggling hints off should NOT remove it.
  const p = buildSystemPrompt({ promptHints: false });
  assert.match(p, /Tool results are intentionally summarized/);
});

test('buildSystemPrompt({promptHints:false}) drops the per-query quick-reference', () => {
  const p = buildSystemPrompt({ promptHints: false });
  assert.doesNotMatch(p, /Tool selection quick-reference/);
});

test('SYSTEM_PROMPT export equals buildSystemPrompt() default', () => {
  assert.equal(SYSTEM_PROMPT, buildSystemPrompt());
});

// ---------- summarizeOutages-via-handlers (null stripping) ----------

test('list_active_outages handler returns outages with null fields stripped', async () => {
  const stub = makeStub({
    listOutages: async () => ({
      outage_list: [
        { id: 1, server: { name: 's1' }, active: true, severity: 'critical', start: null, end: null, acknowledged: null }
      ],
      meta: { total_count: 1 }
    })
  });
  const handlers = buildToolHandlers(stub);
  const r = await handlers.list_active_outages({});
  assert.equal(r.total, 1);
  assert.equal(r.outages.length, 1);
  const o = r.outages[0];
  // Populated fields present.
  assert.equal(o.id, 1);
  assert.equal(o.server, 's1');
  assert.equal(o.active, true);
  assert.equal(o.severity, 'critical');
  // Null fields stripped — model should not see them.
  assert.ok(!('start' in o), 'start should be stripped');
  assert.ok(!('end' in o), 'end should be stripped');
  assert.ok(!('acknowledged' in o), 'acknowledged should be stripped');
});

test('list_servers handler strips null status from each entry', async () => {
  const stub = makeStub({
    listServers: async () => ({
      server_list: [
        { id: 1, name: 'a', status: 'active' },
        { id: 2, name: 'b', status: null }
      ],
      meta: { total_count: 2 }
    })
  });
  const handlers = buildToolHandlers(stub);
  const r = await handlers.list_servers({ limit: 25, offset: 0 });
  assert.equal(r.servers.length, 2);
  assert.deepEqual(r.servers[0], { id: 1, name: 'a', status: 'active' });
  // Second server's status was null - it should not appear.
  assert.deepEqual(r.servers[1], { id: 2, name: 'b' });
});

test('search_servers handler strips null status', async () => {
  const stub = makeStub({
    listServers: async () => ({
      server_list: [{ id: 7, name: 'z', status: null }]
    })
  });
  const handlers = buildToolHandlers(stub);
  const r = await handlers.search_servers({ name: 'z' });
  assert.deepEqual(r, [{ id: 7, name: 'z' }]);
});

function makeStub(overrides = {}) {
  const noop = async () => null;
  return {
    listServers: noop,
    getServer: noop,
    listOutages: noop,
    getOutage: noop,
    acknowledgeOutage: noop,
    listAgentResourcesForServer: noop,
    listFabricConnections: noop,
    listServerGroups: async () => [],
    listTemplates: async () => [],
    listServerAttributes: async () => [],
    listServerTemplateMappings: async () => [],
    _request: noop,
    ...overrides
  };
}
