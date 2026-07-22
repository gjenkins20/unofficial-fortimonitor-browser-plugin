// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-298: template-pack-io envelope / parser / filename tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrapTemplatePack,
  unwrapTemplatePack,
  parseTemplatePackJson,
  templatePackFilename,
  FORMAT_NAME,
  FORMAT_VERSION,
  PACK_SCHEMA,
  TemplatePackError,
} from '../src/lib/template-pack-io.js';

// A valid ANONYMIZED inventory (tokenized names, synthetic ids, "m{n}" metric
// tokens) - wrapTemplatePack now enforces anonymization, so the fixture must
// pass assertAnonymizedInventory.
function makeInventory() {
  return {
    server_templates: [{ id: '1', name: 'Template 1', server_group: '/server_group/1' }],
    server_group_details: { '1': { name: 'Group 1' } },
    template_monitoring_configs: {
      '1': { total_metrics: 3, alerts_count: 1, metric_names: ['m1', 'm2', 'm3'], metrics_without_alerts: ['m2', 'm3'] },
    },
  };
}

test('wrap -> unwrap round-trips the inventory', () => {
  const env = wrapTemplatePack(makeInventory(), { extensionVersion: '1.11.0' });
  assert.equal(env.format, FORMAT_NAME);
  assert.equal(env.formatVersion, FORMAT_VERSION);
  assert.equal(env.extensionVersion, '1.11.0');
  assert.equal(env.pack.schema, PACK_SCHEMA);
  assert.equal(env.pack.anonymized, true);
  assert.equal(env.pack.templateCount, 1);

  const { pack } = unwrapTemplatePack(env);
  assert.deepEqual(pack.inventory.server_templates, makeInventory().server_templates);
});

test('parseTemplatePackJson round-trips through JSON', () => {
  const env = wrapTemplatePack(makeInventory());
  const { pack } = parseTemplatePackJson(JSON.stringify(env));
  assert.equal(pack.templateCount, 1);
  assert.equal(pack.inventory.server_group_details['1'].name, 'Group 1');
});

test('wrap refuses an empty / template-less inventory', () => {
  assert.throws(() => wrapTemplatePack(null), (e) => e instanceof TemplatePackError && e.code === 'empty');
  assert.throws(() => wrapTemplatePack({ server_templates: [] }), (e) => e.code === 'empty');
  assert.throws(() => wrapTemplatePack({}), (e) => e.code === 'empty');
});

test('wrap refuses a NON-anonymized inventory (real names / raw metric names)', () => {
  const raw = {
    server_templates: [{ id: '100', name: 'Acme FGT Edge', server_group: '/v2/server_group/20/', tags: ['client:acme'] }],
    server_group_details: { '20': { name: 'Acme Production Sites' } },
    template_monitoring_configs: {
      '100': { total_metrics: 2, alerts_count: 1, metric_names: ['Interface WAN-AcmeHQ bw', 'CPU'], metrics_without_alerts: ['CPU'] },
    },
  };
  assert.throws(() => wrapTemplatePack(raw), (e) => e instanceof TemplatePackError && e.code === 'not-anonymized');
});

test('unwrap rejects the wrong file format (e.g. a snapshot)', () => {
  assert.throws(
    () => unwrapTemplatePack({ format: 'fmn-toolkit-snapshot', formatVersion: 1, pack: {} }),
    (e) => e instanceof TemplatePackError && e.code === 'wrong-format'
  );
});

test('unwrap rejects a newer file format version', () => {
  const env = wrapTemplatePack(makeInventory());
  env.formatVersion = FORMAT_VERSION + 1;
  assert.throws(() => unwrapTemplatePack(env), (e) => e.code === 'wrong-format-version');
});

test('unwrap hard-errors on an unknown (newer) pack schema', () => {
  const env = wrapTemplatePack(makeInventory());
  env.pack.schema = PACK_SCHEMA + 1;
  assert.throws(() => unwrapTemplatePack(env), (e) => e.code === 'wrong-schema');
});

test('unwrap rejects a pack missing its inventory', () => {
  const env = wrapTemplatePack(makeInventory());
  delete env.pack.inventory;
  assert.throws(() => unwrapTemplatePack(env), (e) => e.code === 'missing-inventory');
});

test('parseTemplatePackJson reports invalid JSON distinctly', () => {
  assert.throws(() => parseTemplatePackJson('{not json'), (e) => e instanceof TemplatePackError && e.code === 'not-json');
});

test('templatePackFilename is identity-free and timestamped', () => {
  const name = templatePackFilename({ now: new Date('2026-07-21T09:05:00.000Z') });
  assert.equal(name, 'fmn-template-pack-20260721-0905.json');
  // No tenant/customer identifier anywhere in the name.
  assert.match(name, /^fmn-template-pack-\d{8}-\d{4}\.json$/);
});
