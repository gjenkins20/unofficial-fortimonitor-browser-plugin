import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  topLevelKeysForSections,
  needsOutageTrending,
  needsGroupDetails,
  needsTemplateDetails,
  needsDeepDive,
  needsFrontendUsers,
  needsFrontendTemplates,
  analyzerKeysForSections,
  SECTION_ANALYZER_KEY
} from '../src/lib/bpa-section-deps.js';

test('topLevelKeysForSections(["all"]) returns null (no filter)', () => {
  assert.equal(topLevelKeysForSections(['all']), null);
});

test('topLevelKeysForSections(undefined) returns null (no filter)', () => {
  assert.equal(topLevelKeysForSections(undefined), null);
});

test('topLevelKeysForSections(["user-activity"]) only includes /user', () => {
  const keys = topLevelKeysForSections(['user-activity']);
  assert.deepEqual([...keys], ['users']);
});

test('topLevelKeysForSections(["incidents"]) only includes /outage', () => {
  const keys = topLevelKeysForSections(['incidents']);
  assert.deepEqual([...keys], ['outages']);
});

test('topLevelKeysForSections(["template-recommendations","monitoring-policy"]) shares server_templates without dup', () => {
  const keys = topLevelKeysForSections(['template-recommendations', 'monitoring-policy']);
  assert.deepEqual([...keys].sort(), ['server_groups', 'server_templates', 'servers']);
});

test('topLevelKeysForSections(["instance-analysis"]) includes servers + agent_resource_types', () => {
  const keys = topLevelKeysForSections(['instance-analysis']);
  assert.deepEqual([...keys].sort(), ['agent_resource_types', 'servers']);
});

test('needsOutageTrending: only when incidents is selected', () => {
  assert.equal(needsOutageTrending(['all']), true);
  assert.equal(needsOutageTrending(['incidents']), true);
  assert.equal(needsOutageTrending(['user-activity']), false);
  assert.equal(needsOutageTrending(['user-activity', 'incidents']), true);
});

test('needsGroupDetails: when templates or monitoring-policy is selected', () => {
  assert.equal(needsGroupDetails(['all']), true);
  assert.equal(needsGroupDetails(['template-recommendations']), true);
  assert.equal(needsGroupDetails(['monitoring-policy']), true);
  assert.equal(needsGroupDetails(['user-activity']), false);
  assert.equal(needsGroupDetails(['incidents']), false);
});

test('needsTemplateDetails: only when templates is selected', () => {
  assert.equal(needsTemplateDetails(['all']), true);
  assert.equal(needsTemplateDetails(['template-recommendations']), true);
  assert.equal(needsTemplateDetails(['monitoring-policy']), false);
  assert.equal(needsTemplateDetails(['user-activity']), false);
});

test('needsDeepDive: in "all" mode honors operator deep flag', () => {
  assert.equal(needsDeepDive(['all'], { deep: true }), true);
  assert.equal(needsDeepDive(['all'], { deep: false }), false);
});

test('needsDeepDive: in scoped mode is implicit on instance-analysis selection', () => {
  // Operator deep flag is ignored when scoping is on; the deep dive
  // exists to feed Instance Analysis and only that.
  assert.equal(needsDeepDive(['instance-analysis'], { deep: false }), true);
  assert.equal(needsDeepDive(['user-activity'], { deep: true }), false);
  assert.equal(needsDeepDive(['template-recommendations', 'instance-analysis'], { deep: false }), true);
});

test('needsFrontendUsers: only when user-activity is selected', () => {
  assert.equal(needsFrontendUsers(['all']), true);
  assert.equal(needsFrontendUsers(['user-activity']), true);
  assert.equal(needsFrontendUsers(['template-recommendations']), false);
});

test('needsFrontendTemplates: only when templates is selected', () => {
  assert.equal(needsFrontendTemplates(['all']), true);
  assert.equal(needsFrontendTemplates(['template-recommendations']), true);
  assert.equal(needsFrontendTemplates(['user-activity']), false);
});

test('analyzerKeysForSections(["all"]) returns all five analyzer keys', () => {
  const keys = analyzerKeysForSections(['all']);
  assert.deepEqual([...keys].sort(), [
    'incidents', 'instances', 'monitoring_policy', 'templates', 'users'
  ]);
});

test('analyzerKeysForSections maps section ids to analyzer result keys', () => {
  assert.deepEqual([...analyzerKeysForSections(['user-activity'])], ['users']);
  assert.deepEqual([...analyzerKeysForSections(['template-recommendations'])], ['templates']);
  assert.deepEqual([...analyzerKeysForSections(['monitoring-policy'])], ['monitoring_policy']);
  assert.deepEqual([...analyzerKeysForSections(['instance-analysis'])], ['instances']);
});

test('SECTION_ANALYZER_KEY covers every analyzer-scoped section id', () => {
  assert.deepEqual(Object.keys(SECTION_ANALYZER_KEY).sort(), [
    'incidents',
    'instance-analysis',
    'monitoring-policy',
    'template-recommendations',
    'user-activity'
  ]);
});
