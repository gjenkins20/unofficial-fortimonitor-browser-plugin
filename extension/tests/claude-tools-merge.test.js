// FMN-97 / FMN-98 to 107 / FMN-111 / FMN-112: tier filtering and the
// merger that joins hand-written, hand-port, and codegen tools into one
// catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolDefinitions, buildToolHandlers } from '../src/lib/claude-tools.js';
import { ALL_CODEGEN_TOOLS } from '../src/lib/claude-tools/codegen/index.js';
import { BULK_OPS_TOOLS } from '../src/lib/claude-tools/handwritten/bulk_operations.js';
import { COMPOSITE_TOOLS } from '../src/lib/claude-tools/handwritten/composite.js';

test('buildToolDefinitions(readonly) excludes acknowledge_outage and other writes', () => {
  const tools = buildToolDefinitions('readonly');
  const names = new Set(tools.map((t) => t.name));
  assert.ok(names.has('search_servers'), 'hand-written readonly present');
  assert.ok(!names.has('acknowledge_outage'), 'hand-written readwrite hidden at readonly tier');
  assert.ok(!names.has('bulk_acknowledge_outages'), 'hand-port readwrite hidden at readonly tier');
  assert.ok(names.has('investigate_server'), 'hand-port readonly present');
});

test('buildToolDefinitions(readwrite) includes hand-written + hand-port writes but not all codegen', () => {
  const tools = buildToolDefinitions('readwrite');
  const names = new Set(tools.map((t) => t.name));
  assert.ok(names.has('acknowledge_outage'));
  assert.ok(names.has('bulk_acknowledge_outages'));
  // Codegen readwrite tools (e.g., create_server from servers.js) appear
  // at readwrite tier too.
  assert.ok(names.has('create_server'), 'codegen readwrite present at readwrite tier');
  // No tool from a hypothetical 'all'-only tier; codegen emits readonly/readwrite only.
});

test('buildToolDefinitions(all) includes the full catalog with no name collisions', () => {
  const tools = buildToolDefinitions('all');
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, `expected unique names, got dupes`);
  // Hand-written list_servers wins over codegen list_servers.
  const listServers = tools.filter((t) => t.name === 'list_servers');
  assert.equal(listServers.length, 1);
  // The hand-written description starts with "List servers in the FortiMonitor account"
  // and the codegen one is the OpenAPI summary "List servers". Confirm hand-written wins.
  assert.match(listServers[0].description, /paginated/);
});

test('buildToolDefinitions tools have no _spec / _handler / tier leaked to API shape', () => {
  const tools = buildToolDefinitions('all');
  for (const t of tools) {
    assert.ok(!('_spec' in t), `${t.name} leaks _spec`);
    assert.ok(!('_handler' in t), `${t.name} leaks _handler`);
    assert.ok(!('tier' in t), `${t.name} leaks tier`);
    assert.ok(t.input_schema, `${t.name} missing input_schema`);
  }
});

test('buildToolDefinitions readonly < readwrite < all (monotonic catalog growth)', () => {
  const ro = buildToolDefinitions('readonly').length;
  const rw = buildToolDefinitions('readwrite').length;
  const all = buildToolDefinitions('all').length;
  assert.ok(ro < rw, `readonly (${ro}) should be < readwrite (${rw})`);
  assert.ok(rw <= all, `readwrite (${rw}) should be <= all (${all})`);
});

test('buildToolHandlers exposes a handler for every tool in buildToolDefinitions(all)', () => {
  const stubClient = makeStubClient();
  const handlers = buildToolHandlers(stubClient);
  const tools = buildToolDefinitions('all');
  for (const t of tools) {
    assert.ok(typeof handlers[t.name] === 'function', `missing handler for ${t.name}`);
  }
});

test('buildToolHandlers gives hand-written priority over codegen on shared names', async () => {
  const stubClient = makeStubClient({
    listServers: async () => ({
      server_list: [{ id: 1, name: 'a', status: 'active', extra_field: 'should_be_dropped' }],
      meta: { total_count: 1 }
    })
  });
  const handlers = buildToolHandlers(stubClient);
  const result = await handlers.list_servers({ limit: 10, offset: 0 });
  // Hand-written list_servers returns { total, offset, limit, servers }.
  // The codegen one would return the raw body. Confirm hand-written shape.
  assert.ok(result.servers, 'hand-written returns shaped { servers } object');
  assert.equal(result.servers[0].name, 'a');
  assert.ok(!('extra_field' in result.servers[0]), 'hand-written drops noise fields');
});

test('codegen catalog count + hand-port count are unchanged by tier filter (no double-emit)', () => {
  // Sanity: codegen has 262, hand-port has 5+5=10, hand-written has 11.
  // Confirm catalog cardinalities are stable so future drift is visible.
  assert.equal(ALL_CODEGEN_TOOLS.length, 262);
  assert.equal(BULK_OPS_TOOLS.length, 5);
  assert.equal(COMPOSITE_TOOLS.length, 5);
});

// ---------- FMN-120: per-provider catalog filter ----------

test('buildToolDefinitions(readonly, ollama) excludes codegen tools', () => {
  const tools = buildToolDefinitions('readonly', { provider: 'ollama' });
  const names = new Set(tools.map((t) => t.name));
  // Handwritten readonly is present.
  assert.ok(names.has('search_servers'));
  assert.ok(names.has('list_active_outages'));
  // Codegen readonly is gone. list_server_outages is the codegen tool
  // that was shadowing list_active_outages on small local models.
  assert.ok(!names.has('list_server_outages'),
    'codegen list_server_outages must not appear for local providers');
  // No write codegen either.
  assert.ok(!names.has('create_server'));
});

test('buildToolDefinitions(readonly, lmstudio) also excludes codegen', () => {
  const tools = buildToolDefinitions('readonly', { provider: 'lmstudio' });
  const names = new Set(tools.map((t) => t.name));
  assert.ok(!names.has('list_server_outages'));
  assert.ok(!names.has('create_server'));
});

test('buildToolDefinitions(readonly, anthropic) keeps codegen tools', () => {
  const tools = buildToolDefinitions('readonly', { provider: 'anthropic' });
  const names = new Set(tools.map((t) => t.name));
  // Codegen readonly tools should still be present for the cloud provider.
  assert.ok(names.has('list_server_outages'),
    'cloud provider gets the full codegen catalog');
});

test('buildToolDefinitions defaults to anthropic when provider omitted (regression)', () => {
  const withDefault = buildToolDefinitions('readonly').length;
  const withAnthropic = buildToolDefinitions('readonly', { provider: 'anthropic' }).length;
  assert.equal(withDefault, withAnthropic);
});

test('local provider catalog is meaningfully smaller than cloud catalog', () => {
  const local = buildToolDefinitions('readonly', { provider: 'ollama' }).length;
  const cloud = buildToolDefinitions('readonly', { provider: 'anthropic' }).length;
  assert.ok(local < cloud / 2,
    `local catalog (${local}) should be much smaller than cloud (${cloud}); ratio is what makes small models reliable`);
});

test('local provider catalog at "all" tier equals readwrite (no codegen growth)', () => {
  const localAll = buildToolDefinitions('all', { provider: 'ollama' }).length;
  const localRw = buildToolDefinitions('readwrite', { provider: 'ollama' }).length;
  assert.equal(localAll, localRw,
    'for local providers, "all" tier collapses to readwrite since codegen is filtered out');
});

function makeStubClient(overrides = {}) {
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
