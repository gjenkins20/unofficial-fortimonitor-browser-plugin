// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155: Bulk action - Add Tag.
//
// params: { tag: string }
// target: { id, name, tags?: string[] }  (tags optional; describe() falls
//   back to a generic prev->next string when the omni-search corpus did
//   not carry the tag list)
//
// describe() is pure: produces a { prev, next, willChange } snapshot
// for the preview table without calling the network. The omni-search
// cache already includes tags[] per entry (FMN-152) so the preview is
// usually accurate offline; commit() does the authoritative read-
// modify-write against /server/{id}.

export const id = 'add-tag';
export const label = 'Add Tag';
export const description = 'Add a single tag to each selected instance. Existing tags are preserved.';
export const requires = 'apiKey';
export const writeMethod = 'PUT /server/{id}';

export function validate(params = {}) {
  const tag = String(params?.tag ?? '').trim();
  if (!tag) return { ok: false, error: 'Tag is required.' };
  if (tag.length > 200) return { ok: false, error: 'Tag is unusually long (>200 chars).' };
  return { ok: true, value: { tag } };
}

export function describe(target, params) {
  const v = validate(params);
  if (!v.ok) return { prev: '-', next: '-', willChange: false, error: v.error };
  const { tag } = v.value;
  const existing = Array.isArray(target?.tags) ? target.tags : null;
  if (existing === null) {
    // Cache didn't carry tags; we can still describe at a coarse level.
    return {
      prev: '(tags unknown)',
      next: `+ ${tag}`,
      willChange: true,
      note: 'Server tag list not in cache; commit will read-modify-write.'
    };
  }
  const has = existing.includes(tag);
  return {
    prev: existing.length ? existing.join(', ') : '(none)',
    next: has ? existing.join(', ') : existing.concat([tag]).join(', '),
    willChange: !has,
    note: has ? 'Already tagged; commit will be a no-op.' : null
  };
}

export async function commit(target, params, { client }) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  try {
    const result = await client.addServerTag(target.id, [v.value.tag]);
    return {
      status: result.status,
      addedTags: result.addedTags,
      tagsAfter: result.tagsAfter,
      noop: result.addedTags.length === 0
    };
  } catch (err) {
    // FMN-206: GET 404 means the operator handed us a server ID that
    // doesn't exist on this tenant. Re-throw with friendly copy.
    if (err?.status === 404) {
      throw new Error(`Instance #${target.id} not found on this tenant.`);
    }
    throw err;
  }
}
