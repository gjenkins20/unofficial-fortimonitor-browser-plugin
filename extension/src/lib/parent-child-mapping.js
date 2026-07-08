// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-280: pure logic for the Parent/Child Associations tool - parsing the
// grouped mapping input and computing per-row status. No DOM, no chrome APIs,
// so it unit-tests directly. The tool UI + SW handlers build on top.
//
// A "token" is how the operator refers to an instance in text: either a numeric
// SERVER ID or a NAME (operator asked for both, 2026-07-07). classifyToken()
// tags which; resolution to a concrete server happens in the SW handler.

// Parse the import textarea. Format: one parent group per line -
//   PARENT: CHILD, CHILD, CHILD
// PARENT and each CHILD are tokens (id or name). Blank lines ignored; a line
// without a colon, without a parent, or without children is reported in errors
// (never silently dropped).
export function parseMappingText(text) {
  const groups = [];
  const errors = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const ci = line.indexOf(':');
    if (ci === -1) {
      errors.push({ line: idx + 1, text: line, error: 'Expected "parent: child, child".' });
      return;
    }
    const parent = line.slice(0, ci).trim();
    const children = line.slice(ci + 1).split(',').map((s) => s.trim()).filter(Boolean);
    if (!parent) { errors.push({ line: idx + 1, text: line, error: 'Missing parent before ":".' }); return; }
    if (children.length === 0) { errors.push({ line: idx + 1, text: line, error: 'No children listed after ":".' }); return; }
    groups.push({ parent, children });
  });
  return { groups, errors };
}

// A token is an ID if it is all digits, else a name.
export function classifyToken(token) {
  const t = String(token ?? '').trim();
  if (t === '') return { kind: 'empty', value: '' };
  if (/^\d+$/.test(t)) return { kind: 'id', value: t };
  return { kind: 'name', value: t };
}

// Flatten grouped state -> a de-duplicated list of { childToken, parentToken }.
// If the same child appears under two different parents, the LAST one wins and
// the collision is reported (a child can only have one parent).
export function flattenGroups(groups) {
  const rows = [];
  const seen = new Map(); // childToken(lower) -> index into rows
  const conflicts = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const parentToken = String(g?.parent ?? '').trim();
    if (!parentToken) continue;
    for (const c of Array.isArray(g?.children) ? g.children : []) {
      const childToken = String(c ?? '').trim();
      if (!childToken) continue;
      const key = childToken.toLowerCase();
      if (seen.has(key)) {
        const prev = rows[seen.get(key)];
        if (prev.parentToken.toLowerCase() !== parentToken.toLowerCase()) {
          conflicts.push({ childToken, from: prev.parentToken, to: parentToken });
        }
        prev.parentToken = parentToken; // last wins
        continue;
      }
      seen.set(key, rows.length);
      rows.push({ childToken, parentToken });
    }
  }
  return { rows, conflicts };
}

// Given a resolved row (child + parent resolved to {id,url,name} or null, plus
// the child's current parent url) compute the Preview status. Pure.
//   'set'          - will set/change the parent
//   'skip-already' - child already parented to this parent
//   'skip-self'    - child === parent (an instance can't be its own parent)
//   'error-child'  - child token didn't resolve
//   'error-parent' - parent token didn't resolve
export function setRowStatus({ child, parent, currentParentUrl }) {
  if (!child || child.id == null) return 'error-child';
  if (!parent || parent.id == null) return 'error-parent';
  if (String(child.id) === String(parent.id)) return 'skip-self';
  if (currentParentUrl && parent.url && currentParentUrl === parent.url) return 'skip-already';
  return 'set';
}

// Remove-mode status for a child: skip if it already has no parent.
//   'remove'      - will clear the parent
//   'skip-none'   - no parent set
//   'error-child' - child token didn't resolve
export function removeRowStatus({ child, currentParentUrl }) {
  if (!child || child.id == null) return 'error-child';
  if (!currentParentUrl) return 'skip-none';
  return 'remove';
}

export function isChangeStatus(status) {
  return status === 'set' || status === 'remove';
}
