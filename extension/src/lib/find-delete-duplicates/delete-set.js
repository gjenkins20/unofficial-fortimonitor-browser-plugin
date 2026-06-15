// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-269: delete-set builder for the Find & Delete Duplicates tool.
//
// Pure helper (no IO/DOM/chrome.*) that turns analyzeDuplicates() output +
// the operator's per-duplicate-set keep choices into the concrete list of
// instances to delete.
//
// Terminology (operator directive 2026-06-15): a "duplicate set" is a
// collection of instances that match each other (shared normalized name OR
// shared address). NOT a FortiMonitor server / instance group. analyzeDuplicates
// calls these `groups` internally; here they are duplicate sets.
//
// Rationalized deletion model:
//   - Each duplicate set keeps exactly ONE instance (the survivor) and deletes
//     the rest. The keep is chosen per set (default: lowest/oldest id).
//   - keep->=1 guardrail is structural: every set always has a survivor, so the
//     tool can never delete every copy of a device.
//   - Name-based and address-based sets are kept SEPARATE (operator decision).
//     An instance can therefore appear in two sets. Conservative resolution:
//     if an instance is the chosen KEEP in ANY set, it is NEVER deleted, even
//     if it is a delete-candidate in another set. A keep always wins.
//   - The final delete list is deduped by id, so an instance is deleted at most
//     once.

/** Lowest id first; numeric when both parse, lexical otherwise. Pure. */
function lowestId(ids) {
  return [...ids].sort((a, b) => {
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  })[0];
}

function memberIdsOf(set) {
  return (Array.isArray(set?.members) ? set.members : []).map((m) => String(m.id));
}

/**
 * Resolve the kept id for a set: the operator's choice when it names a real
 * member, otherwise the default (lowest id).
 */
function resolveKeep(set, key, keepMap) {
  const ids = memberIdsOf(set);
  const chosen = keepMap && keepMap[key] != null ? String(keepMap[key]) : null;
  if (chosen && ids.includes(chosen)) return chosen;
  return lowestId(ids);
}

/**
 * Default keep selection: lowest/oldest id per duplicate set. Keyed by the
 * set's index in the groups array (stable for a given analysis result).
 *
 * @param {Array} groups  analyzeDuplicates().groups
 * @returns {Object<string,string>} setKey -> keptId
 */
export function defaultKeepMap(groups) {
  const out = {};
  (Array.isArray(groups) ? groups : []).forEach((set, i) => {
    out[String(i)] = lowestId(memberIdsOf(set));
  });
  return out;
}

/**
 * Build the concrete delete-set from duplicate sets + keep choices.
 *
 * @param {Array} groups  analyzeDuplicates().groups (duplicate sets)
 * @param {Object<string,string>} [keepMap]  setKey -> keptId; missing/invalid
 *   entries fall back to lowest id
 * @returns {{
 *   deleteTargets: {id:string,name:string}[],   // deduped, ready for bulk-composer:commit
 *   deleteIds: string[],
 *   keptIds: string[],
 *   perSet: {key:string,axis:string,value:string,keptId:string,deleteIds:string[]}[],
 *   sparedByKeepElsewhere: string[]              // ids spared because kept in another set
 * }}
 */
export function buildDeleteSet(groups, keepMap = {}) {
  const sets = Array.isArray(groups) ? groups : [];

  // Pass 1: every kept id across all sets (a keep anywhere wins).
  const keptIds = new Set();
  sets.forEach((set, i) => keptIds.add(resolveKeep(set, String(i), keepMap)));

  // Pass 2: delete candidates = members minus the set's keep, minus any id
  // kept in another set. Dedup the final list by id.
  const perSet = [];
  const deleteMap = new Map();
  const spared = new Set();
  sets.forEach((set, i) => {
    const key = String(i);
    const keptId = resolveKeep(set, key, keepMap);
    const deleteIds = [];
    for (const m of (Array.isArray(set.members) ? set.members : [])) {
      const id = String(m.id);
      if (id === keptId) continue;
      if (keptIds.has(id)) { spared.add(id); continue; }
      deleteIds.push(id);
      if (!deleteMap.has(id)) deleteMap.set(id, { id, name: m.name ?? '' });
    }
    perSet.push({ key, axis: set.axis, value: set.value, keptId, deleteIds });
  });

  const deleteTargets = [...deleteMap.values()];
  return {
    deleteTargets,
    deleteIds: deleteTargets.map((t) => t.id),
    keptIds: [...keptIds],
    perSet,
    sparedByKeepElsewhere: [...spared]
  };
}

function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV of the found-duplicates report (FMN-271): one row per member of each
 * duplicate set, with the disposition (keep / delete) the current keep choices
 * would produce. "keep" covers both a set's survivor and any member spared
 * because it is kept in another set.
 *
 * @param {Array} groups  analyzeDuplicates().groups (duplicate sets)
 * @param {Object<string,string>} [keepMap]  setKey -> keptId
 * @returns {string} CSV text
 */
export function buildDuplicatesCsv(groups, keepMap = {}) {
  const sets = Array.isArray(groups) ? groups : [];
  const plan = buildDeleteSet(sets, keepMap);
  const kept = new Set(plan.keptIds);
  const header = ['match_on', 'shared_value', 'duplicate_set_size', 'instance_id', 'instance_name', 'ip_address', 'disposition'];
  const lines = [header.join(',')];
  for (const set of sets) {
    const matchOn = set.axis === 'name' ? 'Name' : 'IP address';
    for (const m of (Array.isArray(set.members) ? set.members : [])) {
      const id = String(m.id);
      const disposition = kept.has(id) ? 'keep' : 'delete';
      lines.push([matchOn, set.value, set.members.length, id, m.name ?? '', m.address ?? '', disposition].map(csvField).join(','));
    }
  }
  return lines.join('\n');
}
