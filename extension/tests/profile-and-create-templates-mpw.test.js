import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commit as pactCommit, _internals } from '../src/lib/bulk-actions/profile-and-create-templates.js';

// =====================================================================
// FMN-228: optional MPW-authoring step in Profile + Create Templates
// =====================================================================

const { buildMpwName, buildClausesFromCluster } = _internals;

const NOUN_OPTIONS = {
  device_types: [
    { label: 'FortiGate', value: '[sub_type]fortinet.fortigate' },
    { label: 'FortiSwitch', value: '[sub_type]fortinet.fortiswitch' }
  ],
  attribute_types: [
    { label: 'FortiGate', options: [{ label: 'Model', value: 'attribute,fortigate.model' }] }
  ]
};

const CLUSTER = {
  key: 'cluster-fg-vm64',
  make: 'FortiGate',
  model: 'FGVM64-AWS',
  applies_to_server_ids: [100, 101],
  proposed_template_name: 'FortiGate FGVM64 Edge',
  proposed_resources: [],
  sample_device_id: 100,
  opted_in: true,
  clone_from_device: true
};

const ENSURE_RESULT = {
  templateId: 9999,
  name: 'FortiGate FGVM64 Edge',
  created: true,
  reused: false,
  populated_count: 4
};

// ---------- helpers ----------

test('buildMpwName uses the Toolkit prefix + template + make + model', () => {
  const name = buildMpwName(CLUSTER, ENSURE_RESULT);
  assert.equal(name, 'Toolkit: auto-attach FortiGate FGVM64 Edge to FortiGate FGVM64-AWS');
});

test('buildClausesFromCluster emits device_type + attribute clauses when vocab matches', () => {
  const clauses = buildClausesFromCluster(CLUSTER, NOUN_OPTIONS);
  assert.equal(clauses.length, 2);
  assert.equal(clauses[0].datatype, 'device_type');
  assert.equal(clauses[0].match_value, '[sub_type]fortinet.fortigate');
  assert.equal(clauses[1].datatype, 'attribute');
  assert.equal(clauses[1].match_key, 'fortigate.model');
  assert.equal(clauses[1].match_value, 'FGVM64-AWS');
});

test('buildClausesFromCluster returns empty array when make is missing', () => {
  const clauses = buildClausesFromCluster({ ...CLUSTER, make: '' }, NOUN_OPTIONS);
  assert.deepEqual(clauses, []);
});

test('buildClausesFromCluster omits model clause when no .model textkey is present', () => {
  const clauses = buildClausesFromCluster(
    { ...CLUSTER, make: 'FortiSwitch', model: 'FS-148F' },
    NOUN_OPTIONS
  );
  // Only the device_type clause should land
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0].datatype, 'device_type');
});

// ---------- commit integration ----------

function makeContext({
  ensureTemplateOverride,
  rulesets = [],
  recordPolicyCreate
} = {}) {
  const created = [];
  const updated = [];
  const ctx = {
    client: {
      // Not used in dry-run commits; stubbed for completeness if attach
      // path is reached (not in these tests since we mark dry_run=true).
      async listServerTemplateMappings() { return []; },
      async attachTemplate() { return { status: 201, resourceId: 'x' }; }
    },
    fortimonitorClient: {
      async getMonitoringPolicyPageData() {
        return { rulesets, nounOptions: NOUN_OPTIONS };
      },
      async createMonitoringPolicy({ name }) {
        const policy = { id: 5000 + created.length, name };
        created.push(policy);
        recordPolicyCreate?.(policy);
        return policy;
      },
      async updateMonitoringPolicyConfig(rulesetId, config) {
        updated.push({ rulesetId, config });
        return { success: true };
      }
    },
    sharedState: new Map()
  };
  ctx._created = created;
  ctx._updated = updated;
  return ctx;
}

const PARAMS_BASE = {
  destination_group: 'grp-617598',
  destination_group_create_name: null,
  template_type: 'fabric_template',
  clusters: [CLUSTER]
};

test('commit dry-run with create_mpws=true reports would_create when no matching ruleset exists', async () => {
  const ctx = makeContext({ rulesets: [] });
  // Force ensureForCluster to return a known result by pre-populating sharedState
  ctx.sharedState.set(`template:dry:${CLUSTER.key}`, Promise.resolve({
    ...ENSURE_RESULT,
    would_create: true,
    would_populate_count: ENSURE_RESULT.populated_count
  }));
  // Pre-populate destination-group resolution too
  ctx.sharedState.set('destgroup:resolved:grp-617598', Promise.resolve('grp-617598'));
  const out = await pactCommit(
    { id: 100, name: 's100' },
    { ...PARAMS_BASE, dry_run: true, create_mpws: true },
    ctx
  );
  assert.equal(out.dry_run, true);
  assert.ok(out.mpw);
  assert.equal(out.mpw.would_create, true);
  assert.equal(out.mpw.created, false);
  assert.equal(out.mpw.name, 'Toolkit: auto-attach FortiGate FGVM64 Edge to FortiGate FGVM64-AWS');
  assert.equal(ctx._created.length, 0);
});

test('commit dry-run with create_mpws=true reports would_skip when a ruleset already exists with the same name', async () => {
  const ctx = makeContext({
    rulesets: [{ id: 42, name: 'Toolkit: auto-attach FortiGate FGVM64 Edge to FortiGate FGVM64-AWS' }]
  });
  ctx.sharedState.set(`template:dry:${CLUSTER.key}`, Promise.resolve({ ...ENSURE_RESULT, would_create: true }));
  ctx.sharedState.set('destgroup:resolved:grp-617598', Promise.resolve('grp-617598'));
  const out = await pactCommit(
    { id: 100, name: 's100' },
    { ...PARAMS_BASE, dry_run: true, create_mpws: true },
    ctx
  );
  assert.equal(out.mpw.would_create, false);
  assert.equal(out.mpw.reused, true);
  assert.equal(out.mpw.id, 42);
});

test('commit dry-run with create_mpws=false does not fetch rulesets or fire MPW logic', async () => {
  let policyPageDataCalls = 0;
  const ctx = makeContext({ rulesets: [] });
  ctx.fortimonitorClient.getMonitoringPolicyPageData = async () => {
    policyPageDataCalls++;
    return { rulesets: [], nounOptions: NOUN_OPTIONS };
  };
  ctx.sharedState.set(`template:dry:${CLUSTER.key}`, Promise.resolve({ ...ENSURE_RESULT, would_create: true }));
  ctx.sharedState.set('destgroup:resolved:grp-617598', Promise.resolve('grp-617598'));
  const out = await pactCommit(
    { id: 100, name: 's100' },
    { ...PARAMS_BASE, dry_run: true, create_mpws: false },
    ctx
  );
  assert.equal(out.mpw, null);
  assert.equal(policyPageDataCalls, 0);
});

test('memoization: two concurrent commits for the same cluster create only one MPW', async () => {
  const ctx = makeContext({ rulesets: [] });
  ctx.sharedState.set(`template:${CLUSTER.key}`, Promise.resolve(ENSURE_RESULT));
  ctx.sharedState.set('destgroup:resolved:grp-617598', Promise.resolve('grp-617598'));
  const results = await Promise.all([
    pactCommit({ id: 100, name: 's100' }, { ...PARAMS_BASE, dry_run: false, create_mpws: true }, ctx),
    pactCommit({ id: 101, name: 's101' }, { ...PARAMS_BASE, dry_run: false, create_mpws: true }, ctx)
  ]);
  // Each row reports the MPW result
  for (const r of results) {
    assert.equal(r.mpw.created, true);
    assert.equal(r.mpw.name, 'Toolkit: auto-attach FortiGate FGVM64 Edge to FortiGate FGVM64-AWS');
  }
  // But only one create + one update fired
  assert.equal(ctx._created.length, 1);
  assert.equal(ctx._updated.length, 1);
});

test('commit live with create_mpws=true skips POST when a same-named ruleset already exists', async () => {
  const existing = { id: 77, name: 'Toolkit: auto-attach FortiGate FGVM64 Edge to FortiGate FGVM64-AWS' };
  const ctx = makeContext({ rulesets: [existing] });
  ctx.sharedState.set(`template:${CLUSTER.key}`, Promise.resolve(ENSURE_RESULT));
  ctx.sharedState.set('destgroup:resolved:grp-617598', Promise.resolve('grp-617598'));
  const out = await pactCommit(
    { id: 100, name: 's100' },
    { ...PARAMS_BASE, dry_run: false, create_mpws: true },
    ctx
  );
  assert.equal(out.mpw.created, false);
  assert.equal(out.mpw.reused, true);
  assert.equal(out.mpw.id, 77);
  assert.equal(ctx._created.length, 0);
  assert.equal(ctx._updated.length, 0);
});
