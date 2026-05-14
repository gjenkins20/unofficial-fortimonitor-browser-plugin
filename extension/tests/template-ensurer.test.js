// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-211 Phase B: ensureTemplate must NOT default plugin_textkey to
// "fortinet.fortigate" cross-type. Refuse the write when the cluster
// didn't carry the device's monitoring category.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureTemplate } from '../src/lib/template-ensurer.js';

function mkClients({ existing = [], created = null, addCalls } = {}) {
  let createCalls = 0;
  return {
    panopta: {
      listTemplates: async () => {
        // Initial preflight list: only the pre-existing templates.
        // After createServerTemplate has been called, the new template
        // is reachable from subsequent list calls. Matches live
        // FortiMonitor behavior where the SPA's create writes
        // synchronously even when the response is delayed.
        if (created && createCalls > 0) {
          return [...existing, created];
        }
        return existing.slice();
      }
    },
    fmClient: {
      createServerTemplate: async () => {
        createCalls++;
        return { success: true };
      },
      addTemplateMetric: async (args) => {
        addCalls?.push(args);
        return { success: true };
      }
    }
  };
}

test('reuses existing template by exact name', async () => {
  const clients = mkClients({
    existing: [{ id: 5, name: 'My-Template' }]
  });
  const r = await ensureTemplate(clients, {
    name: 'My-Template',
    templateType: 'fabric_template',
    destinationGroup: 'grp-1',
    resources: []
  });
  assert.equal(r.reused, true);
  assert.equal(r.templateId, 5);
  assert.equal(r.created, false);
});

test('dry-run does not call create/addMetric', async () => {
  const addCalls = [];
  const clients = mkClients({ addCalls });
  const r = await ensureTemplate(clients, {
    name: 'New-Template',
    templateType: 'fabric_template',
    destinationGroup: 'grp-1',
    resources: [{ resource_textkey: 'cpu', plugin_textkey: 'fortinet.fortigate' }],
    dryRun: true
  });
  assert.equal(r.dry_run, true);
  assert.equal(r.would_create, true);
  assert.equal(r.would_populate_count, 1);
  assert.equal(addCalls.length, 0);
});

test('clone-from-device skips addTemplateMetric (FortiMonitor populates from source)', async () => {
  const addCalls = [];
  const created = { id: 99, name: 'Cloned' };
  const clients = mkClients({ created, addCalls });
  // After create the listTemplates returns the cloned template
  const r = await ensureTemplate(clients, {
    name: 'Cloned',
    templateType: 'fabric_template',
    destinationGroup: 'grp-1',
    sourceServerId: 42024061,
    resources: [{ resource_textkey: 'cpu', plugin_textkey: 'fortinet.fortigate' }]
  });
  assert.equal(r.created, true);
  assert.equal(r.populated_count, 0);
  assert.equal(addCalls.length, 0);
});

// =====================================================================
// FMN-211 Phase B: plugin_textkey is required, no FortiGate default
// =====================================================================

test('missing plugin_textkey throws before any addTemplateMetric call (FMN-211)', async () => {
  const addCalls = [];
  const created = { id: 10, name: 'No-Textkey' };
  const clients = mkClients({ created, addCalls });
  await assert.rejects(
    () => ensureTemplate(clients, {
      name: 'No-Textkey',
      templateType: 'fabric_template',
      destinationGroup: 'grp-1',
      resources: [{ resource_textkey: 'radio.signal', name: 'Radio Signal' }]
    }),
    /plugin_textkey/i
  );
  // The template create may have completed, but no addTemplateMetric ran.
  assert.equal(addCalls.length, 0);
});

test('empty-string plugin_textkey is rejected the same as missing', async () => {
  const addCalls = [];
  const created = { id: 11, name: 'Empty-Textkey' };
  const clients = mkClients({ created, addCalls });
  await assert.rejects(
    () => ensureTemplate(clients, {
      name: 'Empty-Textkey',
      templateType: 'fabric_template',
      destinationGroup: 'grp-1',
      resources: [{ resource_textkey: 'cpu', plugin_textkey: '' }]
    }),
    /plugin_textkey/i
  );
  assert.equal(addCalls.length, 0);
});

test('FortiAP resource with fortinet.fortiap plugin_textkey routes correctly (cross-type)', async () => {
  const addCalls = [];
  const created = { id: 200, name: 'AP-Template' };
  const clients = mkClients({ created, addCalls });
  const r = await ensureTemplate(clients, {
    name: 'AP-Template',
    templateType: 'fabric_template',
    destinationGroup: 'grp-1',
    resources: [{ resource_textkey: 'radio.signal', plugin_textkey: 'fortinet.fortiap', name: 'Radio Signal' }]
  });
  assert.equal(r.created, true);
  assert.equal(r.populated_count, 1);
  assert.equal(addCalls.length, 1);
  assert.equal(addCalls[0].pluginTextkey, 'fortinet.fortiap');
  assert.equal(addCalls[0].resourceTextkey, 'radio.signal');
});
