import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDevModeEnabled, setDevModeEnabled, DEV_MODE_KEY } from '../src/lib/settings.js';
import { createStorageMock } from './fixtures/chrome-mocks.js';

test('isDevModeEnabled defaults to false on empty storage', async () => {
  const storage = createStorageMock();
  assert.equal(await isDevModeEnabled(storage), false);
});

test('setDevModeEnabled writes a boolean and isDevModeEnabled reads it back', async () => {
  const storage = createStorageMock();
  await setDevModeEnabled(true, storage);
  assert.equal(await isDevModeEnabled(storage), true);
  assert.equal(storage.__raw()[DEV_MODE_KEY], true);
  await setDevModeEnabled(false, storage);
  assert.equal(await isDevModeEnabled(storage), false);
});

test('isDevModeEnabled returns false when storage.get rejects', async () => {
  const brokenStorage = {
    async get() { throw new Error('storage unavailable'); }
  };
  assert.equal(await isDevModeEnabled(brokenStorage), false);
});

test('setDevModeEnabled coerces truthy values to strict booleans', async () => {
  const storage = createStorageMock();
  await setDevModeEnabled('yes', storage);
  assert.equal(storage.__raw()[DEV_MODE_KEY], true);
  await setDevModeEnabled(0, storage);
  assert.equal(storage.__raw()[DEV_MODE_KEY], false);
});
