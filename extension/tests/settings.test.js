import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDevModeEnabled,
  setDevModeEnabled,
  DEV_MODE_KEY,
  isSdwanReportEnabled,
  setSdwanReportEnabled,
  SDWAN_REPORT_ENABLED_KEY,
  isTenantObservationsEnabled,
  setTenantObservationsEnabled,
  TENANT_OBSERVATIONS_ENABLED_KEY,
  LEGACY_BPA_AUDIT_ENABLED_KEY,
  isSsoConfigEnabled,
  setSsoConfigEnabled,
  SSO_CONFIG_ENABLED_KEY,
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
  DEFAULT_LMSTUDIO_URL,
  isUpdateCheckEnabled,
  setUpdateCheckEnabled,
  UPDATE_CHECK_ENABLED_KEY,
  isIntroTourEnabled,
  setIntroTourEnabled,
  INTRO_TOUR_ENABLED_KEY
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

// ---------- FMN-129: SD-WAN Report visibility flag ----------

test('isSdwanReportEnabled defaults to false on empty storage (tile hidden until opt-in)', async () => {
  const storage = createStorageMock();
  assert.equal(await isSdwanReportEnabled(storage), false);
});

test('setSdwanReportEnabled round-trips a true write', async () => {
  const storage = createStorageMock();
  await setSdwanReportEnabled(true, storage);
  assert.equal(await isSdwanReportEnabled(storage), true);
  assert.equal(storage.__raw()[SDWAN_REPORT_ENABLED_KEY], true);
  await setSdwanReportEnabled(false, storage);
  assert.equal(await isSdwanReportEnabled(storage), false);
});

test('isSdwanReportEnabled fails closed (returns false) on storage error', async () => {
  const brokenStorage = { async get() { throw new Error('storage unavailable'); } };
  assert.equal(await isSdwanReportEnabled(brokenStorage), false);
});

test('SDWAN_REPORT_ENABLED_KEY uses the sdwan-prefixed storage key', () => {
  assert.equal(SDWAN_REPORT_ENABLED_KEY, 'fm:sdwanReportEnabled');
});

// ---------- FMN-133 / FMN-145 / FMN-218: Tenant Observations visibility flag ----------

test('isTenantObservationsEnabled defaults to true on empty storage (FMN-145: visible by default)', async () => {
  const storage = createStorageMock();
  assert.equal(await isTenantObservationsEnabled(storage), true);
});

test('setTenantObservationsEnabled round-trips both true and false writes', async () => {
  const storage = createStorageMock();
  await setTenantObservationsEnabled(true, storage);
  assert.equal(await isTenantObservationsEnabled(storage), true);
  assert.equal(storage.__raw()[TENANT_OBSERVATIONS_ENABLED_KEY], true);
  await setTenantObservationsEnabled(false, storage);
  assert.equal(await isTenantObservationsEnabled(storage), false);
});

test('isTenantObservationsEnabled fails open (returns true) on storage error (FMN-145)', async () => {
  const brokenStorage = { async get() { throw new Error('storage unavailable'); } };
  assert.equal(await isTenantObservationsEnabled(brokenStorage), true);
});

test('TENANT_OBSERVATIONS_ENABLED_KEY uses the new fm:tenantObservationsEnabled storage key', () => {
  assert.equal(TENANT_OBSERVATIONS_ENABLED_KEY, 'fm:tenantObservationsEnabled');
});

test('FMN-218 migration: legacy fm:bpaAuditEnabled seeds the read when the new key is unset', async () => {
  // Operator had hidden the tile pre-rename. New key absent; legacy key present.
  const storage = createStorageMock();
  await storage.set({ [LEGACY_BPA_AUDIT_ENABLED_KEY]: false });
  assert.equal(await isTenantObservationsEnabled(storage), false);
});

test('FMN-218 migration: new key wins over the legacy key when both are set', async () => {
  const storage = createStorageMock();
  await storage.set({
    [TENANT_OBSERVATIONS_ENABLED_KEY]: true,
    [LEGACY_BPA_AUDIT_ENABLED_KEY]: false
  });
  assert.equal(await isTenantObservationsEnabled(storage), true);
});

test('FMN-218 migration: writing the new flag clears the legacy key', async () => {
  const storage = createStorageMock();
  await storage.set({ [LEGACY_BPA_AUDIT_ENABLED_KEY]: false });
  await setTenantObservationsEnabled(true, storage);
  assert.equal(storage.__raw()[TENANT_OBSERVATIONS_ENABLED_KEY], true);
  assert.equal(LEGACY_BPA_AUDIT_ENABLED_KEY in storage.__raw(), false);
});

// ---------- FMN-139: SSO Configuration visibility flag ----------

test('isSsoConfigEnabled defaults to false on empty storage (tile hidden until opt-in)', async () => {
  const storage = createStorageMock();
  assert.equal(await isSsoConfigEnabled(storage), false);
});

test('setSsoConfigEnabled round-trips a true write', async () => {
  const storage = createStorageMock();
  await setSsoConfigEnabled(true, storage);
  assert.equal(await isSsoConfigEnabled(storage), true);
  assert.equal(storage.__raw()[SSO_CONFIG_ENABLED_KEY], true);
  await setSsoConfigEnabled(false, storage);
  assert.equal(await isSsoConfigEnabled(storage), false);
});

test('isSsoConfigEnabled fails closed (returns false) on storage error', async () => {
  const brokenStorage = { async get() { throw new Error('storage unavailable'); } };
  assert.equal(await isSsoConfigEnabled(brokenStorage), false);
});

test('SSO_CONFIG_ENABLED_KEY uses the sso-prefixed storage key', () => {
  assert.equal(SSO_CONFIG_ENABLED_KEY, 'fm:ssoConfigEnabled');
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

// ---------- FMN-157: update-check flag ----------

test('isUpdateCheckEnabled defaults to true on empty storage (FMN-157)', async () => {
  const storage = createStorageMock();
  assert.equal(await isUpdateCheckEnabled(storage), true);
});

test('isUpdateCheckEnabled returns false when explicitly disabled (FMN-157)', async () => {
  const storage = createStorageMock();
  await setUpdateCheckEnabled(false, storage);
  assert.equal(await isUpdateCheckEnabled(storage), false);
  assert.equal(storage.__raw()[UPDATE_CHECK_ENABLED_KEY], false);
});

test('isUpdateCheckEnabled roundtrips a true write (FMN-157)', async () => {
  const storage = createStorageMock();
  await setUpdateCheckEnabled(true, storage);
  assert.equal(await isUpdateCheckEnabled(storage), true);
  assert.equal(storage.__raw()[UPDATE_CHECK_ENABLED_KEY], true);
});

test('isUpdateCheckEnabled fails open (returns true) on storage error (FMN-157)', async () => {
  const brokenStorage = {
    async get() { throw new Error('storage unavailable'); }
  };
  assert.equal(await isUpdateCheckEnabled(brokenStorage), true);
});

test('setUpdateCheckEnabled coerces non-boolean values to strict booleans (FMN-157)', async () => {
  const storage = createStorageMock();
  await setUpdateCheckEnabled('yes', storage);
  assert.equal(storage.__raw()[UPDATE_CHECK_ENABLED_KEY], true);
  await setUpdateCheckEnabled(0, storage);
  assert.equal(storage.__raw()[UPDATE_CHECK_ENABLED_KEY], false);
});

// ---------- FMN-240: intro-tour default-on ----------

test('isIntroTourEnabled defaults to true on empty storage (FMN-240)', async () => {
  const storage = createStorageMock();
  assert.equal(await isIntroTourEnabled(storage), true);
});

test('isIntroTourEnabled returns false when explicitly disabled (FMN-240)', async () => {
  const storage = createStorageMock();
  await setIntroTourEnabled(false, storage);
  assert.equal(await isIntroTourEnabled(storage), false);
  assert.equal(storage.__raw()[INTRO_TOUR_ENABLED_KEY], false);
});

test('isIntroTourEnabled roundtrips a true write (FMN-240)', async () => {
  const storage = createStorageMock();
  await setIntroTourEnabled(true, storage);
  assert.equal(await isIntroTourEnabled(storage), true);
  assert.equal(storage.__raw()[INTRO_TOUR_ENABLED_KEY], true);
});

test('isIntroTourEnabled fails open (returns true) on storage error (FMN-240)', async () => {
  const brokenStorage = {
    async get() { throw new Error('storage unavailable'); }
  };
  assert.equal(await isIntroTourEnabled(brokenStorage), true);
});

test('INTRO_TOUR_ENABLED_KEY uses the documented storage key', () => {
  assert.equal(INTRO_TOUR_ENABLED_KEY, 'fm:introTourEnabled');
});
