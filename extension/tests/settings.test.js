import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDevModeEnabled,
  setDevModeEnabled,
  DEV_MODE_KEY,
  isBpaBetaEnabled,
  setBpaBetaEnabled,
  BPA_BETA_ENABLED_KEY,
  isShowFeatureBadgesEnabled,
  setShowFeatureBadgesEnabled,
  SHOW_FEATURE_BADGES_KEY,
  getAskClaudeToolTier,
  setAskClaudeToolTier,
  ASK_CLAUDE_TOOL_TIER_KEY,
  ASK_CLAUDE_TOOL_TIERS,
  DEFAULT_ASK_CLAUDE_TOOL_TIER,
  getAskClaudeProvider,
  setAskClaudeProvider,
  getAskClaudeProviderConfig,
  setAskClaudeProviderConfig,
  ASK_CLAUDE_PROVIDER_KEY,
  ASK_CLAUDE_PROVIDERS,
  DEFAULT_ASK_CLAUDE_PROVIDER,
  ASK_CLAUDE_OLLAMA_URL_KEY,
  ASK_CLAUDE_OLLAMA_MODEL_KEY,
  ASK_CLAUDE_OLLAMA_API_KEY_KEY,
  ASK_CLAUDE_LMSTUDIO_URL_KEY,
  DEFAULT_OLLAMA_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_LMSTUDIO_URL
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

// ---------- FMN-128 / FMN-129: BPA Beta flag ----------

test('isBpaBetaEnabled defaults to false on empty storage (BPA tools hidden until opt-in)', async () => {
  const storage = createStorageMock();
  assert.equal(await isBpaBetaEnabled(storage), false);
});

test('setBpaBetaEnabled round-trips a true write', async () => {
  const storage = createStorageMock();
  await setBpaBetaEnabled(true, storage);
  assert.equal(await isBpaBetaEnabled(storage), true);
  assert.equal(storage.__raw()[BPA_BETA_ENABLED_KEY], true);
  await setBpaBetaEnabled(false, storage);
  assert.equal(await isBpaBetaEnabled(storage), false);
});

test('isBpaBetaEnabled fails closed (returns false) on storage error', async () => {
  const brokenStorage = { async get() { throw new Error('storage unavailable'); } };
  assert.equal(await isBpaBetaEnabled(brokenStorage), false);
});

test('BPA_BETA_ENABLED_KEY uses the bpa-prefixed storage key', () => {
  assert.equal(BPA_BETA_ENABLED_KEY, 'fm:bpaBetaEnabled');
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

// ---------- FMN-120: provider selection ----------

test('getAskClaudeProvider defaults to anthropic on empty storage (FMN-120)', async () => {
  const storage = createStorageMock();
  assert.equal(await getAskClaudeProvider(storage), 'anthropic');
  assert.equal(DEFAULT_ASK_CLAUDE_PROVIDER, 'anthropic');
});

test('setAskClaudeProvider round-trips each valid provider (FMN-120)', async () => {
  const storage = createStorageMock();
  for (const p of ASK_CLAUDE_PROVIDERS) {
    await setAskClaudeProvider(p, storage);
    assert.equal(await getAskClaudeProvider(storage), p);
    assert.equal(storage.__raw()[ASK_CLAUDE_PROVIDER_KEY], p);
  }
});

test('setAskClaudeProvider coerces unknown values to default (FMN-120)', async () => {
  const storage = createStorageMock();
  await setAskClaudeProvider('openai', storage);
  assert.equal(storage.__raw()[ASK_CLAUDE_PROVIDER_KEY], 'anthropic');
});

test('getAskClaudeProvider ignores stored garbage and falls back to default (FMN-120)', async () => {
  const storage = createStorageMock();
  await storage.set({ [ASK_CLAUDE_PROVIDER_KEY]: 'something-else' });
  assert.equal(await getAskClaudeProvider(storage), 'anthropic');
});

test('getAskClaudeProvider fails closed (returns anthropic) on storage error (FMN-120)', async () => {
  const storage = {
    get: async () => { throw new Error('boom'); },
    set: async () => {}
  };
  assert.equal(await getAskClaudeProvider(storage), 'anthropic');
});

// ---------- FMN-120: per-provider URL/model/key ----------

test('getAskClaudeProviderConfig returns provider defaults on empty storage (FMN-120)', async () => {
  const storage = createStorageMock();
  const ollama = await getAskClaudeProviderConfig('ollama', storage);
  assert.equal(ollama.url, DEFAULT_OLLAMA_URL.replace(/\/+$/, ''));
  assert.equal(ollama.model, DEFAULT_OLLAMA_MODEL);
  assert.equal(ollama.apiKey, '');
  const lms = await getAskClaudeProviderConfig('lmstudio', storage);
  assert.equal(lms.url, DEFAULT_LMSTUDIO_URL.replace(/\/+$/, ''));
});

test('setAskClaudeProviderConfig persists URL/model/apiKey and round-trips (FMN-120)', async () => {
  const storage = createStorageMock();
  await setAskClaudeProviderConfig('ollama', {
    url: 'http://10.0.0.5:11434/v1',
    model: 'qwen2.5:7b',
    apiKey: 'shh'
  }, storage);
  const cfg = await getAskClaudeProviderConfig('ollama', storage);
  assert.equal(cfg.url, 'http://10.0.0.5:11434/v1');
  assert.equal(cfg.model, 'qwen2.5:7b');
  assert.equal(cfg.apiKey, 'shh');
  assert.equal(storage.__raw()[ASK_CLAUDE_OLLAMA_URL_KEY], 'http://10.0.0.5:11434/v1');
  assert.equal(storage.__raw()[ASK_CLAUDE_OLLAMA_MODEL_KEY], 'qwen2.5:7b');
  assert.equal(storage.__raw()[ASK_CLAUDE_OLLAMA_API_KEY_KEY], 'shh');
});

test('setAskClaudeProviderConfig leaves untouched fields alone (FMN-120)', async () => {
  const storage = createStorageMock();
  await setAskClaudeProviderConfig('ollama', { url: 'http://a/v1', model: 'm', apiKey: 'k' }, storage);
  // Only update the model; URL and apiKey should stay.
  await setAskClaudeProviderConfig('ollama', { model: 'm2' }, storage);
  const cfg = await getAskClaudeProviderConfig('ollama', storage);
  assert.equal(cfg.url, 'http://a/v1');
  assert.equal(cfg.model, 'm2');
  assert.equal(cfg.apiKey, 'k');
});

test('setAskClaudeProviderConfig clears a field when passed an empty value (FMN-120)', async () => {
  const storage = createStorageMock();
  await setAskClaudeProviderConfig('ollama', { url: 'http://a/v1', model: 'm', apiKey: 'k' }, storage);
  await setAskClaudeProviderConfig('ollama', { apiKey: '' }, storage);
  const cfg = await getAskClaudeProviderConfig('ollama', storage);
  assert.equal(cfg.apiKey, '');
  // URL and model still stored.
  assert.equal(cfg.url, 'http://a/v1');
});

test('getAskClaudeProviderConfig strips trailing slashes from URL (FMN-120)', async () => {
  const storage = createStorageMock();
  await setAskClaudeProviderConfig('ollama', { url: 'http://localhost:11434/v1////' }, storage);
  const cfg = await getAskClaudeProviderConfig('ollama', storage);
  assert.equal(cfg.url, 'http://localhost:11434/v1');
});

test('getAskClaudeProviderConfig falls back to defaults when stored values are blank (FMN-120)', async () => {
  const storage = createStorageMock();
  await storage.set({
    [ASK_CLAUDE_OLLAMA_URL_KEY]: '   ',
    [ASK_CLAUDE_OLLAMA_MODEL_KEY]: ''
  });
  const cfg = await getAskClaudeProviderConfig('ollama', storage);
  assert.equal(cfg.url, DEFAULT_OLLAMA_URL.replace(/\/+$/, ''));
  assert.equal(cfg.model, DEFAULT_OLLAMA_MODEL);
});

test('getAskClaudeProviderConfig throws for unknown provider (FMN-120)', async () => {
  const storage = createStorageMock();
  await assert.rejects(
    getAskClaudeProviderConfig('anthropic', storage),
    /unknown provider/
  );
});

test('setAskClaudeProviderConfig throws for unknown provider (FMN-120)', async () => {
  const storage = createStorageMock();
  await assert.rejects(
    setAskClaudeProviderConfig('anthropic', { url: 'x' }, storage),
    /unknown provider/
  );
});

test('getAskClaudeProviderConfig fails closed to provider defaults on storage error (FMN-120)', async () => {
  const storage = {
    get: async () => { throw new Error('boom'); }
  };
  const cfg = await getAskClaudeProviderConfig('lmstudio', storage);
  assert.equal(cfg.url, DEFAULT_LMSTUDIO_URL.replace(/\/+$/, ''));
});
