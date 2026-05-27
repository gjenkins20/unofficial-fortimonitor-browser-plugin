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
  const tags = target?.tags;
  // FMN-207: target.tags === null after the always-live chip-fetch
  // (FMN-206) means the live GET 404'd - the instance doesn't exist on
  // this tenant. Skip with clear copy.
  if (tags === null) {
    return {
      prev: '(not found)',
      next: '(not found)',
      willChange: false,
      skip: true,
      note: 'Instance not found on this tenant; will skip.'
    };
  }
  // FMN-258: target.tags === undefined means the chip-fetch has not resolved
  // yet (operator advanced past Configure before it landed). The current
  // tags are UNKNOWN - do NOT collapse that into "not found / skip", which
  // silently dropped the add. Classify optimistically as "will add" and let
  // commit()'s authoritative GET-modify-PUT decide; addServerTag is
  // idempotent (an already-present tag is a no-op).
  if (!Array.isArray(tags)) {
    return {
      prev: '(tags not loaded)',
      next: `+ ${tag}`,
      willChange: true,
      skip: false,
      note: 'Existing tags not loaded yet; will add on commit (no-op if already present).'
    };
  }
  const existing = tags;
  const has = existing.includes(tag);
  return {
    prev: existing.length ? existing.join(', ') : '(none)',
    next: has ? existing.join(', ') : existing.concat([tag]).join(', '),
    willChange: !has,
    skip: has,
    note: has ? 'Already tagged; will skip.' : null
  };
}

export async function commit(target, params, { client }) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  // FMN-207: chip-fetch already learned the instance doesn't exist
  // (target.tags === null). Skip the commit-time GET round-trip and
  // report as a skip without an API call.
  // FMN-258: ONLY an explicit null short-circuits. undefined means the tag
  // list was never fetched (operator advanced fast); fall through to
  // addServerTag, whose own GET-modify-PUT is authoritative and idempotent.
  // A genuine 404 there is caught below. Previously `undefined` also skipped,
  // silently dropping the add on a fast Configure -> Commit.
  if (target?.tags === null) {
    return { status: 0, addedTags: [], tagsAfter: null, noop: true, skipped: true };
  }
  try {
    const result = await client.addServerTag(target.id, [v.value.tag]);
    return {
      status: result.status,
      addedTags: result.addedTags,
      tagsAfter: result.tagsAfter,
      noop: result.addedTags.length === 0,
      skipped: result.addedTags.length === 0
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
