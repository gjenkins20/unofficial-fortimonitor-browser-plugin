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
  const tags = target?.tags;
  // FMN-207: target.tags === null after the always-live chip-fetch
  // (FMN-206) means the live GET 404'd - the instance doesn't exist on
  // this tenant. Skip with clear copy; the legacy "(tags unknown) /
  // read-modify-write" branch was for the dead cache-first path.
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
  // yet (operator advanced fast). The current tags are UNKNOWN - do NOT
  // collapse that into "not found / skip" (it silently dropped the removal).
  // Classify optimistically and let commit()'s authoritative GET-modify-PUT
  // decide; removeServerTag is idempotent (an absent tag is a no-op).
  if (!Array.isArray(tags)) {
    return {
      prev: '(tags not loaded)',
      next: `- ${tag}`,
      willChange: true,
      skip: false,
      note: 'Existing tags not loaded yet; will attempt removal on commit (no-op if absent).'
    };
  }
  const existing = tags;
  const has = existing.includes(tag);
  const after = existing.filter((t) => t !== tag);
  return {
    prev: existing.length ? existing.join(', ') : '(none)',
    next: has ? (after.length ? after.join(', ') : '(none)') : existing.join(', '),
    willChange: has,
    skip: !has,
    note: has ? null : 'Tag not present; will skip.'
  };
}

export async function commit(target, params, { client }) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  // FMN-207: chip-fetch already learned the instance doesn't exist
  // (target.tags === null). Skip the commit-time GET round-trip and
  // report as a skip without an API call. Operator can re-run if state
  // changed in the seconds between chip-fetch and commit.
  // FMN-258: ONLY an explicit null short-circuits. undefined means the tag
  // list was never fetched (fast advance); fall through to removeServerTag,
  // whose own GET-modify-PUT is authoritative and idempotent. Previously
  // `undefined` also skipped, silently dropping the removal.
  if (target?.tags === null) {
    return { status: 0, removedTags: [], tagsAfter: null, noop: true, skipped: true };
  }
  try {
    const result = await client.removeServerTag(target.id, [v.value.tag]);
    return {
      status: result.status,
      removedTags: result.removedTags,
      tagsAfter: result.tagsAfter,
      noop: result.removedTags.length === 0,
      skipped: result.removedTags.length === 0
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
