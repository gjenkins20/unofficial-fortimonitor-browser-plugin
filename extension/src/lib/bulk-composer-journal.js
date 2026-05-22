// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-237: per-run audit trail for Bulk Action Composer runs.
//
// Storage shape (chrome.storage.local key `fm:bulkComposerRunLog`):
//   [
//     {
//       runId,                       // uuid-ish, generated at append time
//       startedAt, finishedAt,       // ISO strings
//       actionId,                    // bulk-actions registry id
//       actionLabel,                 // human label for the UI
//       targetIds,                   // server ids the run was committed against
//       created: {                   // resources the run brought into existence
//         templates:      [{ id, name, attachedToServerId?, viaRowIndex }],
//         mpws:           [{ id, name, viaRowIndex }],
//         server_groups:  [{ id, name, viaRowIndex }],
//         attributes:     [{ serverId, attributeId, typeUrl, value, viaRowIndex }],
//         tags:           [{ serverId, tag, viaRowIndex }]
//       },
//       attached: {                  // pre-existing resources the run mutated
//         templateAttachments: [{ serverId, templateId, templateName, viaRowIndex }]
//       },
//       order: [ 'kind:identity', ... ],  // creation order; rollback walks reverse
//       rollback: null | {           // populated by rollback runner
//         startedAt, finishedAt,
//         steps: [{ kind, identity, status, error? }]
//       }
//     },
//     ...
//   ]
//
// Ring buffer cap: MAX_ENTRIES newest entries retained, oldest evicted.

const STORAGE_KEY = 'fm:bulkComposerRunLog';
export const MAX_ENTRIES = 50;

function getStorage(overrides) {
  if (overrides?.storage) return overrides.storage;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) return chrome.storage.local;
  throw new Error('chrome.storage.local unavailable; pass overrides.storage');
}

async function readAll(storage) {
  const data = await storage.get(STORAGE_KEY);
  const arr = data?.[STORAGE_KEY];
  return Array.isArray(arr) ? arr : [];
}

async function writeAll(storage, entries) {
  await storage.set({ [STORAGE_KEY]: entries });
}

function generateRunId() {
  // No randomness requirements beyond uniqueness within the ring buffer.
  // Combine timestamp + small random tail; collisions inside one session
  // would require 1M+ entries per second.
  const tail = Math.random().toString(36).slice(2, 10);
  return `run-${Date.now().toString(36)}-${tail}`;
}

/**
 * Append a run record. Assigns runId if not present. Caps the buffer to
 * MAX_ENTRIES, evicting oldest. Returns the stored record (with runId).
 */
export async function appendRun(record, overrides = {}) {
  if (!record || typeof record !== 'object') {
    throw new TypeError('appendRun: record object required');
  }
  const storage = getStorage(overrides);
  const stored = { ...record };
  if (!stored.runId) stored.runId = generateRunId();
  if (!stored.startedAt) stored.startedAt = new Date().toISOString();
  if (!stored.finishedAt) stored.finishedAt = new Date().toISOString();
  if (!stored.created) stored.created = { templates: [], mpws: [], server_groups: [], attributes: [], tags: [] };
  if (!stored.attached) stored.attached = { templateAttachments: [] };
  if (!Array.isArray(stored.order)) stored.order = [];
  if (stored.rollback === undefined) stored.rollback = null;

  const entries = await readAll(storage);
  entries.unshift(stored);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  await writeAll(storage, entries);
  return stored;
}

export async function listRuns(overrides = {}) {
  const storage = getStorage(overrides);
  return readAll(storage);
}

export async function getRun(runId, overrides = {}) {
  if (!runId) return null;
  const storage = getStorage(overrides);
  const entries = await readAll(storage);
  return entries.find((e) => e.runId === runId) ?? null;
}

/**
 * Update the rollback outcome blob for a stored run. Returns the updated
 * entry, or null if no run with that id exists.
 */
export async function setRollbackOutcome(runId, rollback, overrides = {}) {
  if (!runId) return null;
  const storage = getStorage(overrides);
  const entries = await readAll(storage);
  const idx = entries.findIndex((e) => e.runId === runId);
  if (idx < 0) return null;
  entries[idx] = { ...entries[idx], rollback };
  await writeAll(storage, entries);
  return entries[idx];
}

export async function clearAll(overrides = {}) {
  const storage = getStorage(overrides);
  await storage.remove(STORAGE_KEY);
}

// ---------------- per-action extraction ----------------

/**
 * Inspect a single row's commit detail and emit any resources the row
 * created or attached. Builds toward the journal record's `created` /
 * `attached` / `order` sections.
 *
 * Each action's `commit()` returns a different shape; this is the one
 * place that knows how to read each one. Adding a new action that
 * creates resources requires adding a branch here.
 */
export function extractRowEffects(actionId, detail, target, rowIndex) {
  const effects = {
    created: { templates: [], mpws: [], server_groups: [], attributes: [], tags: [] },
    attached: { templateAttachments: [] },
    order: []
  };
  if (!detail || detail.dry_run === true || detail.noop === true) return effects;
  const serverId = target?.id ?? null;

  switch (actionId) {
    case 'profile-and-create-templates': {
      const t = detail.template;
      if (t && t.created === true && t.id != null) {
        effects.created.templates.push({ id: t.id, name: t.name ?? null, viaRowIndex: rowIndex });
        effects.order.push(`template:${t.id}`);
      }
      const mpw = detail.mpw;
      if (mpw && mpw.created === true && mpw.id != null) {
        effects.created.mpws.push({ id: mpw.id, name: mpw.name ?? null, viaRowIndex: rowIndex });
        effects.order.push(`mpw:${mpw.id}`);
      }
      if (t && t.id != null && serverId != null && detail.reason !== 'template-already-attached') {
        effects.attached.templateAttachments.push({
          serverId, templateId: t.id, templateName: t.name ?? null, viaRowIndex: rowIndex
        });
        effects.order.push(`attach:${serverId}:${t.id}`);
      }
      break;
    }
    case 'apply-stock-fabric-templates': {
      const t = detail.template;
      if (t && t.id != null && serverId != null && detail.reason !== 'template-already-attached') {
        effects.attached.templateAttachments.push({
          serverId, templateId: t.id, templateName: t.name ?? null, viaRowIndex: rowIndex
        });
        effects.order.push(`attach:${serverId}:${t.id}`);
      }
      const policy = detail.policy;
      if (policy && policy.created === true && policy.id != null) {
        effects.created.mpws.push({ id: policy.id, name: policy.name ?? null, viaRowIndex: rowIndex });
        effects.order.push(`mpw:${policy.id}`);
      }
      break;
    }
    case 'apply-template': {
      const t = detail.template;
      const tid = t?.id ?? detail.templateId ?? null;
      if (tid != null && serverId != null) {
        effects.attached.templateAttachments.push({
          serverId, templateId: tid, templateName: t?.name ?? null, viaRowIndex: rowIndex
        });
        effects.order.push(`attach:${serverId}:${tid}`);
      }
      break;
    }
    case 'add-tag': {
      const added = Array.isArray(detail.addedTags) ? detail.addedTags : [];
      for (const tag of added) {
        if (serverId != null && tag) {
          effects.created.tags.push({ serverId, tag, viaRowIndex: rowIndex });
          effects.order.push(`tag:${serverId}:${tag}`);
        }
      }
      break;
    }
    case 'auto-tag-by-name': {
      const added = Array.isArray(detail.addedTags) ? detail.addedTags : [];
      for (const tag of added) {
        if (serverId != null && tag) {
          effects.created.tags.push({ serverId, tag, viaRowIndex: rowIndex });
          effects.order.push(`tag:${serverId}:${tag}`);
        }
      }
      break;
    }
    case 'auto-set-attribute-by-name': {
      const a = detail.attribute;
      if (a && a.id != null && serverId != null) {
        effects.created.attributes.push({
          serverId,
          attributeId: a.id,
          typeUrl: a.typeUrl ?? null,
          value: a.value ?? null,
          viaRowIndex: rowIndex
        });
        effects.order.push(`attr:${serverId}:${a.id}`);
      }
      break;
    }
    default:
      // Actions that don't create persistent resources (port scope,
      // set-parent-group, set-agent-resource-status, maintenance
      // window) currently emit nothing journal-worthy.
      break;
  }

  return effects;
}

/**
 * Combine per-row effects into the journal-record shape. Order is
 * appended in the order rows finished (rollback walks reverse, which
 * roughly matches dependency-correct teardown for the resources the
 * composer creates).
 */
export function aggregateRunEffects(rows, actionId) {
  const merged = {
    created: { templates: [], mpws: [], server_groups: [], attributes: [], tags: [] },
    attached: { templateAttachments: [] },
    order: []
  };
  const seenTemplate = new Set();
  const seenMpw = new Set();
  const seenGroup = new Set();
  rows.forEach((row, i) => {
    const effects = extractRowEffects(actionId, row?.detail, { id: row?.id, name: row?.name }, i);
    for (const t of effects.created.templates) {
      if (seenTemplate.has(t.id)) continue;
      seenTemplate.add(t.id);
      merged.created.templates.push(t);
    }
    for (const m of effects.created.mpws) {
      if (seenMpw.has(m.id)) continue;
      seenMpw.add(m.id);
      merged.created.mpws.push(m);
    }
    for (const g of effects.created.server_groups) {
      if (seenGroup.has(g.id)) continue;
      seenGroup.add(g.id);
      merged.created.server_groups.push(g);
    }
    merged.created.attributes.push(...effects.created.attributes);
    merged.created.tags.push(...effects.created.tags);
    merged.attached.templateAttachments.push(...effects.attached.templateAttachments);
    for (const o of effects.order) if (!merged.order.includes(o)) merged.order.push(o);
  });
  return merged;
}

export const _STORAGE_KEY = STORAGE_KEY;
