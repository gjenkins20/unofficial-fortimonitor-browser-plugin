// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155: Bulk action - Remove Tag.
//
// Symmetric to add-tag. Removing a tag that isn't present is a no-op
// (commit short-circuits and does not write).

export const id = 'remove-tag';
export const label = 'Remove Tag';
export const description = 'Remove a single tag from each selected instance. Other tags are preserved.';
export const requires = 'apiKey';
export const writeMethod = 'PUT /server/{id}';

export function validate(params = {}) {
  const tag = String(params?.tag ?? '').trim();
  if (!tag) return { ok: false, error: 'Tag is required.' };
  return { ok: true, value: { tag } };
}

export function describe(target, params) {
  const v = validate(params);
  if (!v.ok) return { prev: '-', next: '-', willChange: false, error: v.error };
  const { tag } = v.value;
  const existing = Array.isArray(target?.tags) ? target.tags : null;
  if (existing === null) {
    return {
      prev: '(tags unknown)',
      next: `- ${tag}`,
      willChange: true,
      note: 'Server tag list not in cache; commit will read-modify-write.'
    };
  }
  const has = existing.includes(tag);
  const after = existing.filter((t) => t !== tag);
  return {
    prev: existing.length ? existing.join(', ') : '(none)',
    next: has ? (after.length ? after.join(', ') : '(none)') : existing.join(', '),
    willChange: has,
    note: has ? null : 'Tag not present; commit will be a no-op.'
  };
}

export async function commit(target, params, { client }) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  try {
    const result = await client.removeServerTag(target.id, [v.value.tag]);
    return {
      status: result.status,
      removedTags: result.removedTags,
      tagsAfter: result.tagsAfter,
      noop: result.removedTags.length === 0
    };
  } catch (err) {
    // FMN-206: GET 404 means the operator handed us a server ID that
    // doesn't exist on this tenant (typos, bogus IDs, deleted instances).
    // Re-throw with operator-friendly copy so the preview's detail row
    // doesn't read like a stack trace.
    if (err?.status === 404) {
      throw new Error(`Instance #${target.id} not found on this tenant.`);
    }
    throw err;
  }
}
