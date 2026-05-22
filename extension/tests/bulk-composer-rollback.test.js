import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollbackRun, STATUS, STEP_KINDS } from '../src/lib/bulk-composer-rollback.js';

function makeClients(overrides = {}) {
  const calls = [];
  const panopta = {
    async detachTemplate(serverId, templateId, opts) { calls.push(['detach', serverId, templateId, opts?.strategy]); },
    async deleteServerGroup(id) { calls.push(['del-group', id]); },
    async deleteServerAttribute({ serverId, attributeId }) { calls.push(['del-attr', serverId, attributeId]); },
    async removeServerTag(serverId, tags) { calls.push(['rm-tag', serverId, tags]); },
    ...overrides.panopta
  };
  const fortimonitor = {
    async deleteServerOrTemplate(id) { calls.push(['del-template-or-server', id]); },
    async deleteMonitoringPolicy(id) { calls.push(['del-mpw', id]); },
    ...overrides.fortimonitor
  };
  return { calls, clients: { panopta, fortimonitor } };
}

test('rollbackRun walks order list in reverse', async () => {
  const record = {
    runId: 'r1',
    order: ['template:100', 'mpw:200', 'attach:42:100'],
    created: {
      templates: [{ id: 100, name: 'T' }],
      mpws: [{ id: 200, name: 'M' }],
      server_groups: [], attributes: [], tags: []
    },
    attached: { templateAttachments: [{ serverId: 42, templateId: 100, templateName: 'T' }] }
  };
  const { calls, clients } = makeClients();
  const outcome = await rollbackRun(record, clients);
  // Reverse order: detach first, then delete MPW, then delete template.
  assert.deepEqual(calls.map((c) => c[0]), ['detach', 'del-mpw', 'del-template-or-server']);
  assert.equal(calls[0][3], 'delete'); // detach with strategy=delete
  assert.equal(outcome.steps.length, 3);
  assert.ok(outcome.steps.every((s) => s.status === STATUS.SUCCEEDED));
});

test('rollbackRun treats 404 as already-gone', async () => {
  const record = {
    runId: 'r2',
    order: ['mpw:200'],
    created: { templates: [], mpws: [{ id: 200, name: 'M' }], server_groups: [], attributes: [], tags: [] },
    attached: { templateAttachments: [] }
  };
  const { clients } = makeClients({
    fortimonitor: {
      async deleteMonitoringPolicy() {
        const err = new Error('not found');
        err.status = 404;
        throw err;
      }
    }
  });
  const outcome = await rollbackRun(record, clients);
  assert.equal(outcome.steps.length, 1);
  assert.equal(outcome.steps[0].status, STATUS.ALREADY_GONE);
});

test('rollbackRun records failed step and continues', async () => {
  const record = {
    runId: 'r3',
    order: ['mpw:201', 'mpw:202'],
    created: {
      templates: [],
      mpws: [{ id: 201, name: 'M1' }, { id: 202, name: 'M2' }],
      server_groups: [], attributes: [], tags: []
    },
    attached: { templateAttachments: [] }
  };
  const calls = [];
  const clients = {
    panopta: {},
    fortimonitor: {
      async deleteMonitoringPolicy(id) {
        calls.push(id);
        if (id === 202) throw new Error('boom 500');
      }
    }
  };
  const outcome = await rollbackRun(record, clients);
  // Reverse order: 202 first (fails), then 201 (succeeds). Loop continues past failure.
  assert.deepEqual(calls, [202, 201]);
  assert.equal(outcome.steps[0].status, STATUS.FAILED);
  assert.match(outcome.steps[0].error, /boom 500/);
  assert.equal(outcome.steps[1].status, STATUS.SUCCEEDED);
});

test('rollbackRun marks step failed when required client is missing', async () => {
  const record = {
    runId: 'r4',
    order: ['template:5'],
    created: { templates: [{ id: 5, name: 'T' }], mpws: [], server_groups: [], attributes: [], tags: [] },
    attached: { templateAttachments: [] }
  };
  const outcome = await rollbackRun(record, { panopta: {}, fortimonitor: null });
  assert.equal(outcome.steps[0].status, STATUS.FAILED);
  assert.match(outcome.steps[0].error, /FortimonitorClient unavailable/);
});

test('rollbackRun handles server_group order token via deleteServerGroup', async () => {
  const record = {
    runId: 'r5',
    order: ['server_group:777'],
    created: { templates: [], mpws: [], server_groups: [{ id: 777, name: 'Grp' }], attributes: [], tags: [] },
    attached: { templateAttachments: [] }
  };
  const { calls, clients } = makeClients();
  await rollbackRun(record, clients);
  assert.deepEqual(calls[0], ['del-group', 777]);
});

test('rollbackRun handles attribute + tag steps', async () => {
  const record = {
    runId: 'r6',
    order: ['attr:42:9001', 'tag:42:datacenter:iad'],
    created: {
      templates: [], mpws: [], server_groups: [],
      attributes: [{ serverId: 42, attributeId: 9001 }],
      tags: [{ serverId: 42, tag: 'datacenter:iad' }]
    },
    attached: { templateAttachments: [] }
  };
  const { calls, clients } = makeClients();
  await rollbackRun(record, clients);
  // Reverse order: tag removed first, then attribute.
  assert.equal(calls[0][0], 'rm-tag');
  assert.deepEqual(calls[0][2], ['datacenter:iad']);
  assert.equal(calls[1][0], 'del-attr');
  assert.equal(calls[1][2], 9001);
});

test('rollbackRun emits empty steps for empty record', async () => {
  const record = {
    runId: 'r7',
    order: [],
    created: { templates: [], mpws: [], server_groups: [], attributes: [], tags: [] },
    attached: { templateAttachments: [] }
  };
  const { clients } = makeClients();
  const outcome = await rollbackRun(record, clients);
  assert.deepEqual(outcome.steps, []);
});

test('STEP_KINDS / STATUS exports are frozen', () => {
  assert.ok(Object.isFrozen(STEP_KINDS));
  assert.ok(Object.isFrozen(STATUS));
});
