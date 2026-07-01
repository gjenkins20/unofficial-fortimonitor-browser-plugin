// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-277: Bulk action - Set Parent Instance (device parent/child dependency).
//
// Distinct from set-parent-group.js: this sets `parent_server` (the dependency
// parent used for alert suppression), NOT `server_group` (the org folder).
//
// params: { parentUrl: string, parentName?: string }
// target: { id, name, parentInstance?: { id, name, url } | null }
//
// describe() reads target.parentInstance (populated in Configure by
// bulk-composer:list-server-parent-instances-batch); compares against the
// chosen parentUrl; skip when already there.
//
// commit() routes through PanoptaClient.setServerParentInstance(), which does
// GET-modify-sanitize-PUT (parent_server = parentUrl). SET/CHANGE only - the
// v2 API cannot CLEAR a parent (verified live FMN-277: null ignored, "" 400,
// PATCH 405); removal is a separate action (remove-parent-instance) that uses
// the session-auth editInstance path.
//
// A device cannot be its own parent; describe() flags that as a skip so a
// self-reference never reaches commit.

export const id = 'set-parent-instance';
export const label = 'Set Parent Instance';
export const description = 'Set a chosen instance as the parent (dependency) of each selected instance. Instances already pointing at that parent are skipped.';
export const requires = 'apiKey';
export const writeMethod = 'PUT /server/{id}';

export function validate(params = {}) {
  const url = String(params?.parentUrl ?? '').trim();
  if (!url) return { ok: false, error: 'Parent instance is required.' };
  const name = typeof params?.parentName === 'string' && params.parentName.trim()
    ? params.parentName.trim()
    : null;
  return { ok: true, value: { parentUrl: url, parentName: name } };
}

function labelFor(parent) {
  if (!parent) return '(none)';
  return parent.name || `#${parent.id ?? '?'}`;
}

// Extract the trailing numeric id from a v2 server URL (.../server/{id}).
function idFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/server\/(\d+)\/?$/);
  return m ? m[1] : null;
}

export function describe(target, params) {
  const v = validate(params);
  if (!v.ok) return { prev: '-', next: '-', willChange: false, error: v.error };
  const nextLabel = v.value.parentName || v.value.parentUrl;

  // A device cannot be its own parent - guard before anything else.
  const parentId = idFromUrl(v.value.parentUrl);
  if (parentId != null && String(target?.id) === String(parentId)) {
    return {
      prev: '(self)',
      next: nextLabel,
      willChange: false,
      skip: true,
      note: 'An instance cannot be its own parent; will skip.'
    };
  }

  // parentInstance === undefined means the Configure pre-flight didn't run
  // (or hasn't landed yet); parentInstance === null is a definitive "no
  // parent". Treat undefined as the placeholder branch.
  if (target?.parentInstance === undefined) {
    return {
      prev: '(parent unknown)',
      next: `→ ${nextLabel}`,
      willChange: true,
      note: 'Current parent not yet fetched; commit will pre-flight.'
    };
  }
  const current = target.parentInstance;
  const sameUrl = current && current.url === v.value.parentUrl;
  if (sameUrl) {
    return {
      prev: labelFor(current),
      next: labelFor(current),
      willChange: false,
      skip: true,
      note: `Already parented to "${labelFor(current)}"; will skip.`
    };
  }
  return {
    prev: labelFor(current),
    next: nextLabel,
    willChange: true,
    note: `Will set parent from "${labelFor(current)}" to "${nextLabel}".`
  };
}

export async function commit(target, params, ctx = {}) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  const parentId = idFromUrl(v.value.parentUrl);
  if (parentId != null && String(target?.id) === String(parentId)) {
    return { status: 200, noop: true, skipped: true, reason: 'self-parent' };
  }
  const { client } = ctx;
  if (!client) throw new Error('PanoptaClient required for set-parent-instance.');
  try {
    const out = await client.setServerParentInstance(target.id, v.value.parentUrl);
    if (out.noop) {
      return { status: 200, noop: true, skipped: true, reason: 'already-parented' };
    }
    return {
      status: out.status,
      noop: false,
      parent: {
        from: out.from,
        to: out.to,
        name: v.value.parentName
      }
    };
  } catch (err) {
    if (err?.status === 404) {
      throw new Error(`Instance #${target.id} not found on this tenant.`);
    }
    throw err;
  }
}
