import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFabricProfile, profileKey } from '../src/lib/fabric-profile.js';
import { buildRecommendations } from '../src/lib/recommendation-engine.js';

// =====================================================================
// Fixtures
// =====================================================================
//
// Live nounOptions excerpted from the FMN-194 capture, with the
// FortiGate device_type entry and the FortiGate attribute group (which
// includes fortigate.model). Sufficient to exercise the engine's
// vocabulary-driven policy-clause construction without dragging in the
// full ~40 KB capture.

const NOUN_OPTIONS = {
  device_types: [
    { label: 'FortiGate', value: '[sub_type]fortinet.fortigate' },
    { label: 'Kubernetes', value: 'kubernetes' },
    { label: 'Server', value: 'server' }
  ],
  attribute_types: [
    {
      label: 'FortiGate',
      options: [
        { label: 'Admin Port', value: 'attribute,fortigate.admin_port' },
        { label: 'Model', value: 'attribute,fortigate.model' },
        { label: 'Firmware', value: 'attribute,fortigate.os_version' }
      ]
    },
    {
      label: 'Server Configuration',
      options: [
        { label: 'OS', value: 'attribute,server.os' }
      ]
    }
  ]
};

function makeProfile(servers, fsd) {
  return buildFabricProfile(servers, fsd);
}

// =====================================================================
// Template matching priority
// =====================================================================

test('prefers existing tenant template by model SKU', () => {
  const profile = makeProfile([{ id: 1 }], { 1: { model_name: 'FortiGate', model_number: 'FGVMA6' } });
  const out = buildRecommendations(profile, {
    existingTemplates: [
      { id: 100, name: 'FortiGate Default' },
      { id: 101, name: 'FortiGate FGVMA6 Fabric' }
    ],
    stockTemplates: [],
    nounOptions: NOUN_OPTIONS
  });
  assert.equal(out.recommendations.length, 1);
  const r = out.recommendations[0];
  assert.equal(r.chosen_template.id, 101);
  assert.equal(r.chosen_template.source, 'existing-model-specific');
  assert.equal(r.status, 'matched');
});

test('falls back to existing family template if no model match', () => {
  const profile = makeProfile([{ id: 1 }], { 1: { model_name: 'FortiGate', model_number: 'FGVMA6' } });
  const out = buildRecommendations(profile, {
    existingTemplates: [{ id: 100, name: 'FortiGate Default' }],
    stockTemplates: [],
    nounOptions: NOUN_OPTIONS
  });
  assert.equal(out.recommendations[0].chosen_template.id, 100);
  assert.equal(out.recommendations[0].chosen_template.source, 'existing-family');
});

test('falls back to stock model-specific before stock family', () => {
  const profile = makeProfile([{ id: 1 }], { 1: { model_name: 'FortiGate', model_number: 'FGVMA6' } });
  const out = buildRecommendations(profile, {
    existingTemplates: [],
    stockTemplates: [
      { id: 900, name: 'FortiGate' },
      { id: 901, name: 'FortiGate FGVMA6' }
    ],
    nounOptions: NOUN_OPTIONS
  });
  assert.equal(out.recommendations[0].chosen_template.id, 901);
  assert.equal(out.recommendations[0].chosen_template.source, 'stock-model-specific');
});

test('falls back to stock family if no model match anywhere', () => {
  const profile = makeProfile([{ id: 1 }], { 1: { model_name: 'FortiGate', model_number: 'FGVMA6' } });
  const out = buildRecommendations(profile, {
    existingTemplates: [],
    stockTemplates: [{ id: 900, name: 'FortiGate' }],
    nounOptions: NOUN_OPTIONS
  });
  assert.equal(out.recommendations[0].chosen_template.id, 900);
  assert.equal(out.recommendations[0].chosen_template.source, 'stock-family');
});

test('emits no-template-found when nothing matches', () => {
  const profile = makeProfile([{ id: 1 }], { 1: { model_name: 'FortiCustom', model_number: 'XYZ-1' } });
  const out = buildRecommendations(profile, {
    existingTemplates: [{ id: 100, name: 'FortiGate' }],
    stockTemplates: [{ id: 900, name: 'FortiSwitch' }],
    nounOptions: NOUN_OPTIONS
  });
  assert.equal(out.recommendations[0].chosen_template, null);
  assert.equal(out.recommendations[0].status, 'no-template-found');
});

test('partitions a single templates list by server_group_name', () => {
  const profile = makeProfile([{ id: 1 }], { 1: { model_name: 'FortiGate', model_number: 'FGVMA6' } });
  const out = buildRecommendations(profile, {
    existingTemplates: [
      { id: 100, name: 'FortiGate Default', server_group_name: 'Production' },
      { id: 900, name: 'FortiGate FGVMA6 Stock', server_group_name: 'Default Monitoring Templates' }
    ],
    nounOptions: NOUN_OPTIONS
  });
  // The existing-family match (id 100) wins over the stock-model-specific
  // (id 900) because existing has higher priority than stock at any
  // specificity step. Customer templates are always preferred.
  assert.equal(out.recommendations[0].chosen_template.id, 100);
  assert.equal(out.recommendations[0].chosen_template.source, 'existing-family');
});

// =====================================================================
// Policy proposal construction (from live nounOptions)
// =====================================================================

test('builds a device_type-only predicate (model clause omitted without live sample_attrs)', () => {
  // FMN-228 QA finding (2026-05-21): pickModelClause now requires
  // sampleAttrs to emit the attribute clause; without them the model
  // clause is omitted (otherwise the toolkit produced an attribute
  // clause whose match_value never matched any device's
  // fortigate.model attribute). buildRecommendations doesn't fetch
  // sample attrs today - the apply-stock-fabric-templates commit
  // path is expected to patch the clauses with live values before
  // POSTing. For now, the proposal carries the family clause only.
  const profile = makeProfile([{ id: 1 }], { 1: { model_name: 'FortiGate', model_number: 'FGVMA6' } });
  const out = buildRecommendations(profile, {
    existingTemplates: [{ id: 100, name: 'FortiGate' }],
    stockTemplates: [],
    nounOptions: NOUN_OPTIONS
  });
  const p = out.recommendations[0].policy_proposal;
  assert.equal(p.name, 'Apply Stock FortiGate template');
  assert.equal(p.clauses.length, 1);
  assert.equal(p.clauses[0].datatype, 'device_type');
  assert.equal(p.clauses[0].match_type, 'pick_multiple');
  // pick_multiple match_value is a JSON array (captured live).
  assert.deepEqual(p.clauses[0].match_value, ['[sub_type]fortinet.fortigate']);
});

test('warns when device_types vocabulary lacks the family', () => {
  const profile = makeProfile([{ id: 1 }], { 1: { model_name: 'FortiSwitch', model_number: 'FS-148F' } });
  const limited = {
    device_types: [{ label: 'FortiGate', value: '[sub_type]fortinet.fortigate' }],
    attribute_types: [
      { label: 'FortiSwitch', options: [{ label: 'Model', value: 'attribute,fortiswitch.model' }] }
    ]
  };
  const out = buildRecommendations(profile, {
    existingTemplates: [{ id: 100, name: 'FortiSwitch' }],
    stockTemplates: [],
    nounOptions: limited
  });
  const p = out.recommendations[0].policy_proposal;
  // Family clause omitted (no FortiSwitch in device_types vocab) AND
  // model clause omitted (no sampleAttrs supplied) -> empty clauses,
  // warnings carries the device_types miss.
  assert.equal(p.clauses.length, 0);
  assert.equal(p.warnings.length, 2);
  assert.match(p.warnings[0], /device_types/);
});

test('warns when attribute_types vocabulary lacks the family model textkey', () => {
  const profile = makeProfile([{ id: 1 }], { 1: { model_name: 'FortiGate', model_number: 'FGVMA6' } });
  const limited = {
    device_types: [{ label: 'FortiGate', value: '[sub_type]fortinet.fortigate' }],
    attribute_types: []
  };
  const out = buildRecommendations(profile, {
    existingTemplates: [{ id: 100, name: 'FortiGate' }],
    stockTemplates: [],
    nounOptions: limited
  });
  const p = out.recommendations[0].policy_proposal;
  assert.equal(p.clauses.length, 1);
  assert.equal(p.clauses[0].datatype, 'device_type');
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /attribute_types/);
});

test('still emits a proposal (with warnings) when nounOptions is empty', () => {
  const profile = makeProfile([{ id: 1 }], { 1: { model_name: 'FortiGate', model_number: 'FGVMA6' } });
  const out = buildRecommendations(profile, {
    existingTemplates: [{ id: 100, name: 'FortiGate' }],
    stockTemplates: [],
    nounOptions: {}
  });
  const p = out.recommendations[0].policy_proposal;
  assert.equal(p.clauses.length, 0);
  assert.equal(p.warnings.length, 2);
});

// =====================================================================
// Engine edge cases
// =====================================================================

test('returns empty output for an empty profile', () => {
  const out = buildRecommendations({ profiles: new Map() }, {
    existingTemplates: [],
    stockTemplates: [],
    nounOptions: NOUN_OPTIONS
  });
  assert.deepEqual(out.recommendations, []);
});

test('returns empty output for a malformed profile', () => {
  const out = buildRecommendations({}, {});
  assert.deepEqual(out.recommendations, []);
});

test('emits one recommendation per profile entry, preserving server_ids and os_versions', () => {
  const profile = makeProfile(
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    {
      1: { model_name: 'FortiGate', model_number: 'FGVMA6', os_version: 'v7.6.3' },
      2: { model_name: 'FortiGate', model_number: 'FGVMA6', os_version: 'v7.6.3' },
      3: { model_name: 'FortiSwitch', model_number: 'FS-148F', os_version: 'v7.4.0' }
    }
  );
  const out = buildRecommendations(profile, {
    existingTemplates: [
      { id: 101, name: 'FortiGate' },
      { id: 102, name: 'FortiSwitch' }
    ],
    stockTemplates: [],
    nounOptions: NOUN_OPTIONS
  });
  assert.equal(out.recommendations.length, 2);
  const fg = out.recommendations.find((r) => r.make === 'FortiGate');
  const fs = out.recommendations.find((r) => r.make === 'FortiSwitch');
  assert.deepEqual(fg.applies_to_server_ids, [1, 2]);
  assert.deepEqual(fg.os_versions, ['v7.6.3']);
  assert.deepEqual(fs.applies_to_server_ids, [3]);
});

test('caller mutations of the recommendation do not affect re-runs', () => {
  const profile = makeProfile([{ id: 1 }], { 1: { model_name: 'FortiGate', model_number: 'FGVMA6' } });
  const inputs = {
    existingTemplates: [{ id: 100, name: 'FortiGate' }],
    stockTemplates: [],
    nounOptions: NOUN_OPTIONS
  };
  const out1 = buildRecommendations(profile, inputs);
  out1.recommendations[0].applies_to_server_ids.push(999);
  out1.recommendations[0].policy_proposal.clauses.push({ datatype: 'INJECTED' });

  const out2 = buildRecommendations(profile, inputs);
  assert.deepEqual(out2.recommendations[0].applies_to_server_ids, [1]);
  // FMN-228 QA: model clause now omitted without live sampleAttrs;
  // proposal carries only the family clause.
  assert.equal(out2.recommendations[0].policy_proposal.clauses.length, 1);
});
