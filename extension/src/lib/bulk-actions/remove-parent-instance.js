// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-279: Bulk action - Remove Parent Instance (device parent/child).
//
// Complement of set-parent-instance. The v2 API cannot clear parent_server, so
// removal uses the session-auth editInstance form (parent_server[] omitted) via
// FortimonitorClient.removeServerParentInstance(). No params.
//
// requires 'apiKey+session': the Configure pre-flight reads each target's
// current parent over v2 (to skip already-parentless rows in Preview) while the
// commit writes over the FortiMonitor session.
//
// describe() reads target.parentInstance (populated in Configure by
// bulk-composer:list-server-parent-instances-batch); a null parent -> skip.

export const id = 'remove-parent-instance';
export const label = 'Remove Parent Instance';
export const description = 'Clear the parent (dependency) of each selected instance. Instances that already have no parent are skipped.';
export const requires = 'apiKey+session';
export const writeMethod = 'POST /config/editInstance';

export function validate() {
  return { ok: true, value: {} };
}

function labelFor(parent) {
  if (!parent) return '(none)';
  return parent.name || `#${parent.id ?? '?'}`;
}

export function describe(target) {
  // parentInstance === undefined -> pre-flight hasn't run; commit will still
  // do the right thing (editInstance-remove is a no-op when there is no parent).
  if (target?.parentInstance === undefined) {
    return {
      prev: '(parent unknown)',
      next: '(none)',
      willChange: true,
      note: 'Current parent not yet fetched; commit will pre-flight.'
    };
  }
  const current = target.parentInstance;
  if (!current) {
    return {
      prev: '(none)',
      next: '(none)',
      willChange: false,
      skip: true,
      note: 'No parent set; will skip.'
    };
  }
  return {
    prev: labelFor(current),
    next: '(none)',
    willChange: true,
    note: `Will remove parent "${labelFor(current)}".`
  };
}

export async function commit(target, params, ctx = {}) {
  const { fortimonitorClient } = ctx;
  if (!fortimonitorClient) throw new Error('FortimonitorClient required for remove-parent-instance.');
  // The pre-flight definitively says "no parent" -> skip the write entirely.
  if (target?.parentInstance === null) {
    return { status: 200, noop: true, skipped: true, reason: 'no-parent' };
  }
  try {
    const out = await fortimonitorClient.removeServerParentInstance(target.id);
    return {
      status: out.status,
      noop: false,
      parent: { from: target?.parentInstance ?? null, to: null },
      message: out.message
    };
  } catch (err) {
    if (err?.status === 404) {
      throw new Error(`Instance #${target.id} not found on this tenant.`);
    }
    throw err;
  }
}
