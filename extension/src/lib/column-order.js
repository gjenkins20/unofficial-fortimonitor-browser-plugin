// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-72 / FMN-73: per-augmentation column order + visibility.
//
// One source of truth for the column registry across the popup Settings UI
// and the in-page content script. The popup imports this module directly;
// the content script (src/content/augment.js) is a non-module IIFE and
// inlines the storage shape - keep both in sync.
//
// Storage shape (chrome.storage.local):
//   "fm:webguiColumns": {
//     "<augmentation-id>": [ { id, hidden }, ... ]
//   }

export const WEBGUI_COLUMNS_KEY = 'fm:webguiColumns';

export const COLUMN_REGISTRY = {
  'instances-ip-dns-columns': {
    label: 'Instances list',
    context: '/report/ListServers',
    columns: [
      { id: 'instance',    label: 'Instance',   lockedVisible: true  },
      { id: 'ip',          label: 'IP Address', lockedVisible: false },
      { id: 'dns',         label: 'DNS Name',   lockedVisible: false },
      { id: 'type',        label: 'Type',       lockedVisible: false },
      { id: 'model',       label: 'Model',      lockedVisible: false },
      { id: 'modelNumber', label: 'Model #',    lockedVisible: false },
      { id: 'os',          label: 'OS',         lockedVisible: false },
    ],
  },
  // FMN-123: hide/show for FortiMonitor's native DataTables columns on
  // /report/ListServers. Reorder is intentionally NOT supported here; it is
  // gated on the FMN-122 ColReorder probe outcome. Columns are matched in
  // the live DOM by header text (matchText). Empty-header columns
  // (checkbox, status icon, filler) are intentionally omitted.
  'instances-list-native': {
    label: 'Instances list (native columns)',
    context: '/report/ListServers',
    reorderable: false,
    columns: [
      { id: 'instance',      label: 'Instance',         lockedVisible: true,  matchText: 'Instance'         },
      { id: 'parentGroup',   label: 'Parent Group',     lockedVisible: false, matchText: 'Parent Group'     },
      { id: 'alertTimeline', label: 'Alert Timeline',   lockedVisible: false, matchText: 'Alert Timeline'   },
      { id: 'tags',          label: 'Tags',             lockedVisible: false, matchText: 'Tags'             },
      { id: 'agentVersion',  label: 'Agent Version',    lockedVisible: false, matchText: 'Agent Version'    },
      { id: 'heartbeat',     label: 'Device Heartbeat', lockedVisible: false, matchText: 'Device Heartbeat' },
    ],
  },
};

export function listAugmentations() {
  return Object.entries(COLUMN_REGISTRY).map(([id, def]) => ({
    id,
    label: def.label,
    context: def.context,
    reorderable: def.reorderable !== false,
    columns: def.columns.slice(),
  }));
}

export function getRegistry(augId) {
  return COLUMN_REGISTRY[augId] || null;
}

export function defaultOrder(augId) {
  const reg = getRegistry(augId);
  if (!reg) return [];
  return reg.columns.map((c) => ({ id: c.id, hidden: false }));
}

// Normalize a persisted list against the registry. Always returns a full,
// valid list: every registry id appears exactly once, unknown ids are
// dropped, missing ids are appended in registry order, locked-visible
// columns are forced to hidden=false.
export function normalize(augId, persisted) {
  const reg = getRegistry(augId);
  if (!reg) return [];
  const known = new Map(reg.columns.map((c) => [c.id, c]));
  const seen = new Set();
  const out = [];

  if (Array.isArray(persisted)) {
    for (const entry of persisted) {
      if (!entry || typeof entry.id !== 'string') continue;
      const meta = known.get(entry.id);
      if (!meta) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push({
        id: entry.id,
        hidden: meta.lockedVisible ? false : Boolean(entry.hidden),
      });
    }
  }

  for (const c of reg.columns) {
    if (seen.has(c.id)) continue;
    out.push({ id: c.id, hidden: false });
  }

  return out;
}

export async function getColumnOrder(augId, storage = defaultStorage()) {
  try {
    const data = await storage.get(WEBGUI_COLUMNS_KEY);
    const all = data?.[WEBGUI_COLUMNS_KEY] || {};
    return normalize(augId, all[augId]);
  } catch {
    return defaultOrder(augId);
  }
}

export async function getAllColumnOrders(storage = defaultStorage()) {
  const out = {};
  let raw = {};
  try {
    const data = await storage.get(WEBGUI_COLUMNS_KEY);
    raw = data?.[WEBGUI_COLUMNS_KEY] || {};
  } catch {
    raw = {};
  }
  for (const augId of Object.keys(COLUMN_REGISTRY)) {
    out[augId] = normalize(augId, raw[augId]);
  }
  return out;
}

export async function setColumnOrder(augId, list, storage = defaultStorage()) {
  if (!getRegistry(augId)) return;
  const normalized = normalize(augId, list);
  let current = {};
  try {
    const data = await storage.get(WEBGUI_COLUMNS_KEY);
    current = data?.[WEBGUI_COLUMNS_KEY] || {};
  } catch {
    current = {};
  }
  const next = { ...current, [augId]: normalized };
  await storage.set({ [WEBGUI_COLUMNS_KEY]: next });
}

export async function resetColumnOrder(augId, storage = defaultStorage()) {
  if (!getRegistry(augId)) return;
  let current = {};
  try {
    const data = await storage.get(WEBGUI_COLUMNS_KEY);
    current = data?.[WEBGUI_COLUMNS_KEY] || {};
  } catch {
    current = {};
  }
  if (!Object.prototype.hasOwnProperty.call(current, augId)) return;
  const next = { ...current };
  delete next[augId];
  await storage.set({ [WEBGUI_COLUMNS_KEY]: next });
}

// Subscribe to persisted-order changes. Fires fn(newList) whenever the slot
// for augId is added/removed/changed. Returns an unsubscribe function.
export function subscribeColumnOrder(augId, fn, onChanged = defaultOnChanged()) {
  if (!onChanged) return () => {};
  const listener = (changes, areaName) => {
    if (areaName && areaName !== 'local') return;
    const change = changes && changes[WEBGUI_COLUMNS_KEY];
    if (!change) return;
    const newAll = change.newValue || {};
    fn(normalize(augId, newAll[augId]));
  };
  onChanged.addListener(listener);
  return () => onChanged.removeListener(listener);
}

function defaultStorage() {
  // eslint-disable-next-line no-undef
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) return chrome.storage.local;
  throw new Error('column-order: chrome.storage.local is not available and no storage adapter was provided');
}

function defaultOnChanged() {
  // eslint-disable-next-line no-undef
  if (typeof chrome !== 'undefined' && chrome?.storage?.onChanged) return chrome.storage.onChanged;
  return null;
}
