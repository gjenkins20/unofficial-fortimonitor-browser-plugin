import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDevModeEnabled,
  setDevModeEnabled,
  DEV_MODE_KEY,
  isShowFeatureBadgesEnabled,
  setShowFeatureBadgesEnabled,
  SHOW_FEATURE_BADGES_KEY,
  getAskClaudeToolTier,
  setAskClaudeToolTier,
  ASK_CLAUDE_TOOL_TIER_KEY,
  ASK_CLAUDE_TOOL_TIERS,
  DEFAULT_ASK_CLAUDE_TOOL_TIER
} from '../src/lib/settings.js';
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

test('isShowFeatureBadgesEnabled defaults to true on empty storage', async () => {
  const storage = createStorageMock();
  assert.equal(await isShowFeatureBadgesEnabled(storage), true);
});

test('isShowFeatureBadgesEnabled returns false when explicitly disabled', async () => {
  const storage = createStorageMock();
  await setShowFeatureBadgesEnabled(false, storage);
  assert.equal(await isShowFeatureBadgesEnabled(storage), false);
  assert.equal(storage.__raw()[SHOW_FEATURE_BADGES_KEY], false);
});

test('isShowFeatureBadgesEnabled roundtrips a true write', async () => {
  const storage = createStorageMock();
  await setShowFeatureBadgesEnabled(true, storage);
  assert.equal(await isShowFeatureBadgesEnabled(storage), true);
  assert.equal(storage.__raw()[SHOW_FEATURE_BADGES_KEY], true);
});

test('isShowFeatureBadgesEnabled fails open (returns true) on storage error', async () => {
  const brokenStorage = {
    async get() { throw new Error('storage unavailable'); }
  };
  assert.equal(await isShowFeatureBadgesEnabled(brokenStorage), true);
});

test('setShowFeatureBadgesEnabled coerces non-boolean values to strict booleans', async () => {
  const storage = createStorageMock();
  await setShowFeatureBadgesEnabled('yes', storage);
  assert.equal(storage.__raw()[SHOW_FEATURE_BADGES_KEY], true);
  await setShowFeatureBadgesEnabled(0, storage);
  assert.equal(storage.__raw()[SHOW_FEATURE_BADGES_KEY], false);
});

test('SHOW_FEATURE_BADGES_KEY uses the new storage key name', () => {
  assert.equal(SHOW_FEATURE_BADGES_KEY, 'fm:showFeatureBadges');
});

test('getAskClaudeToolTier defaults to readonly on empty storage (FMN-97)', async () => {
  const storage = createStorageMock();
  assert.equal(await getAskClaudeToolTier(storage), 'readonly');
  assert.equal(DEFAULT_ASK_CLAUDE_TOOL_TIER, 'readonly');
});

test('setAskClaudeToolTier round-trips each valid tier (FMN-97)', async () => {
  const storage = createStorageMock();
  for (const t of ASK_CLAUDE_TOOL_TIERS) {
    await setAskClaudeToolTier(t, storage);
    assert.equal(await getAskClaudeToolTier(storage), t);
    assert.equal(storage.__raw()[ASK_CLAUDE_TOOL_TIER_KEY], t);
  }
});

test('setAskClaudeToolTier coerces unknown values to default (FMN-97)', async () => {
  const storage = createStorageMock();
  await setAskClaudeToolTier('bogus', storage);
  assert.equal(storage.__raw()[ASK_CLAUDE_TOOL_TIER_KEY], 'readonly');
});

test('getAskClaudeToolTier ignores stored garbage and falls back to default (FMN-97)', async () => {
  const storage = createStorageMock();
  await storage.set({ [ASK_CLAUDE_TOOL_TIER_KEY]: 'something-else' });
  assert.equal(await getAskClaudeToolTier(storage), 'readonly');
});

test('getAskClaudeToolTier fails closed (returns readonly) on storage error (FMN-97)', async () => {
  const storage = {
    get: async () => { throw new Error('boom'); },
    set: async () => {}
  };
  assert.equal(await getAskClaudeToolTier(storage), 'readonly');
});
