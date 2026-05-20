// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-224: parse the /util/monitoring_tree?include_templates=1 response into
// a flat list of server groups with their member device IDs.
//
// Response shape (captured FMN-199, 2026-05-13):
//   {
//     "nodes": [{ "id": "grp-0", "node-type": "group", "text": "All Instances",
//                 "children": [ ...nested groups, "node-type": "server"|"template"
//                                  leaves with "id": "s-{n}"|"a-{n}"|"cs-{n}" ]
//              }],
//     "userHash": "..."
//   }
//
// Leaf rules:
//   - "node-type": "server" with "id": "s-{n}"  -> real server (counted)
//   - "node-type": "template" with "id": "s-{n}" -> template (skipped)
//   - "id": "a-{n}"  -> OnSight appliance (skipped from memberIds, surfaced
//                        in skippedOnsightCount)
//   - "id": "cs-{n}" -> compound service (skipped from memberIds, surfaced
//                        in skippedCompoundCount)
//
// Pure module - no chrome / fetch APIs. Fully unit-testable.

const GRP_PREFIX_RE = /^grp-(\d+)$/;
const SERVER_PREFIX_RE = /^s-(\d+)$/;
const ONSIGHT_PREFIX_RE = /^a-(\d+)$/;
const COMPOUND_PREFIX_RE = /^cs-(\d+)$/;

/**
 * Flatten a monitoring_tree response into a list of groups with both
 * direct- and recursive-member counts, plus a tenant-wide `nameById` map
 * harvested from the server leaves (the tree carries names inline; no
 * separate name-resolution call needed).
 *
 * @param {object} tree - parsed JSON from POST /util/monitoring_tree
 * @returns {{
 *   groups: Array<{
 *     id: number,            // numeric (grp- prefix stripped)
 *     name: string,
 *     parentId: number|null, // numeric parent group id, null for root
 *     depth: number,         // 0 for "All Instances", 1 for top-level, etc.
 *     directMemberIds: number[],   // server leaves directly attached
 *     allMemberIds: number[],      // recursive descendants, deduplicated
 *     skippedOnsightCount: number, // a-{n} descendants
 *     skippedCompoundCount: number,// cs-{n} descendants
 *     skippedTemplateCount: number // node-type:"template" descendants
 *   }>,
 *   nameById: Record<number, string>  // tenant-wide server id -> display name
 * }}
 */
export function parseMonitoringTree(tree) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const groups = [];
  const nameById = {};

  for (const node of nodes) {
    walkGroup(node, null, 0, groups, nameById);
  }

  return { groups, nameById };
}

function walkGroup(node, parentId, depth, out, nameById) {
  if (!node || node['node-type'] !== 'group') return null;
  const idMatch = GRP_PREFIX_RE.exec(String(node.id ?? ''));
  if (!idMatch) return null;
  const id = Number(idMatch[1]);
  const name = String(node.text ?? '');
  const directMemberIds = [];
  const allMemberIdsSet = new Set();
  let skippedOnsightCount = 0;
  let skippedCompoundCount = 0;
  let skippedTemplateCount = 0;

  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    const childType = child['node-type'];
    const rawId = String(child.id ?? '');

    if (childType === 'group') {
      const sub = walkGroup(child, id, depth + 1, out, nameById);
      if (sub) {
        for (const mid of sub.allMemberIds) allMemberIdsSet.add(mid);
        skippedOnsightCount += sub.skippedOnsightCount;
        skippedCompoundCount += sub.skippedCompoundCount;
        skippedTemplateCount += sub.skippedTemplateCount;
      }
      continue;
    }

    if (childType === 'template') {
      skippedTemplateCount++;
      continue;
    }

    if (childType === 'server') {
      const m = SERVER_PREFIX_RE.exec(rawId);
      if (m) {
        const n = Number(m[1]);
        directMemberIds.push(n);
        allMemberIdsSet.add(n);
        if (child.text && !nameById[n]) nameById[n] = String(child.text);
        continue;
      }
      if (ONSIGHT_PREFIX_RE.test(rawId)) { skippedOnsightCount++; continue; }
      if (COMPOUND_PREFIX_RE.test(rawId)) { skippedCompoundCount++; continue; }
    }
  }

  const group = {
    id,
    name,
    parentId,
    depth,
    directMemberIds,
    allMemberIds: [...allMemberIdsSet],
    skippedOnsightCount,
    skippedCompoundCount,
    skippedTemplateCount
  };
  out.push(group);
  return group;
}

/**
 * Combine the picked groups' allMemberIds into a single deduplicated list,
 * preserving first-seen order across the picked groups (so the operator can
 * predict which group "owned" the slot when they review the parse table).
 *
 * @param {Array} groups - the full list from parseMonitoringTree().groups
 * @param {number[]} pickedGroupIds - numeric group ids the operator selected
 * @returns {{ serverIds: number[], byGroupId: Record<number, number[]> }}
 */
export function unionMembers(groups, pickedGroupIds) {
  const byGroupId = {};
  const seen = new Set();
  const serverIds = [];
  const wanted = new Set(pickedGroupIds.map(Number));
  for (const g of groups) {
    if (!wanted.has(g.id)) continue;
    byGroupId[g.id] = g.allMemberIds.slice();
    for (const sid of g.allMemberIds) {
      if (!seen.has(sid)) {
        seen.add(sid);
        serverIds.push(sid);
      }
    }
  }
  return { serverIds, byGroupId };
}
