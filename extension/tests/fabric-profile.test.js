import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFabricProfile,
  profileKey,
  parseProfileKey,
  CONNECTION_TYPE_FABRIC,
  PROFILE_KEY_SEPARATOR
} from '../src/lib/fabric-profile.js';

// =====================================================================
// profileKey / parseProfileKey roundtrip
// =====================================================================

test('profileKey joins make/model/connection with the canonical separator', () => {
  const key = profileKey('FortiGate', 'FGVMA6', 'Fabric');
  assert.equal(key, `FortiGate${PROFILE_KEY_SEPARATOR}FGVMA6${PROFILE_KEY_SEPARATOR}Fabric`);
});

test('parseProfileKey is the inverse of profileKey', () => {
  const parsed = parseProfileKey(profileKey('FortiSwitch', 'FS-148F', 'Fabric'));
  assert.deepEqual(parsed, { make: 'FortiSwitch', model: 'FS-148F', connection_type: 'Fabric' });
});

test('parseProfileKey returns null on malformed input', () => {
  assert.equal(parseProfileKey('not-a-profile-key'), null);
  assert.equal(parseProfileKey('only::two'), null);
  assert.equal(parseProfileKey(''), null);
  assert.equal(parseProfileKey(null), null);
  assert.equal(parseProfileKey(undefined), null);
});

// =====================================================================
// buildFabricProfile - happy paths
// =====================================================================

test('classifies a single Fabric device into one profile', () => {
  const servers = [{ id: 42024061 }];
  const fsd = {
    42024061: { model_name: 'FortiGate', model_number: 'FGVMA6', os_version: 'v7.6.3 build3510' }
  };
  const out = buildFabricProfile(servers, fsd);
  assert.equal(out.profiles.size, 1);
  assert.equal(out.unclassified.length, 0);
  const p = out.profiles.get(profileKey('FortiGate', 'FGVMA6', CONNECTION_TYPE_FABRIC));
  assert.ok(p);
  assert.equal(p.make, 'FortiGate');
  assert.equal(p.model, 'FGVMA6');
  assert.equal(p.connection_type, 'Fabric');
  assert.deepEqual(p.server_ids, [42024061]);
  assert.deepEqual(p.os_versions, ['v7.6.3 build3510']);
});

test('groups same-model devices into one profile, distinguishes different models', () => {
  const servers = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const fsd = {
    1: { model_name: 'FortiGate', model_number: 'FG-100F', os_version: 'v7.4.1' },
    2: { model_name: 'FortiGate', model_number: 'FG-100F', os_version: 'v7.4.2' },
    3: { model_name: 'FortiGate', model_number: 'FG-200F', os_version: 'v7.4.1' }
  };
  const out = buildFabricProfile(servers, fsd);
  assert.equal(out.profiles.size, 2);
  const fg100 = out.profiles.get(profileKey('FortiGate', 'FG-100F', CONNECTION_TYPE_FABRIC));
  const fg200 = out.profiles.get(profileKey('FortiGate', 'FG-200F', CONNECTION_TYPE_FABRIC));
  assert.deepEqual(fg100.server_ids, [1, 2]);
  assert.deepEqual(fg100.os_versions, ['v7.4.1', 'v7.4.2']);
  assert.deepEqual(fg200.server_ids, [3]);
});

test('separates devices by make and by model', () => {
  const servers = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const fsd = {
    1: { model_name: 'FortiGate', model_number: 'FGVMA6' },
    2: { model_name: 'FortiSwitch', model_number: 'FS-148F' },
    3: { model_name: 'FortiAP', model_number: 'FAP-431F' }
  };
  const out = buildFabricProfile(servers, fsd);
  assert.equal(out.profiles.size, 3);
  assert.ok(out.profiles.has(profileKey('FortiGate', 'FGVMA6', 'Fabric')));
  assert.ok(out.profiles.has(profileKey('FortiSwitch', 'FS-148F', 'Fabric')));
  assert.ok(out.profiles.has(profileKey('FortiAP', 'FAP-431F', 'Fabric')));
});

test('extracts server id from /v2/server url fallback', () => {
  const servers = [{ url: 'https://api2.panopta.com/v2/server/42024060/' }];
  const fsd = { 42024060: { model_name: 'FortiGate', model_number: 'FGVMA6' } };
  const out = buildFabricProfile(servers, fsd);
  assert.equal(out.profiles.size, 1);
});

test('accepts fabricSystemData lookup as Map or plain object', () => {
  const servers = [{ id: 1 }];
  const fsd = { model_name: 'FortiGate', model_number: 'FGVMA6' };
  const fromObj = buildFabricProfile(servers, { 1: fsd });
  const fromMap = buildFabricProfile(servers, new Map([[1, fsd]]));
  assert.equal(fromObj.profiles.size, 1);
  assert.equal(fromMap.profiles.size, 1);
});

// =====================================================================
// buildFabricProfile - unclassified paths
// =====================================================================

test('flags server missing id as unclassified', () => {
  const out = buildFabricProfile([{ name: 'orphan' }], {});
  assert.equal(out.profiles.size, 0);
  assert.equal(out.unclassified.length, 1);
  assert.match(out.unclassified[0].reason, /server id/);
});

test('flags server lacking fabricSystemData as unclassified', () => {
  const out = buildFabricProfile([{ id: 999 }], {});
  assert.equal(out.profiles.size, 0);
  assert.equal(out.unclassified.length, 1);
  assert.match(out.unclassified[0].reason, /fabricSystemData/);
});

test('flags server with partial fabricSystemData as unclassified', () => {
  const noMake = buildFabricProfile([{ id: 1 }], { 1: { model_number: 'X' } });
  const noModel = buildFabricProfile([{ id: 2 }], { 2: { model_name: 'FortiGate' } });
  assert.equal(noMake.unclassified.length, 1);
  assert.equal(noModel.unclassified.length, 1);
});

test('handles mix of classified and unclassified servers', () => {
  const servers = [{ id: 1 }, { id: 2 }, { id: 3 }, { name: 'no-id' }];
  const fsd = {
    1: { model_name: 'FortiGate', model_number: 'FGVMA6' },
    // 2 has no fabricSystemData (non-Fabric / not yet fetched)
    3: { model_name: 'FortiGate', model_number: 'FGVMA6' }
  };
  const out = buildFabricProfile(servers, fsd);
  assert.equal(out.profiles.size, 1);
  const p = out.profiles.get(profileKey('FortiGate', 'FGVMA6', 'Fabric'));
  assert.deepEqual(p.server_ids, [1, 3]);
  assert.equal(out.unclassified.length, 2);
});

test('returns empty profile on null/empty inputs', () => {
  const empty = buildFabricProfile([], {});
  assert.equal(empty.profiles.size, 0);
  assert.equal(empty.unclassified.length, 0);

  const nullish = buildFabricProfile(null, null);
  assert.equal(nullish.profiles.size, 0);
});

test('trims whitespace from fabricSystemData fields', () => {
  const out = buildFabricProfile([{ id: 1 }], {
    1: { model_name: '  FortiGate ', model_number: ' FGVMA6  ', os_version: ' v7.6.3 ' }
  });
  const p = out.profiles.get(profileKey('FortiGate', 'FGVMA6', 'Fabric'));
  assert.ok(p);
  assert.deepEqual(p.os_versions, ['v7.6.3']);
});
