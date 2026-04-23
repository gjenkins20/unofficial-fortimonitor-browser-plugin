import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEBGUI_COLUMNS_KEY,
  COLUMN_REGISTRY,
  defaultOrder,
  normalize,
  getColumnOrder,
  setColumnOrder,
  resetColumnOrder,
  subscribeColumnOrder,
  getAllColumnOrders,
  listAugmentations,
  getRegistry,
} from '../src/lib/column-order.js';
import { createStorageMock } from './fixtures/chrome-mocks.js';

const AUG = 'instances-ip-dns-columns';

test('listAugmentations returns registered augmentations with metadata', () => {
  const list = listAugmentations();
  const inst = list.find((a) => a.id === AUG);
  assert.ok(inst, 'instances-ip-dns-columns should be registered');
  assert.equal(inst.context, '/report/ListServers');
  assert.equal(inst.label, 'Instances list');
  assert.equal(inst.columns.length, 4);
});

test('defaultOrder returns the registry order with all visible', () => {
  const out = defaultOrder(AUG);
  assert.deepEqual(out, [
    { id: 'instance', hidden: false },
    { id: 'ip', hidden: false },
    { id: 'dns', hidden: false },
    { id: 'type', hidden: false },
  ]);
});

test('defaultOrder returns empty for unknown augmentation', () => {
  assert.deepEqual(defaultOrder('does-not-exist'), []);
});

test('normalize fills in missing columns at the end in registry order', () => {
  const out = normalize(AUG, [{ id: 'dns', hidden: false }]);
  assert.deepEqual(out, [
    { id: 'dns', hidden: false },
    { id: 'instance', hidden: false },
    { id: 'ip', hidden: false },
    { id: 'type', hidden: false },
  ]);
});

test('normalize drops unknown ids', () => {
  const out = normalize(AUG, [
    { id: 'instance', hidden: false },
    { id: 'totally-fake', hidden: true },
    { id: 'ip', hidden: true },
    { id: 'dns', hidden: false },
    { id: 'type', hidden: false },
  ]);
  assert.deepEqual(out, [
    { id: 'instance', hidden: false },
    { id: 'ip', hidden: true },
    { id: 'dns', hidden: false },
    { id: 'type', hidden: false },
  ]);
});

test('normalize drops duplicate ids (first wins)', () => {
  const out = normalize(AUG, [
    { id: 'ip', hidden: true },
    { id: 'ip', hidden: false },
    { id: 'instance', hidden: false },
    { id: 'dns', hidden: false },
    { id: 'type', hidden: false },
  ]);
  assert.deepEqual(out, [
    { id: 'ip', hidden: true },
    { id: 'instance', hidden: false },
    { id: 'dns', hidden: false },
    { id: 'type', hidden: false },
  ]);
});

test('normalize forces locked-visible columns to hidden=false', () => {
  const out = normalize(AUG, [
    { id: 'instance', hidden: true },
    { id: 'ip', hidden: true },
    { id: 'dns', hidden: false },
  ]);
  const inst = out.find((c) => c.id === 'instance');
  assert.equal(inst.hidden, false, 'instance is lockedVisible, hidden must be false');
  const ip = out.find((c) => c.id === 'ip');
  assert.equal(ip.hidden, true, 'non-locked columns retain their hidden state');
});

test('normalize coerces non-boolean hidden to a boolean', () => {
  const out = normalize(AUG, [
    { id: 'ip', hidden: 'yes' },
    { id: 'dns', hidden: 0 },
    { id: 'instance', hidden: null },
  ]);
  assert.equal(out.find((c) => c.id === 'ip').hidden, true);
  assert.equal(out.find((c) => c.id === 'dns').hidden, false);
  assert.equal(out.find((c) => c.id === 'instance').hidden, false);
});

test('normalize tolerates non-array, null, and garbage input', () => {
  for (const input of [null, undefined, {}, 'oops', 42, [{}, null, 'x', { id: 5 }]]) {
    const out = normalize(AUG, input);
    assert.equal(out.length, 4, `garbage input ${JSON.stringify(input)} still yields full default order`);
  }
});

test('getColumnOrder returns defaults on empty storage', async () => {
  const storage = createStorageMock();
  const out = await getColumnOrder(AUG, storage);
  assert.deepEqual(out, defaultOrder(AUG));
});

test('setColumnOrder + getColumnOrder roundtrip', async () => {
  const storage = createStorageMock();
  await setColumnOrder(AUG, [
    { id: 'dns', hidden: false },
    { id: 'instance', hidden: false },
    { id: 'ip', hidden: true },
    { id: 'type', hidden: false },
  ], storage);
  const out = await getColumnOrder(AUG, storage);
  assert.deepEqual(out, [
    { id: 'dns', hidden: false },
    { id: 'instance', hidden: false },
    { id: 'ip', hidden: true },
    { id: 'type', hidden: false },
  ]);
});

test('setColumnOrder normalizes before persisting (drops unknown, fills missing)', async () => {
  const storage = createStorageMock();
  await setColumnOrder(AUG, [
    { id: 'fake', hidden: true },
    { id: 'dns', hidden: true },
  ], storage);
  const persisted = storage.__raw()[WEBGUI_COLUMNS_KEY][AUG];
  assert.deepEqual(persisted, [
    { id: 'dns', hidden: true },
    { id: 'instance', hidden: false },
    { id: 'ip', hidden: false },
    { id: 'type', hidden: false },
  ]);
});

test('setColumnOrder for one augmentation does not clobber others', async () => {
  const storage = createStorageMock({
    [WEBGUI_COLUMNS_KEY]: {
      'other-aug': [{ id: 'foo', hidden: true }],
    },
  });
  await setColumnOrder(AUG, defaultOrder(AUG), storage);
  const all = storage.__raw()[WEBGUI_COLUMNS_KEY];
  assert.ok(all['other-aug'], 'unrelated augmentations are preserved');
  assert.ok(all[AUG], 'target augmentation is written');
});

test('setColumnOrder is a no-op for unknown augmentation', async () => {
  const storage = createStorageMock();
  await setColumnOrder('does-not-exist', [{ id: 'x', hidden: false }], storage);
  assert.equal(storage.__raw()[WEBGUI_COLUMNS_KEY], undefined);
});

test('resetColumnOrder removes the augmentation slot', async () => {
  const storage = createStorageMock();
  await setColumnOrder(AUG, [{ id: 'dns', hidden: false }], storage);
  assert.ok(storage.__raw()[WEBGUI_COLUMNS_KEY][AUG]);
  await resetColumnOrder(AUG, storage);
  assert.equal(storage.__raw()[WEBGUI_COLUMNS_KEY][AUG], undefined);
});

test('resetColumnOrder is a no-op when nothing persisted', async () => {
  const storage = createStorageMock();
  await resetColumnOrder(AUG, storage);
  assert.equal(storage.__raw()[WEBGUI_COLUMNS_KEY], undefined);
});

test('getColumnOrder fails open to defaults when storage rejects', async () => {
  const broken = { async get() { throw new Error('storage gone'); } };
  const out = await getColumnOrder(AUG, broken);
  assert.deepEqual(out, defaultOrder(AUG));
});

test('getAllColumnOrders returns normalized lists for every registered augmentation', async () => {
  const storage = createStorageMock();
  await setColumnOrder(AUG, [{ id: 'dns', hidden: true }], storage);
  const all = await getAllColumnOrders(storage);
  assert.ok(all[AUG], 'augmentation present');
  for (const id of Object.keys(COLUMN_REGISTRY)) {
    assert.ok(all[id], `${id} should be present in getAllColumnOrders output`);
    assert.equal(all[id].length, COLUMN_REGISTRY[id].columns.length);
  }
});

test('subscribeColumnOrder fires with normalized list when slot changes', () => {
  const listeners = new Set();
  const onChanged = {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
  };
  const received = [];
  const unsubscribe = subscribeColumnOrder(AUG, (list) => received.push(list), onChanged);

  // Simulate a change from chrome.storage.onChanged.
  for (const fn of listeners) {
    fn({
      [WEBGUI_COLUMNS_KEY]: {
        newValue: { [AUG]: [{ id: 'dns', hidden: false }] },
        oldValue: {},
      },
    }, 'local');
  }

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], [
    { id: 'dns', hidden: false },
    { id: 'instance', hidden: false },
    { id: 'ip', hidden: false },
    { id: 'type', hidden: false },
  ], 'normalized to fill missing entries');

  unsubscribe();
  assert.equal(listeners.size, 0, 'unsubscribe removes the listener');
});

test('subscribeColumnOrder ignores changes to other storage keys and other areas', () => {
  const listeners = new Set();
  const onChanged = {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
  };
  const received = [];
  subscribeColumnOrder(AUG, (list) => received.push(list), onChanged);

  for (const fn of listeners) {
    fn({ 'fm:devMode': { newValue: true, oldValue: false } }, 'local');
    fn({ [WEBGUI_COLUMNS_KEY]: { newValue: {}, oldValue: {} } }, 'sync');
  }
  assert.equal(received.length, 0);
});

test('getRegistry returns null for unknown augmentation', () => {
  assert.equal(getRegistry('nope'), null);
  assert.ok(getRegistry(AUG));
});
