// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Shared settings read/write. Currently exposes the developer-mode flag
// used to surface diagnostic fields in error UIs. Settings live in
// chrome.storage.local so all extension pages see the same value.

export const DEV_MODE_KEY = 'fm:devMode';
export const ASK_CLAUDE_ENABLED_KEY = 'fm:askClaudeEnabled';
export const ASK_CLAUDE_TOOL_TIER_KEY = 'fm:askClaudeToolTier';
export const SERVER_SEARCH_ENABLED_KEY = 'fm:serverSearchEnabled';
export const SIDEBAR_LAUNCHER_ENABLED_KEY = 'fm:sidebarLauncherEnabled';
export const SHOW_FEATURE_BADGES_KEY = 'fm:showFeatureBadges';
// FMN-129: per-tool visibility flag for the SD-WAN Report tile. Code
// merges to main; tile only renders when the operator toggles this on
// in popup -> Settings.
export const SDWAN_REPORT_ENABLED_KEY = 'fm:sdwanReportEnabled';
// FMN-133: per-tool visibility flag for the BPA Audit tile. Same Beta
// gating pattern as SD-WAN Report; the FMN-133 ticket explicitly calls
// for "Same gating as FMN-129 / FMN-130. Tile hidden when off."
export const BPA_AUDIT_ENABLED_KEY = 'fm:bpaAuditEnabled';
// FMN-139: per-tool visibility flag for the SSO Configuration tile.
// Beta-gated until FMN-138 (Discovery) lands and the FortiMonitor SSO
// save endpoint is wired up; until then the wizard supports dry-run only.
export const SSO_CONFIG_ENABLED_KEY = 'fm:ssoConfigEnabled';
// FMN-152: per-tool flag for the in-page omni-search input. When on, the
// toolkit replaces FortiMonitor's "Search Instances" input with a search
// that matches across every server field (name, fqdn, IP, description,
// tags, attributes, model, OS, agent version, group, template). Off by
// default; operator opts in via popup Settings.
export const OMNI_SEARCH_ENABLED_KEY = 'fm:omniSearchEnabled';

export const ASK_CLAUDE_TOOL_TIERS = ['readonly', 'readwrite', 'all'];
export const DEFAULT_ASK_CLAUDE_TOOL_TIER = 'readonly';

// FMN-120: provider selection for Ask Claude. 'anthropic' is the cloud
// default; 'ollama' and 'lmstudio' are local-network OpenAI-compatible
// targets. The wire format for the two locals is identical (POST
// /v1/chat/completions); the choice is mostly UX + per-provider default
// URL/model.
export const ASK_CLAUDE_PROVIDER_KEY = 'fm:askClaudeProvider';
export const ASK_CLAUDE_PROVIDERS = ['anthropic', 'ollama', 'lmstudio'];
export const DEFAULT_ASK_CLAUDE_PROVIDER = 'anthropic';

// Per-provider URL/model/key. Keys are stored separately so switching
// providers preserves prior settings (operator can flip between Ollama
// and LM Studio without re-typing URLs).
export const ASK_CLAUDE_OLLAMA_URL_KEY = 'fm:askClaudeOllamaUrl';
export const ASK_CLAUDE_OLLAMA_MODEL_KEY = 'fm:askClaudeOllamaModel';
export const ASK_CLAUDE_OLLAMA_API_KEY_KEY = 'fm:askClaudeOllamaApiKey';
export const ASK_CLAUDE_LMSTUDIO_URL_KEY = 'fm:askClaudeLmStudioUrl';
export const ASK_CLAUDE_LMSTUDIO_MODEL_KEY = 'fm:askClaudeLmStudioModel';
export const ASK_CLAUDE_LMSTUDIO_API_KEY_KEY = 'fm:askClaudeLmStudioApiKey';

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434/v1';
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5';
export const DEFAULT_LMSTUDIO_URL = 'http://localhost:1234/v1';
export const DEFAULT_LMSTUDIO_MODEL = '';

const PROVIDER_FIELDS = {
  ollama: {
    urlKey: ASK_CLAUDE_OLLAMA_URL_KEY,
    modelKey: ASK_CLAUDE_OLLAMA_MODEL_KEY,
    apiKeyKey: ASK_CLAUDE_OLLAMA_API_KEY_KEY,
    defaultUrl: DEFAULT_OLLAMA_URL,
    defaultModel: DEFAULT_OLLAMA_MODEL
  },
  lmstudio: {
    urlKey: ASK_CLAUDE_LMSTUDIO_URL_KEY,
    modelKey: ASK_CLAUDE_LMSTUDIO_MODEL_KEY,
    apiKeyKey: ASK_CLAUDE_LMSTUDIO_API_KEY_KEY,
    defaultUrl: DEFAULT_LMSTUDIO_URL,
    defaultModel: DEFAULT_LMSTUDIO_MODEL
  }
};

/**
 * Read the developer-mode flag. Returns false on any storage error so
 * diagnostic surfaces stay hidden by default - we never want to leak
 * URLs or body previews to normal operators.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function isDevModeEnabled(storage = defaultStorage()) {
  try {
    const data = await storage.get(DEV_MODE_KEY);
    return Boolean(data?.[DEV_MODE_KEY]);
  } catch {
    return false;
  }
}

/**
 * Persist the developer-mode flag.
 *
 * @param {boolean} enabled
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setDevModeEnabled(enabled, storage = defaultStorage()) {
  await storage.set({ [DEV_MODE_KEY]: Boolean(enabled) });
}

/**
 * Read the Ask-Claude-enabled flag. Shown by default now that the tool
 * has graduated from prototype: returns true when the setting is absent,
 * only false when the operator has explicitly toggled it off. Storage
 * errors fail open (return true) so a transient storage blip never hides
 * a tool the operator expects to see.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function isAskClaudeEnabled(storage = defaultStorage()) {
  try {
    const data = await storage.get(ASK_CLAUDE_ENABLED_KEY);
    const value = data?.[ASK_CLAUDE_ENABLED_KEY];
    return value === undefined ? true : Boolean(value);
  } catch {
    return true;
  }
}

/**
 * Persist the Ask-Claude-enabled flag.
 *
 * @param {boolean} enabled
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setAskClaudeEnabled(enabled, storage = defaultStorage()) {
  await storage.set({ [ASK_CLAUDE_ENABLED_KEY]: Boolean(enabled) });
}

/**
 * Read the Ask-Claude tool-tier setting. Three positions:
 *   'readonly'  - default. Only GET tools are sent to Claude per turn.
 *   'readwrite' - GET + write tools. Acknowledge_outage and other
 *                 mutations become callable when the user explicitly asks.
 *   'all'       - everything, including 260+ codegen tools. Bigger prompt,
 *                 more tokens per turn.
 *
 * Storage errors fail closed (return 'readonly') so a transient blip
 * never silently widens the catalog the operator hasn't opted into.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function getAskClaudeToolTier(storage = defaultStorage()) {
  try {
    const data = await storage.get(ASK_CLAUDE_TOOL_TIER_KEY);
    const value = data?.[ASK_CLAUDE_TOOL_TIER_KEY];
    if (ASK_CLAUDE_TOOL_TIERS.includes(value)) return value;
    return DEFAULT_ASK_CLAUDE_TOOL_TIER;
  } catch {
    return DEFAULT_ASK_CLAUDE_TOOL_TIER;
  }
}

/**
 * Persist the Ask-Claude tool-tier setting. Validates the value against
 * the allowed list - unknown values fall back to the default rather than
 * being written through.
 *
 * @param {string} tier
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setAskClaudeToolTier(tier, storage = defaultStorage()) {
  const value = ASK_CLAUDE_TOOL_TIERS.includes(tier) ? tier : DEFAULT_ASK_CLAUDE_TOOL_TIER;
  await storage.set({ [ASK_CLAUDE_TOOL_TIER_KEY]: value });
}

/**
 * Read the Search-Servers-enabled flag. Returns false by default so the
 * tool stays hidden until the operator opts in via Settings.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function isServerSearchEnabled(storage = defaultStorage()) {
  try {
    const data = await storage.get(SERVER_SEARCH_ENABLED_KEY);
    return Boolean(data?.[SERVER_SEARCH_ENABLED_KEY]);
  } catch {
    return false;
  }
}

/**
 * Persist the Search-Servers-enabled flag.
 *
 * @param {boolean} enabled
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setServerSearchEnabled(enabled, storage = defaultStorage()) {
  await storage.set({ [SERVER_SEARCH_ENABLED_KEY]: Boolean(enabled) });
}

/**
 * Read the SD-WAN-Report-enabled flag. Returns false by default so the
 * tile stays hidden until the operator opts in via Settings. Storage
 * errors fail closed so a transient blip never silently surfaces a
 * tool the operator hasn't asked for.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function isSdwanReportEnabled(storage = defaultStorage()) {
  try {
    const data = await storage.get(SDWAN_REPORT_ENABLED_KEY);
    return Boolean(data?.[SDWAN_REPORT_ENABLED_KEY]);
  } catch {
    return false;
  }
}

/**
 * Persist the SD-WAN-Report-enabled flag.
 *
 * @param {boolean} enabled
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setSdwanReportEnabled(enabled, storage = defaultStorage()) {
  await storage.set({ [SDWAN_REPORT_ENABLED_KEY]: Boolean(enabled) });
}

/**
 * Read the BPA-Audit-enabled flag. Defaults to true (FMN-145) since the
 * Best-Practice Assessment is no longer Beta-gated; the toggle remains
 * available so operators can hide the tile on shared installs. Storage
 * errors fail open to the default (visible).
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function isBpaAuditEnabled(storage = defaultStorage()) {
  try {
    const data = await storage.get(BPA_AUDIT_ENABLED_KEY);
    const v = data?.[BPA_AUDIT_ENABLED_KEY];
    return v === undefined ? true : Boolean(v);
  } catch {
    return true;
  }
}

/**
 * Persist the BPA-Audit-enabled flag.
 *
 * @param {boolean} enabled
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setBpaAuditEnabled(enabled, storage = defaultStorage()) {
  await storage.set({ [BPA_AUDIT_ENABLED_KEY]: Boolean(enabled) });
}

/**
 * Read the SSO-Configuration-enabled flag (FMN-139). Returns false by
 * default so the tile stays hidden until the operator opts in via
 * Settings. Storage errors fail closed so a transient blip never silently
 * surfaces a tool the operator hasn't asked for.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function isSsoConfigEnabled(storage = defaultStorage()) {
  try {
    const data = await storage.get(SSO_CONFIG_ENABLED_KEY);
    return Boolean(data?.[SSO_CONFIG_ENABLED_KEY]);
  } catch {
    return false;
  }
}

/**
 * Persist the SSO-Configuration-enabled flag.
 *
 * @param {boolean} enabled
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setSsoConfigEnabled(enabled, storage = defaultStorage()) {
  await storage.set({ [SSO_CONFIG_ENABLED_KEY]: Boolean(enabled) });
}

/**
 * Read the sidebar-launcher-enabled flag. Returns false by default so the
 * FM Toolkit entry stays out of FortiMonitor's left sidebar until the
 * operator opts in via Settings. Storage errors fail closed (return false)
 * so a transient storage blip never injects unsolicited UI.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function isSidebarLauncherEnabled(storage = defaultStorage()) {
  try {
    const data = await storage.get(SIDEBAR_LAUNCHER_ENABLED_KEY);
    return Boolean(data?.[SIDEBAR_LAUNCHER_ENABLED_KEY]);
  } catch {
    return false;
  }
}

/**
 * Persist the sidebar-launcher-enabled flag.
 *
 * @param {boolean} enabled
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setSidebarLauncherEnabled(enabled, storage = defaultStorage()) {
  await storage.set({ [SIDEBAR_LAUNCHER_ENABLED_KEY]: Boolean(enabled) });
}

/**
 * Read the FMN-152 omni-search-enabled flag. Off by default: a fresh
 * install leaves FortiMonitor's native "Search Instances" untouched.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function isOmniSearchEnabled(storage = defaultStorage()) {
  try {
    const data = await storage.get(OMNI_SEARCH_ENABLED_KEY);
    return Boolean(data?.[OMNI_SEARCH_ENABLED_KEY]);
  } catch {
    return false;
  }
}

/**
 * Persist the FMN-152 omni-search-enabled flag.
 *
 * @param {boolean} enabled
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setOmniSearchEnabled(enabled, storage = defaultStorage()) {
  await storage.set({ [OMNI_SEARCH_ENABLED_KEY]: Boolean(enabled) });
}

/**
 * Read the show-feature-badges flag. Defaults true (a fresh install shows the
 * "FM Toolkit" attribution ribbon on each visible UI feature this extension
 * adds to FortiMonitor pages); only false when the operator has explicitly
 * toggled it off. Storage errors fail open (return true) so a transient
 * storage blip never silently suppresses attribution.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function isShowFeatureBadgesEnabled(storage = defaultStorage()) {
  try {
    const data = await storage.get(SHOW_FEATURE_BADGES_KEY);
    const value = data?.[SHOW_FEATURE_BADGES_KEY];
    return value === undefined ? true : Boolean(value);
  } catch {
    return true;
  }
}

/**
 * Persist the show-feature-badges flag.
 *
 * @param {boolean} enabled
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setShowFeatureBadgesEnabled(enabled, storage = defaultStorage()) {
  await storage.set({ [SHOW_FEATURE_BADGES_KEY]: Boolean(enabled) });
}

/**
 * Read the Ask-Claude provider selection. Three values:
 *   'anthropic' - default. Calls api.anthropic.com directly.
 *   'ollama'    - local Ollama server, OpenAI-compatible API.
 *   'lmstudio'  - LM Studio local server, OpenAI-compatible API.
 *
 * Storage errors fail closed (return 'anthropic') so a transient blip
 * never silently routes a turn to an unconfigured local URL.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function getAskClaudeProvider(storage = defaultStorage()) {
  try {
    const data = await storage.get(ASK_CLAUDE_PROVIDER_KEY);
    const value = data?.[ASK_CLAUDE_PROVIDER_KEY];
    if (ASK_CLAUDE_PROVIDERS.includes(value)) return value;
    return DEFAULT_ASK_CLAUDE_PROVIDER;
  } catch {
    return DEFAULT_ASK_CLAUDE_PROVIDER;
  }
}

/**
 * Persist the Ask-Claude provider selection. Unknown values fall back
 * to the default rather than being written through.
 *
 * @param {string} provider
 * @param {{ set: (obj: Record<string, any>) => Promise<void> }} [storage]
 */
export async function setAskClaudeProvider(provider, storage = defaultStorage()) {
  const value = ASK_CLAUDE_PROVIDERS.includes(provider) ? provider : DEFAULT_ASK_CLAUDE_PROVIDER;
  await storage.set({ [ASK_CLAUDE_PROVIDER_KEY]: value });
}

/**
 * Read the per-provider OpenAI-compat config (URL + model + optional
 * API key). Returns the configured value, or the provider's default if
 * unset. URL is normalized to remove a trailing slash so the client can
 * append /chat/completions or /models without double-slashing.
 *
 * @param {'ollama' | 'lmstudio'} provider
 * @param {{ get: (key: string) => Promise<Record<string, any>> }} [storage]
 */
export async function getAskClaudeProviderConfig(provider, storage = defaultStorage()) {
  const fields = PROVIDER_FIELDS[provider];
  if (!fields) {
    throw new Error(`getAskClaudeProviderConfig: unknown provider "${provider}"`);
  }
  try {
    const data = await storage.get([fields.urlKey, fields.modelKey, fields.apiKeyKey]);
    const url = typeof data?.[fields.urlKey] === 'string' && data[fields.urlKey].trim()
      ? data[fields.urlKey].trim().replace(/\/+$/, '')
      : fields.defaultUrl.replace(/\/+$/, '');
    const model = typeof data?.[fields.modelKey] === 'string' && data[fields.modelKey].trim()
      ? data[fields.modelKey].trim()
      : fields.defaultModel;
    const apiKey = typeof data?.[fields.apiKeyKey] === 'string' && data[fields.apiKeyKey]
      ? data[fields.apiKeyKey]
      : '';
    return { url, model, apiKey };
  } catch {
    return {
      url: fields.defaultUrl.replace(/\/+$/, ''),
      model: fields.defaultModel,
      apiKey: ''
    };
  }
}

/**
 * Persist per-provider OpenAI-compat config. Pass `null` for any field
 * to clear it (falls back to the provider default on next read). Empty
 * strings are treated the same as null.
 *
 * @param {'ollama' | 'lmstudio'} provider
 * @param {{ url?: string|null, model?: string|null, apiKey?: string|null }} config
 * @param {{ set, remove }} [storage]
 */
export async function setAskClaudeProviderConfig(provider, config, storage = defaultStorage()) {
  const fields = PROVIDER_FIELDS[provider];
  if (!fields) {
    throw new Error(`setAskClaudeProviderConfig: unknown provider "${provider}"`);
  }
  const writes = {};
  const removes = [];
  if ('url' in config) {
    if (config.url) writes[fields.urlKey] = String(config.url).trim();
    else removes.push(fields.urlKey);
  }
  if ('model' in config) {
    if (config.model) writes[fields.modelKey] = String(config.model).trim();
    else removes.push(fields.modelKey);
  }
  if ('apiKey' in config) {
    if (config.apiKey) writes[fields.apiKeyKey] = String(config.apiKey);
    else removes.push(fields.apiKeyKey);
  }
  if (Object.keys(writes).length > 0) await storage.set(writes);
  if (removes.length > 0 && typeof storage.remove === 'function') {
    await storage.remove(removes);
  }
}

function defaultStorage() {
  // eslint-disable-next-line no-undef
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) return chrome.storage.local;
  throw new Error('settings: chrome.storage.local is not available and no storage adapter was provided');
}
