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

export const ASK_CLAUDE_TOOL_TIERS = ['readonly', 'readwrite', 'all'];
export const DEFAULT_ASK_CLAUDE_TOOL_TIER = 'readonly';

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

function defaultStorage() {
  // eslint-disable-next-line no-undef
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) return chrome.storage.local;
  throw new Error('settings: chrome.storage.local is not available and no storage adapter was provided');
}
