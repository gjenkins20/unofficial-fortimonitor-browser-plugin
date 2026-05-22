import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRun,
  listRuns,
  getRun,
  setRollbackOutcome,
  clearAll,
  extractRowEffects,
  aggregateRunEffects,
  MAX_ENTRIES,
  _STORAGE_KEY
} from '../src/lib/bulk-composer-journal.js';

function makeMemStorage() {
  let store = {};
  return {
    async get(key) {
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) if (k in store) out[k] = store[k];
        return out;
      }
      if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
      if (key && typeof key === 'object') {
        const out = {};
        for (const k of Object.keys(key)) out[k] = (k in store) ? store[k] : key[k];
        return out;
      }
      return { ...store };
    },
    async set(obj) { Object.assign(store, obj); },
    async remove(key) { delete store[key]; },
    _dump() { return JSON.parse(JSON.stringify(store)); }
  };
}

test('appendRun stores a run record with generated id', async () => {
  const storage = makeMemStorage();
  const stored = await appendRun({
    actionId: 'add-tag',
    actionLabel: 'Add Tag',
    targetIds: [42],
    created: { templates: [], mpws: [], server_groups: [], attributes: [], tags: [{ serverId: 42, tag: 'x' }] }
  }, { storage });
  assert.match(stored.runId, /^run-[a-z0-9]+-[a-z0-9]+$/);
  const dumped = storage._dump();
  assert.equal(dumped[_STORAGE_KEY].length, 1);
  assert.equal(dumped[_STORAGE_KEY][0].runId, stored.runId);
});

test('listRuns returns newest first', async () => {
  const storage = makeMemStorage();
  await appendRun({ actionId: 'a' }, { storage });
  await appendRun({ actionId: 'b' }, { storage });
  const runs = await listRuns({ storage });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].actionId, 'b');
  assert.equal(runs[1].actionId, 'a');
});

test('ring buffer caps at MAX_ENTRIES, evicting oldest', async () => {
  const storage = makeMemStorage();
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    await appendRun({ actionId: `r${i}` }, { storage });
  }
  const runs = await listRuns({ storage });
  assert.equal(runs.length, MAX_ENTRIES);
  assert.equal(runs[0].actionId, `r${MAX_ENTRIES + 4}`);
  assert.equal(runs[runs.length - 1].actionId, `r${5}`);
});

test('getRun looks up by id, null on miss', async () => {
  const storage = makeMemStorage();
  const r = await appendRun({ actionId: 'x' }, { storage });
  assert.equal((await getRun(r.runId, { storage })).actionId, 'x');
  assert.equal(await getRun('nope', { storage }), null);
});

test('setRollbackOutcome attaches the rollback blob to the matching entry', async () => {
  const storage = makeMemStorage();
  const r = await appendRun({ actionId: 'x' }, { storage });
  const outcome = { startedAt: 't1', finishedAt: 't2', steps: [{ kind: 'tag', status: 'succeeded' }] };
  const updated = await setRollbackOutcome(r.runId, outcome, { storage });
  assert.deepEqual(updated.rollback, outcome);
  const fetched = await getRun(r.runId, { storage });
  assert.deepEqual(fetched.rollback, outcome);
});

test('clearAll empties storage', async () => {
  const storage = makeMemStorage();
  await appendRun({ actionId: 'x' }, { storage });
  await clearAll({ storage });
  assert.deepEqual(await listRuns({ storage }), []);
});

// -------- extractRowEffects --------

test('extractRowEffects skips dry-run and noop rows', () => {
  const a = extractRowEffects('add-tag', { dry_run: true, addedTags: ['x'] }, { id: 1 }, 0);
  const b = extractRowEffects('add-tag', { noop: true, addedTags: ['x'] }, { id: 1 }, 0);
  assert.deepEqual(a.created.tags, []);
  assert.deepEqual(b.created.tags, []);
});

test('extractRowEffects for profile-and-create-templates captures created template + mpw + attach', () => {
  const e = extractRowEffects('profile-and-create-templates', {
    status: 200,
    template: { id: 555, name: 'cluster-A', created: true },
    mpw: { id: 707, name: 'auto-apply A', created: true }
  }, { id: 42 }, 0);
  assert.equal(e.created.templates.length, 1);
  assert.equal(e.created.mpws.length, 1);
  assert.equal(e.attached.templateAttachments.length, 1);
  assert.deepEqual(e.order, ['template:555', 'mpw:707', 'attach:42:555']);
});

test('extractRowEffects for profile-and-create-templates skips attach when reason=template-already-attached', () => {
  const e = extractRowEffects('profile-and-create-templates', {
    status: 200,
    reason: 'template-already-attached',
    template: { id: 555, name: 'cluster-A', created: false, reused: true }
  }, { id: 42 }, 0);
  assert.equal(e.attached.templateAttachments.length, 0);
  assert.equal(e.created.templates.length, 0);
});

test('extractRowEffects for apply-template captures attachment only', () => {
  const e = extractRowEffects('apply-template', {
    status: 200,
    template: { id: 999, name: 'stock-x' }
  }, { id: 7 }, 2);
  assert.deepEqual(e.attached.templateAttachments, [{
    serverId: 7, templateId: 999, templateName: 'stock-x', viaRowIndex: 2
  }]);
  assert.deepEqual(e.order, ['attach:7:999']);
});

test('extractRowEffects for add-tag captures addedTags', () => {
  const e = extractRowEffects('add-tag', {
    status: 200,
    addedTags: ['region:us-east', 'tier:gold']
  }, { id: 33 }, 0);
  assert.equal(e.created.tags.length, 2);
  assert.deepEqual(e.created.tags.map((t) => t.tag), ['region:us-east', 'tier:gold']);
});

test('extractRowEffects for auto-set-attribute-by-name captures attribute', () => {
  const e = extractRowEffects('auto-set-attribute-by-name', {
    status: 200,
    attribute: { id: 9001, key: 'datacenter', value: 'iad', typeUrl: 'https://api2.panopta.com/v2/server_attribute_type/12' }
  }, { id: 88 }, 1);
  assert.equal(e.created.attributes.length, 1);
  assert.equal(e.created.attributes[0].attributeId, 9001);
});

test('extractRowEffects for unknown action emits nothing', () => {
  const e = extractRowEffects('schedule-maintenance-window', { status: 200, mwId: 5 }, { id: 1 }, 0);
  assert.equal(e.created.templates.length + e.created.mpws.length + e.created.attributes.length + e.created.tags.length, 0);
  assert.equal(e.attached.templateAttachments.length, 0);
});

// -------- aggregateRunEffects --------

test('aggregateRunEffects dedupes created templates/mpws across rows', () => {
  const rows = [
    { id: 1, detail: { template: { id: 100, name: 'T', created: true }, mpw: { id: 200, name: 'M', created: true } } },
    { id: 2, detail: { template: { id: 100, name: 'T', created: false }, mpw: { id: 200, name: 'M', created: false } } }
  ];
  const merged = aggregateRunEffects(rows, 'profile-and-create-templates');
  assert.equal(merged.created.templates.length, 1);
  assert.equal(merged.created.mpws.length, 1);
  // Each row contributed its own attach.
  assert.equal(merged.attached.templateAttachments.length, 2);
});

test('aggregateRunEffects order list is dedup but creation-ordered', () => {
  const rows = [
    { id: 1, detail: { template: { id: 100, created: true }, mpw: { id: 200, created: true } } },
    { id: 2, detail: { template: { id: 100, created: false }, mpw: { id: 200, created: false } } }
  ];
  const merged = aggregateRunEffects(rows, 'profile-and-create-templates');
  // Template + MPW appear once each; both rows' attaches present.
  assert.deepEqual(merged.order, ['template:100', 'mpw:200', 'attach:1:100', 'attach:2:100']);
});
