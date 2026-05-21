// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-170: Bulk action - Set Parent Group.
//
// params: { groupUrl: string, groupName?: string }
// target: { id, name, parentGroup?: { id, name, url } | null }
//
// describe() reads target.parentGroup (populated in Configure by
// bulk-composer:list-server-parents-batch); compares against the chosen
// groupUrl; skip when already there.
//
// commit() always re-reads the server (GET) before writing (PUT) so we
// can't stomp on concurrent changes. PUT body is routed through
// sanitizeServerBodyForPut() per memory rule about GET-modify-PUT on
// server records.

export const id = 'set-parent-group';
export const label = 'Set Parent Group';
export const description = 'Move each selected instance into a chosen parent server group. Already-in-that-group instances are skipped.';
export const requires = 'apiKey';
export const writeMethod = 'PUT /server/{id}';

export function validate(params = {}) {
  const url = String(params?.groupUrl ?? '').trim();
  if (!url) return { ok: false, error: 'Server group is required.' };
  const name = typeof params?.groupName === 'string' && params.groupName.trim()
    ? params.groupName.trim()
    : null;
  return { ok: true, value: { groupUrl: url, groupName: name } };
}

function labelFor(group) {
  if (!group) return '(none)';
  return group.name || `#${group.id ?? '?'}`;
}

export function describe(target, params) {
  const v = validate(params);
  if (!v.ok) return { prev: '-', next: '-', willChange: false, error: v.error };
  const nextLabel = v.value.groupName || v.value.groupUrl;
  // parentGroup === undefined means the Configure pre-flight didn't run
  // (or hasn't landed yet); parentGroup === null is a definitive "no parent"
  // (root-level instance). Treat undefined as the placeholder branch.
  if (target?.parentGroup === undefined) {
    return {
      prev: '(group unknown)',
      next: `→ ${nextLabel}`,
      willChange: true,
      note: 'Parent group not yet fetched; commit will pre-flight.'
    };
  }
  const current = target.parentGroup;
  const sameUrl = current && current.url === v.value.groupUrl;
  if (sameUrl) {
    return {
      prev: labelFor(current),
      next: labelFor(current),
      willChange: false,
      skip: true,
      note: `Already in "${labelFor(current)}"; will skip.`
    };
  }
  return {
    prev: labelFor(current),
    next: nextLabel,
    willChange: true,
    note: `Will move from "${labelFor(current)}" to "${nextLabel}".`
  };
}

export async function commit(target, params, ctx = {}) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  const { client } = ctx;
  if (!client) throw new Error('PanoptaClient required for set-parent-group.');
  try {
    const out = await client.setServerParentGroup(target.id, v.value.groupUrl);
    if (out.noop) {
      return { status: 200, noop: true, skipped: true, reason: 'already-in-group' };
    }
    return {
      status: out.status,
      noop: false,
      parent: {
        from: out.from,
        to: out.to,
        name: v.value.groupName
      }
    };
  } catch (err) {
    if (err?.status === 404) {
      throw new Error(`Instance #${target.id} not found on this tenant.`);
    }
    throw err;
  }
}
