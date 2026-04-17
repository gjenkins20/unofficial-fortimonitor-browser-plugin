import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueueEntries, summarizePlan } from '../src/ui/plan.js';

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
