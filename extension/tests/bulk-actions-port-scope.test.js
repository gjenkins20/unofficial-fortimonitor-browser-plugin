import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as add from '../src/lib/bulk-actions/add-port-scope.js';
import * as remove from '../src/lib/bulk-actions/remove-port-scope.js';

// =====================================================================
// FMN-162: Bulk Port Scope action descriptors
// =====================================================================

const PORTS_A = [
  { name: 'port1', index: 0, isActive: true },
  { name: 'port2', index: 1, isActive: true },
  { name: 'port3', index: 2, isActive: false },
  { name: 'port4', index: 3, isActive: false }
];

// ---------- validate ----------

test('add-port-scope.validate accepts array of names', () => {
  const v = add.validate({ portNames: ['port3', 'port4'] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value.portNames, ['port3', 'port4']);
});

test('add-port-scope.validate accepts comma-separated string and trims', () => {
  const v = add.validate({ portNames: 'port3,  port4 ,port5' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value.portNames, ['port3', 'port4', 'port5']);
});

test('add-port-scope.validate rejects empty', () => {
  assert.equal(add.validate({}).ok, false);
  assert.equal(add.validate({ portNames: [] }).ok, false);
  assert.equal(add.validate({ portNames: '   ' }).ok, false);
});

test('remove-port-scope.validate mirrors add-port-scope', () => {
  assert.equal(remove.validate({ portNames: ['port1'] }).ok, true);
  assert.equal(remove.validate({}).ok, false);
});

// ---------- describe: add-port-scope ----------

test('add-port-scope.describe: known ports, some inactive -> will change', () => {
  const target = { id: 1, name: 'fgt-a', ports: PORTS_A };
  const d = add.describe(target, { portNames: ['port3', 'port5'] });
  assert.equal(d.willChange, true);
  assert.equal(d.prev, 'port1, port2');
  assert.equal(d.next, 'port1, port2, port3');
  assert.match(d.note, /Will add 1 port: port3/);
});

test('add-port-scope.describe: all named ports already active -> skip', () => {
  const target = { id: 1, name: 'fgt-a', ports: PORTS_A };
  const d = add.describe(target, { portNames: ['port1', 'port2'] });
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /already in scope/);
});

test('add-port-scope.describe: no matching ports -> skip', () => {
  const target = { id: 1, name: 'fgt-a', ports: PORTS_A };
  const d = add.describe(target, { portNames: ['wan99'] });
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
  assert.match(d.note, /No matching ports/);
});

test('add-port-scope.describe: ports unknown -> placeholder branch', () => {
  const target = { id: 1, name: 'fgt-a' }; // no ports
  const d = add.describe(target, { portNames: ['port3'] });
  assert.equal(d.willChange, true);
  assert.equal(d.prev, '(ports unknown)');
  assert.match(d.next, /\+ port3/);
});

test('add-port-scope.describe: case-insensitive matching', () => {
  const target = { id: 1, ports: PORTS_A };
  const d = add.describe(target, { portNames: ['PORT3'] });
  assert.equal(d.willChange, true);
  assert.match(d.next, /port3/);
});

// ---------- describe: remove-port-scope ----------

test('remove-port-scope.describe: removes active ports -> will change', () => {
  const target = { id: 1, ports: PORTS_A };
  const d = remove.describe(target, { portNames: ['port1'] });
  assert.equal(d.willChange, true);
  assert.equal(d.prev, 'port1, port2');
  assert.equal(d.next, 'port2');
  assert.match(d.note, /Will remove 1 port: port1/);
});

test('remove-port-scope.describe: removing inactive port -> skip', () => {
  const target = { id: 1, ports: PORTS_A };
  const d = remove.describe(target, { portNames: ['port3'] });
  assert.equal(d.willChange, false);
  assert.equal(d.skip, true);
});

test('remove-port-scope.describe: removing all active ports -> next is (none)', () => {
  const target = { id: 1, ports: PORTS_A };
  const d = remove.describe(target, { portNames: ['port1', 'port2'] });
  assert.equal(d.willChange, true);
  assert.equal(d.next, '(none)');
});

test('remove-port-scope.describe: ports unknown -> placeholder branch', () => {
  const target = { id: 1, name: 'fgt-a' };
  const d = remove.describe(target, { portNames: ['port1'] });
  assert.equal(d.willChange, true);
  assert.equal(d.prev, '(ports unknown)');
  assert.match(d.next, /port1/);
});

// ---------- commit: add-port-scope ----------

test('add-port-scope.commit: fetches latest ports, computes kept indices, calls savePortSelection', async () => {
  let saved = null;
  const fmClient = {
    async getDevicePorts() { return { ports: PORTS_A, portFilters: { searchTerm: '', filters: [] } }; },
    async savePortSelection(args) { saved = args; return { success: true }; }
  };
  const out = await add.commit({ id: 42 }, { portNames: ['port3'] }, { fortimonitorClient: fmClient });
  assert.equal(out.noop, false);
  assert.equal(out.addedCount, 1);
  assert.equal(out.success, true);
  // Kept = currently active (port1, port2) + new active (port3)
  assert.deepEqual(saved.selectedIndices, ['0', '1', '2']);
  assert.equal(saved.totalPortCount, 4);
  assert.equal(saved.portSelectionType, 'manual');
});

test('add-port-scope.commit: no matching inactive ports -> noop, no save', async () => {
  let saveCalled = false;
  const fmClient = {
    async getDevicePorts() { return { ports: PORTS_A, portFilters: {} }; },
    async savePortSelection() { saveCalled = true; return { success: true }; }
  };
  const out = await add.commit({ id: 42 }, { portNames: ['port1'] }, { fortimonitorClient: fmClient });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'already-in-scope');
  assert.equal(saveCalled, false);
});

test('add-port-scope.commit: empty ports array -> noop with no-ports reason', async () => {
  const fmClient = {
    async getDevicePorts() { return { ports: [], portFilters: {} }; },
    async savePortSelection() { throw new Error('should not call'); }
  };
  const out = await add.commit({ id: 42 }, { portNames: ['port3'] }, { fortimonitorClient: fmClient });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'no-ports');
});

test('add-port-scope.commit: missing fortimonitorClient throws', async () => {
  await assert.rejects(
    () => add.commit({ id: 42 }, { portNames: ['port3'] }, {}),
    /FortimonitorClient required/
  );
});

// ---------- commit: remove-port-scope ----------

test('remove-port-scope.commit: drops named ports, keeps the rest active', async () => {
  let saved = null;
  const fmClient = {
    async getDevicePorts() { return { ports: PORTS_A, portFilters: {} }; },
    async savePortSelection(args) { saved = args; return { success: true }; }
  };
  const out = await remove.commit({ id: 42 }, { portNames: ['port1'] }, { fortimonitorClient: fmClient });
  assert.equal(out.noop, false);
  assert.equal(out.removedCount, 1);
  // Kept = port2 only (port1 removed; port3/port4 were not active to begin with)
  assert.deepEqual(saved.selectedIndices, ['1']);
});

test('remove-port-scope.commit: nothing to remove -> noop', async () => {
  let saveCalled = false;
  const fmClient = {
    async getDevicePorts() { return { ports: PORTS_A, portFilters: {} }; },
    async savePortSelection() { saveCalled = true; return { success: true }; }
  };
  const out = await remove.commit({ id: 42 }, { portNames: ['port3'] }, { fortimonitorClient: fmClient });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'not-in-scope');
  assert.equal(saveCalled, false);
});

test('remove-port-scope.commit: removing all active ports yields empty selectedIndices', async () => {
  let saved = null;
  const fmClient = {
    async getDevicePorts() { return { ports: PORTS_A, portFilters: {} }; },
    async savePortSelection(args) { saved = args; return { success: true }; }
  };
  const out = await remove.commit({ id: 42 }, { portNames: ['port1', 'port2'] }, { fortimonitorClient: fmClient });
  assert.equal(out.noop, false);
  assert.equal(out.removedCount, 2);
  assert.deepEqual(saved.selectedIndices, []);
});
