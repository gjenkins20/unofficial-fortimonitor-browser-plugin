import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueueEntries, buildAddQueueEntries, summarizePlan, summarizeAddPlan } from '../src/ui/plan.js';

function sampleGroup(fingerprint, deviceIds, ports) {
  return {
    fingerprint,
    portsData: {
      filterType: 'all',
      portFilters: { searchTerm: '', filters: [] },
      ports
    },
    devices: deviceIds.map((serverId) => ({ serverId }))
  };
}

test('builds one entry per device with kept indices', () => {
  const groups = [
    sampleGroup('fp1', [1, 2], [
      { name: 'port1', index: '0', admin_status: 'up', oper_status: 'up' },
      { name: 'wan2',  index: '1', admin_status: 'up', oper_status: 'down' },
      { name: 'port3', index: '2', admin_status: 'up', oper_status: 'up' }
    ])
  ];
  const decisions = new Map([['fp1', { skipped: false, removePortNames: ['wan2'] }]]);
  const entries = buildQueueEntries({ groups, decisions, nameById: {}, batchId: 'b1' });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].intendedAction.selectedIndices, ['0', '2']);
  assert.equal(entries[0].intendedAction.totalPortCount, 3);
  assert.deepEqual(entries[0].removedPortNames, ['wan2']);
  assert.equal(entries[0].intendedAction.portSelectionType, 'manual');
  assert.equal(entries[0].status, 'pending');
});

test('skipped decisions produce no entries', () => {
  const groups = [
    sampleGroup('fp1', [1], [{ name: 'wan2', index: '0', admin_status: 'up', oper_status: 'down' }])
  ];
  const decisions = new Map([['fp1', { skipped: true, removePortNames: [] }]]);
  const entries = buildQueueEntries({ groups, decisions, nameById: {}, batchId: 'b1' });
  assert.equal(entries.length, 0);
});

test('no-op decisions (nothing marked) produce no entries', () => {
  const groups = [sampleGroup('fp1', [1], [{ name: 'a', index: '0' }])];
  const decisions = new Map([['fp1', { skipped: false, removePortNames: [] }]]);
  const entries = buildQueueEntries({ groups, decisions, nameById: {}, batchId: 'b1' });
  assert.equal(entries.length, 0);
});

test('device names from nameById are attached', () => {
  const groups = [sampleGroup('fp1', [42], [
    { name: 'port1', index: '0' }, { name: 'wan2', index: '1' }
  ])];
  const decisions = new Map([['fp1', { skipped: false, removePortNames: ['wan2'] }]]);
  const entries = buildQueueEntries({
    groups, decisions, nameById: { 42: 'FGT-Branch-001' }, batchId: 'b1'
  });
  assert.equal(entries[0].deviceName, 'FGT-Branch-001');
});

test('summarizePlan aggregates by group', () => {
  const entries = [
    { serverId: 1, groupId: 'a', deviceName: 'd1', removedPortNames: ['wan2'] },
    { serverId: 2, groupId: 'a', deviceName: 'd2', removedPortNames: ['wan2'] },
    { serverId: 3, groupId: 'b', deviceName: 'd3', removedPortNames: ['x2'] }
  ];
  const s = summarizePlan(entries);
  assert.equal(s.totalDevices, 3);
  assert.equal(s.totalGroups, 2);
  assert.equal(s.totalPortsToRemove, 3);
});

test('requires a batchId', () => {
  assert.throws(() => buildQueueEntries({
    groups: [], decisions: new Map(), batchId: ''
  }), /batchId/);
});

test('requires a Map for decisions', () => {
  assert.throws(() => buildQueueEntries({
    groups: [], decisions: {}, batchId: 'b1'
  }), /decisions/);
});

// --- buildAddQueueEntries -------------------------------------------

test('buildAddQueueEntries keeps in-scope ports and adds marked ones', () => {
  const groups = [
    sampleGroup('fpA', [100, 101], [
      { name: 'wan2',  index: '0', isActive: false, admin_status: 'up', oper_status: 'up' },
      { name: 'port1', index: '1', isActive: true,  admin_status: 'up', oper_status: 'up' },
      { name: 'port2', index: '2', isActive: true,  admin_status: 'up', oper_status: 'up' },
      { name: 'port6', index: '3', isActive: false, admin_status: 'up', oper_status: 'up' }
    ])
  ];
  const decisions = new Map([['fpA', { skipped: false, addPortNames: ['wan2', 'port6'] }]]);
  const entries = buildAddQueueEntries({ groups, decisions, nameById: {}, batchId: 'b1' });
  assert.equal(entries.length, 2);
  // Kept = in-scope (port1, port2) + added (wan2, port6). Indices: 1, 2, 0, 3 → sorted by filter order:
  assert.deepEqual(entries[0].intendedAction.selectedIndices, ['0', '1', '2', '3']);
  assert.deepEqual(entries[0].addedPortNames, ['wan2', 'port6']);
  assert.equal(entries[0].intendedAction.totalPortCount, 4);
  assert.equal(entries[0].intendedAction.portSelectionType, 'manual');
});

test('buildAddQueueEntries skips groups with empty addPortNames', () => {
  const groups = [sampleGroup('fp1', [1], [{ name: 'wan2', index: '0', isActive: false }])];
  const decisions = new Map([['fp1', { skipped: false, addPortNames: [] }]]);
  const entries = buildAddQueueEntries({ groups, decisions, nameById: {}, batchId: 'b1' });
  assert.equal(entries.length, 0);
});

test('buildAddQueueEntries skips explicitly-skipped groups', () => {
  const groups = [sampleGroup('fp1', [1], [{ name: 'wan2', index: '0', isActive: false }])];
  const decisions = new Map([['fp1', { skipped: true, addPortNames: ['wan2'] }]]);
  const entries = buildAddQueueEntries({ groups, decisions, nameById: {}, batchId: 'b1' });
  assert.equal(entries.length, 0);
});

test('buildAddQueueEntries requires a batchId', () => {
  assert.throws(() => buildAddQueueEntries({
    groups: [], decisions: new Map(), batchId: ''
  }), /batchId/);
});

test('buildAddQueueEntries requires a Map for decisions', () => {
  assert.throws(() => buildAddQueueEntries({
    groups: [], decisions: {}, batchId: 'b1'
  }), /decisions/);
});

test('summarizeAddPlan aggregates by group with totalPortsToAdd', () => {
  const entries = [
    { serverId: 1, groupId: 'a', deviceName: 'd1', addedPortNames: ['wan2'] },
    { serverId: 2, groupId: 'a', deviceName: 'd2', addedPortNames: ['wan2'] },
    { serverId: 3, groupId: 'b', deviceName: 'd3', addedPortNames: ['x1', 'x2'] }
  ];
  const s = summarizeAddPlan(entries);
  assert.equal(s.totalDevices, 3);
  assert.equal(s.totalGroups, 2);
  assert.equal(s.totalPortsToAdd, 4);
});
