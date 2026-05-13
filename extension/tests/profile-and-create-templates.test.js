import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as action from '../src/lib/bulk-actions/profile-and-create-templates.js';
import { getAction, listActions } from '../src/lib/bulk-actions/index.js';

// =====================================================================
// Registration
// =====================================================================

test('action is registered in the bulk-actions registry', () => {
  const ids = listActions().map((a) => a.id);
  assert.ok(ids.includes('profile-and-create-templates'));
  assert.equal(getAction('profile-and-create-templates').id, 'profile-and-create-templates');
});

// =====================================================================
// validate
// =====================================================================

const CLUSTER = {
  key: 'FortiGate::FGVMA6::r=cpu,memory::t=abc::p=none',
  make: 'FortiGate',
  model: 'FGVMA6',
  applies_to_server_ids: [42024061, 42024062],
  proposed_template_name: 'FortiGate FGVMA6 Best Practice',
  proposed_resources: [
    { plugin_textkey: 'fortinet.fortigate', resource_textkey: 'cpu', name: 'CPU' },
    { plugin_textkey: 'fortinet.fortigate', resource_textkey: 'memory', name: 'Memory' }
  ],
  sample_device_id: 42024061,
  opted_in: true
};

test('validate accepts well-formed params', () => {
  const v = action.validate({
    destination_group: 'grp-617598',
    clusters: [CLUSTER]
  });
  assert.equal(v.ok, true);
  assert.equal(v.value.template_type, 'fabric_template');
  assert.equal(v.value.dry_run, false);
});

test('validate rejects when destination_group missing', () => {
  const v = action.validate({ clusters: [CLUSTER] });
  assert.equal(v.ok, false);
  assert.match(v.error, /destination_group/);
});

test('validate rejects when no clusters opted in', () => {
  const v = action.validate({
    destination_group: 'grp-1',
    clusters: [{ ...CLUSTER, opted_in: false }]
  });
  assert.equal(v.ok, false);
  assert.match(v.error, /opted in/i);
});

test('validate rejects cluster with no target server ids', () => {
  const v = action.validate({
    destination_group: 'grp-1',
    clusters: [{ ...CLUSTER, applies_to_server_ids: [] }]
  });
  assert.equal(v.ok, false);
});

test('validate rejects cluster with no proposed_template_name', () => {
  const v = action.validate({
    destination_group: 'grp-1',
    clusters: [{ ...CLUSTER, proposed_template_name: '' }]
  });
  assert.equal(v.ok, false);
});

// =====================================================================
// describe
// =====================================================================

test('describe surfaces planned template attach for matched target', () => {
  const out = action.describe({ id: 42024061, template_names: [] }, {
    destination_group: 'grp-1',
    clusters: [CLUSTER]
  });
  assert.equal(out.willChange, true);
  assert.match(out.next, /FortiGate FGVMA6 Best Practice/);
});

test('describe marks already-attached template as no-op', () => {
  const out = action.describe(
    { id: 42024061, template_names: ['FortiGate FGVMA6 Best Practice'] },
    { destination_group: 'grp-1', clusters: [CLUSTER] }
  );
  assert.equal(out.willChange, false);
  assert.match(out.note, /already attached/i);
});

test('describe skips unmatched targets', () => {
  const out = action.describe({ id: 9999999, template_names: [] }, {
    destination_group: 'grp-1',
    clusters: [CLUSTER]
  });
  assert.equal(out.willChange, false);
  assert.match(out.next, /skipped/i);
});

// =====================================================================
// commit
// =====================================================================

function makeClients({ existingTemplates = [], createdTemplate = null, existingMappings = [] } = {}) {
  const createCalls = [];
  const metricCalls = [];
  const attachCalls = [];
  const panopta = {
    baseUrl: 'https://api2.panopta.com/v2',
    async listTemplates() {
      return createCalls.length > 0 && createdTemplate
        ? existingTemplates.concat([createdTemplate])
        : existingTemplates;
    },
    async listServerTemplateMappings(serverId) {
      return existingMappings.filter((m) => m.serverId === serverId);
    },
    async attachTemplate(serverId, opts) {
      attachCalls.push({ serverId, opts });
      return { status: 201, resourceId: 1000 + serverId };
    }
  };
  const fortimonitor = {
    async createServerTemplate(opts) { createCalls.push(opts); return { success: true }; },
    async addTemplateMetric(opts) { metricCalls.push(opts); return { success: true }; }
  };
  return { panopta, fortimonitor, createCalls, metricCalls, attachCalls };
}

test('commit creates template + populates + attaches on first target', async () => {
  const { panopta, fortimonitor, createCalls, metricCalls, attachCalls } = makeClients({
    createdTemplate: { id: 44017900, name: 'FortiGate FGVMA6 Best Practice' }
  });
  const sharedState = new Map();
  const out = await action.commit(
    { id: 42024061, template_names: [] },
    { destination_group: 'grp-1', clusters: [CLUSTER] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(out.noop, false);
  assert.equal(out.template.created, true);
  assert.equal(out.template.id, 44017900);
  assert.equal(out.template.populated_count, 2);
  assert.equal(createCalls.length, 1);
  assert.equal(metricCalls.length, 2);
  assert.equal(attachCalls.length, 1);
});

test('commit on a second target for the same cluster reuses the cached ensure (no second create)', async () => {
  const { panopta, fortimonitor, createCalls, metricCalls, attachCalls } = makeClients({
    createdTemplate: { id: 44017900, name: 'FortiGate FGVMA6 Best Practice' }
  });
  const sharedState = new Map();
  await action.commit({ id: 42024061, template_names: [] }, { destination_group: 'grp-1', clusters: [CLUSTER] }, { client: panopta, fortimonitorClient: fortimonitor, sharedState });
  const out2 = await action.commit({ id: 42024062, template_names: [] }, { destination_group: 'grp-1', clusters: [CLUSTER] }, { client: panopta, fortimonitorClient: fortimonitor, sharedState });
  assert.equal(createCalls.length, 1, 'template created once');
  assert.equal(metricCalls.length, 2, 'metrics added once');
  assert.equal(attachCalls.length, 2, 'attached to both targets');
  assert.equal(out2.template.created, false, 'second target sees template already created');
});

test('commit reuses existing template by name (no create, no populate)', async () => {
  const { panopta, fortimonitor, createCalls, metricCalls, attachCalls } = makeClients({
    existingTemplates: [{ id: 555, name: 'FortiGate FGVMA6 Best Practice' }]
  });
  const sharedState = new Map();
  const out = await action.commit(
    { id: 42024061, template_names: [] },
    { destination_group: 'grp-1', clusters: [CLUSTER] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(out.template.reused, true);
  assert.equal(out.template.id, 555);
  assert.equal(createCalls.length, 0);
  assert.equal(metricCalls.length, 0);
  assert.equal(attachCalls.length, 1);
});

test('commit returns template-already-attached when mapping exists', async () => {
  const { panopta, fortimonitor, attachCalls } = makeClients({
    existingTemplates: [{ id: 555, name: 'FortiGate FGVMA6 Best Practice' }],
    existingMappings: [{ serverId: 42024061, templateId: 555, templateUrl: 'https://api2.panopta.com/v2/server_template/555' }]
  });
  const sharedState = new Map();
  const out = await action.commit(
    { id: 42024061, template_names: ['FortiGate FGVMA6 Best Practice'] },
    { destination_group: 'grp-1', clusters: [CLUSTER] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(out.reason, 'template-already-attached');
  assert.equal(attachCalls.length, 0);
});

test('commit noops a target not covered by any opted-in cluster', async () => {
  const { panopta, fortimonitor, createCalls, attachCalls } = makeClients();
  const sharedState = new Map();
  const out = await action.commit(
    { id: 99999999, template_names: [] },
    { destination_group: 'grp-1', clusters: [CLUSTER] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'no-matching-cluster');
  assert.equal(createCalls.length, 0);
  assert.equal(attachCalls.length, 0);
});

// =====================================================================
// Dry-run
// =====================================================================

test('dry-run commit makes ZERO writes (no create, no populate, no attach)', async () => {
  const { panopta, fortimonitor, createCalls, metricCalls, attachCalls } = makeClients();
  const sharedState = new Map();
  const out = await action.commit(
    { id: 42024061, template_names: [] },
    { dry_run: true, destination_group: 'grp-1', clusters: [CLUSTER] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(out.dry_run, true);
  assert.equal(out.reason, 'dry-run');
  assert.equal(out.template.would_create, true);
  assert.equal(out.template.would_populate_count, 2);
  assert.equal(out.template.would_attach, true);
  assert.equal(createCalls.length, 0);
  assert.equal(metricCalls.length, 0);
  assert.equal(attachCalls.length, 0);
});

test('dry-run reports would_create=false when template already exists', async () => {
  const { panopta, fortimonitor, createCalls } = makeClients({
    existingTemplates: [{ id: 555, name: 'FortiGate FGVMA6 Best Practice' }]
  });
  const sharedState = new Map();
  const out = await action.commit(
    { id: 42024061, template_names: [] },
    { dry_run: true, destination_group: 'grp-1', clusters: [CLUSTER] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(out.dry_run, true);
  assert.equal(out.template.would_create, false);
  assert.equal(createCalls.length, 0);
});

// =====================================================================
// Clone-from-device path
// =====================================================================

test('clone-from-device: commit passes sourceServerId + skips per-metric populate', async () => {
  const cloneCluster = { ...CLUSTER, clone_from_device: true };
  const { panopta, fortimonitor, createCalls, metricCalls } = makeClients({
    createdTemplate: { id: 44017900, name: 'FortiGate FGVMA6 Best Practice' }
  });
  const sharedState = new Map();
  await action.commit(
    { id: 42024061, template_names: [] },
    { destination_group: 'grp-1', clusters: [cloneCluster] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].sourceServerId, 42024061);
  assert.equal(metricCalls.length, 0, 'clone path skips per-metric add');
});

// =====================================================================
// Ctx validation
// =====================================================================

test('commit requires sharedState Map', async () => {
  const { panopta, fortimonitor } = makeClients();
  await assert.rejects(
    action.commit({ id: 1 }, { destination_group: 'grp-1', clusters: [CLUSTER] }, { client: panopta, fortimonitorClient: fortimonitor }),
    /sharedState/
  );
});
