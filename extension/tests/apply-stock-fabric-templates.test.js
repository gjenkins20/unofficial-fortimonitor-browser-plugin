import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as action from '../src/lib/bulk-actions/apply-stock-fabric-templates.js';
import { getAction, listActions } from '../src/lib/bulk-actions/index.js';

// =====================================================================
// Registration
// =====================================================================

test('action is registered in the bulk-actions registry', () => {
  const ids = listActions().map((a) => a.id);
  assert.ok(ids.includes('apply-stock-fabric-templates'));
  assert.equal(getAction('apply-stock-fabric-templates').id, 'apply-stock-fabric-templates');
});

// =====================================================================
// validate
// =====================================================================

const VALID_REC = {
  profile_key: 'FortiGate::FGVMA6::Fabric',
  make: 'FortiGate',
  model: 'FGVMA6',
  connection_type: 'Fabric',
  applies_to_server_ids: [42024061, 42024062],
  chosen_template: { id: 101, name: 'FortiGate FGVMA6 Fabric' },
  policy_proposal: {
    name: 'Apply Stock FortiGate template',
    clauses: [
      { datatype: 'device_type', match_type: 'pick_one', match_key: null, match_value: '[sub_type]fortinet.fortigate' },
      { datatype: 'attribute', match_type: 'pick_one', match_key: 'fortigate.model', match_value: 'FGVMA6' }
    ],
    warnings: []
  },
  opted_in: true
};

test('validate accepts a well-formed opted-in recommendation', () => {
  const v = action.validate({ recommendations: [VALID_REC] });
  assert.equal(v.ok, true);
});

test('validate rejects when recommendations is not an array', () => {
  const v = action.validate({});
  assert.equal(v.ok, false);
  assert.match(v.error, /required/i);
});

test('validate rejects when no recommendation is opted in', () => {
  const v = action.validate({ recommendations: [{ ...VALID_REC, opted_in: false }] });
  assert.equal(v.ok, false);
  assert.match(v.error, /opted in/i);
});

test('validate rejects a recommendation missing chosen_template', () => {
  const r = { ...VALID_REC, chosen_template: null };
  const v = action.validate({ recommendations: [r] });
  assert.equal(v.ok, false);
  assert.match(v.error, /chosen template/i);
});

test('validate rejects a recommendation with empty applies_to_server_ids', () => {
  const r = { ...VALID_REC, applies_to_server_ids: [] };
  const v = action.validate({ recommendations: [r] });
  assert.equal(v.ok, false);
  assert.match(v.error, /target server ids/i);
});

// =====================================================================
// describe (pure preview)
// =====================================================================

test('describe surfaces planned template attachment for matched target', () => {
  const target = { id: 42024061, template_names: [] };
  const out = action.describe(target, { recommendations: [VALID_REC] });
  assert.equal(out.willChange, true);
  assert.match(out.next, /FortiGate FGVMA6 Fabric/);
});

test('describe marks already-attached template as no-op', () => {
  const target = { id: 42024061, template_names: ['FortiGate FGVMA6 Fabric'] };
  const out = action.describe(target, { recommendations: [VALID_REC] });
  assert.equal(out.willChange, false);
  assert.match(out.note, /already attached/i);
});

test('describe marks an unmatched target as skipped', () => {
  const target = { id: 9999999, template_names: [] };
  const out = action.describe(target, { recommendations: [VALID_REC] });
  assert.equal(out.willChange, false);
  assert.match(out.next, /skipped/i);
});

test('describe surfaces a validation error as the result.error field', () => {
  const out = action.describe({ id: 1 }, {});
  assert.ok(out.error);
});

// =====================================================================
// commit - end-to-end happy path
// =====================================================================

function makeMockClients({ existingMappings = [], existingRulesets = [], createdRulesetId = 8888 } = {}) {
  let attachCalls = [];
  let createCalls = [];
  let updateCalls = [];

  const panopta = {
    baseUrl: 'https://api2.panopta.com/v2',
    async listServerTemplateMappings(serverId) {
      return existingMappings.filter((m) => m.serverId === serverId);
    },
    async attachTemplate(serverId, opts) {
      attachCalls.push({ serverId, opts });
      return { status: 201, resourceId: 999 + serverId };
    }
  };

  const fortimonitor = {
    async getMonitoringPolicyPageData() {
      return { success: true, rulesets: existingRulesets, nounOptions: {} };
    },
    async createMonitoringPolicy(opts) {
      createCalls.push(opts);
      return { id: createdRulesetId, name: opts.name, latest_version: 0, config: { rules: [] } };
    },
    async updateMonitoringPolicyConfig(rulesetId, config) {
      updateCalls.push({ rulesetId, config });
      return { success: true, config, ruleset_id: rulesetId, version_id: 1 };
    }
  };

  return { panopta, fortimonitor, attachCalls, createCalls, updateCalls };
}

test('commit creates the policy + attaches the template on first target', async () => {
  const { panopta, fortimonitor, attachCalls, createCalls, updateCalls } = makeMockClients();
  const sharedState = new Map();
  const out = await action.commit(
    { id: 42024061, name: 'FGVM01TM24006845', template_names: [] },
    { recommendations: [VALID_REC] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(out.noop, false);
  assert.equal(out.policy.created, true);
  assert.equal(out.policy.name, 'Apply Stock FortiGate template');
  assert.equal(out.template.id, 101);
  assert.equal(createCalls.length, 1);
  assert.equal(updateCalls.length, 1);
  assert.equal(attachCalls.length, 1);
  // updateMonitoringPolicyConfig payload includes both clauses
  const cfg = updateCalls[0].config;
  assert.equal(cfg.rules[0].conditions[0].clauses.length, 2);
  assert.equal(cfg.rules[0].actions[0].action_value, '101');
});

test('commit on a second target for the same profile reuses the cached policy (no second create)', async () => {
  const { panopta, fortimonitor, attachCalls, createCalls } = makeMockClients();
  const sharedState = new Map();
  await action.commit({ id: 42024061, template_names: [] }, { recommendations: [VALID_REC] }, { client: panopta, fortimonitorClient: fortimonitor, sharedState });
  const out2 = await action.commit({ id: 42024062, template_names: [] }, { recommendations: [VALID_REC] }, { client: panopta, fortimonitorClient: fortimonitor, sharedState });
  assert.equal(createCalls.length, 1, 'policy created once');
  assert.equal(attachCalls.length, 2, 'template attached to both targets');
  assert.equal(out2.policy.created, false, 'second target sees policy already created');
});

test('commit skips policy creation when a ruleset with the same name already exists', async () => {
  const { panopta, fortimonitor, createCalls } = makeMockClients({
    existingRulesets: [{ id: 7777, name: 'Apply Stock FortiGate template', latest_version: 1, config: { rules: [] } }]
  });
  const sharedState = new Map();
  const out = await action.commit(
    { id: 42024061, template_names: [] },
    { recommendations: [VALID_REC] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(createCalls.length, 0, 'existing policy reused');
  assert.equal(out.policy.id, 7777);
  assert.equal(out.policy.created, false);
});

test('commit returns noop when template already attached', async () => {
  const { panopta, fortimonitor, attachCalls } = makeMockClients({
    existingMappings: [{ serverId: 42024061, templateId: 101, templateUrl: 'https://api2.panopta.com/v2/server_template/101' }]
  });
  const sharedState = new Map();
  const out = await action.commit(
    { id: 42024061, template_names: ['FortiGate FGVMA6 Fabric'] },
    { recommendations: [VALID_REC] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(out.noop, false, 'policy was created so the row counts as a change');
  // But template was NOT re-attached
  assert.equal(attachCalls.length, 0);
  assert.equal(out.reason, 'template-already-attached');
});

test('commit noops a target not covered by any opted-in recommendation', async () => {
  const { panopta, fortimonitor, attachCalls, createCalls } = makeMockClients();
  const sharedState = new Map();
  const out = await action.commit(
    { id: 9999999, template_names: [] },
    { recommendations: [VALID_REC] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'no-matching-recommendation');
  assert.equal(createCalls.length, 0);
  assert.equal(attachCalls.length, 0);
});

test('commit requires sharedState Map in ctx', async () => {
  const { panopta, fortimonitor } = makeMockClients();
  await assert.rejects(
    action.commit({ id: 1 }, { recommendations: [VALID_REC] }, { client: panopta, fortimonitorClient: fortimonitor }),
    /sharedState/
  );
});

test('commit rethrows validation errors as Error', async () => {
  const sharedState = new Map();
  await assert.rejects(
    action.commit({ id: 1 }, {}, { client: {}, fortimonitorClient: {}, sharedState }),
    /required|opted in/i
  );
});

// =====================================================================
// Dry-run
// =====================================================================

test('dry-run commit makes ZERO writes (no create, no update, no attach)', async () => {
  const { panopta, fortimonitor, attachCalls, createCalls, updateCalls } = makeMockClients();
  const sharedState = new Map();
  const out = await action.commit(
    { id: 42024061, template_names: [] },
    { dry_run: true, recommendations: [VALID_REC] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(out.dry_run, true);
  assert.equal(out.reason, 'dry-run');
  assert.equal(out.policy.would_create, true);
  assert.equal(out.policy.created, false);
  assert.equal(out.template.would_attach, true);
  assert.equal(createCalls.length, 0, 'no createMonitoringPolicy call');
  assert.equal(updateCalls.length, 0, 'no updateMonitoringPolicyConfig call');
  assert.equal(attachCalls.length, 0, 'no attachTemplate call');
});

test('dry-run reports would_create=false when policy already exists', async () => {
  const { panopta, fortimonitor, createCalls } = makeMockClients({
    existingRulesets: [{ id: 7777, name: 'Apply Stock FortiGate template', latest_version: 1, config: { rules: [] } }]
  });
  const sharedState = new Map();
  const out = await action.commit(
    { id: 42024061, template_names: [] },
    { dry_run: true, recommendations: [VALID_REC] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(out.dry_run, true);
  assert.equal(out.policy.would_create, false);
  assert.equal(out.policy.id, 7777);
  assert.equal(createCalls.length, 0);
});

test('dry-run reports template-already-attached without attach call', async () => {
  const { panopta, fortimonitor, attachCalls } = makeMockClients({
    existingMappings: [{ serverId: 42024061, templateId: 101, templateUrl: 'https://api2.panopta.com/v2/server_template/101' }]
  });
  const sharedState = new Map();
  const out = await action.commit(
    { id: 42024061, template_names: ['FortiGate FGVMA6 Fabric'] },
    { dry_run: true, recommendations: [VALID_REC] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(out.dry_run, true);
  assert.equal(out.reason, 'template-already-attached');
  assert.equal(attachCalls.length, 0);
});

test('dry-run describe surfaces a "Dry-run:" hint in the note', () => {
  const target = { id: 42024061, template_names: [] };
  const out = action.describe(target, { dry_run: true, recommendations: [VALID_REC] });
  assert.match(out.note, /Dry-run/);
});

test('non-dry-run commit still writes (regression-guard against dry-run leaking)', async () => {
  const { panopta, fortimonitor, attachCalls, createCalls } = makeMockClients();
  const sharedState = new Map();
  await action.commit(
    { id: 42024061, template_names: [] },
    { dry_run: false, recommendations: [VALID_REC] },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  assert.equal(createCalls.length, 1);
  assert.equal(attachCalls.length, 1);
});

test('dry-run caches policy state separately from live, so toggling dry-run within a run is safe', async () => {
  const { panopta, fortimonitor, createCalls } = makeMockClients();
  const sharedState = new Map();
  // First: dry-run on a target.
  await action.commit({ id: 42024061, template_names: [] }, { dry_run: true, recommendations: [VALID_REC] }, { client: panopta, fortimonitorClient: fortimonitor, sharedState });
  // Then: live on another target with the same recommendation.
  await action.commit({ id: 42024062, template_names: [] }, { dry_run: false, recommendations: [VALID_REC] }, { client: panopta, fortimonitorClient: fortimonitor, sharedState });
  // Live commit must actually create.
  assert.equal(createCalls.length, 1);
});

test('describes-noop-row-still-passes-validation: opted-out recommendations are filtered', async () => {
  const { panopta, fortimonitor, attachCalls, createCalls } = makeMockClients();
  const sharedState = new Map();
  const recs = [
    { ...VALID_REC, opted_in: false },
    { ...VALID_REC, opted_in: true }
  ];
  const out = await action.commit(
    { id: 42024061, template_names: [] },
    { recommendations: recs },
    { client: panopta, fortimonitorClient: fortimonitor, sharedState }
  );
  // The opted-in rec covers id 42024061; opted-out one is ignored.
  assert.equal(out.noop, false);
  assert.equal(createCalls.length, 1);
  assert.equal(attachCalls.length, 1);
});
