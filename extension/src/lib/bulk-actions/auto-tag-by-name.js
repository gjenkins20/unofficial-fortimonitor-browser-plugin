// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-225: Bulk action - Auto-tag instances by name regex.
//
// params: { regex: string, tagTemplate: string }
// target: { id, name, tags?: string[] }
//
// Operator authors a regex with capture groups and a tag-template that
// references those captures (e.g. regex=^FGT-(\d{3})- and
// tagTemplate=sitecode=$1 -> "FGT-684-edge-01" gets tag
// "sitecode=684"). describe() builds the resulting tag per target;
// commit() writes via existing PanoptaClient.addServerTag (idempotent
// on existing tag set).
//
// Per ticket open-question resolution: one rule per run, no presets,
// match against target.name only. Replace-existing is NOT supported
// in v1 - if the device already carries a different tag value for the
// implied key, we still add the new one rather than overwrite.

export const id = 'auto-tag-by-name';
export const label = 'Auto-tag by name pattern';
export const description = 'Apply a tag derived from a regex match against each instance name. The tag template can reference capture groups via $1, $2, etc.';
export const requires = 'apiKey';
export const writeMethod = 'PUT /server/{id}';

export function validate(params = {}) {
  const pattern = String(params?.regex ?? '').trim();
  if (!pattern) return { ok: false, error: 'Regex is required.' };
  let re;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return { ok: false, error: `Invalid regex: ${err?.message ?? err}` };
  }
  const tagTemplate = String(params?.tagTemplate ?? '').trim();
  if (!tagTemplate) return { ok: false, error: 'Tag template is required.' };
  if (tagTemplate.length > 200) return { ok: false, error: 'Tag template is unusually long (>200 chars).' };
  return { ok: true, value: { regex: pattern, regexObject: re, tagTemplate } };
}

// Substitute $1, $2, ... in the template with the corresponding capture
// group from the regex match. $0 is the full match. Unmatched
// placeholders ($3 when only $1 captured) are replaced with the empty
// string. $$ is a literal $.
export function applyTemplate(template, match) {
  if (!match) return null;
  return template.replace(/\$(\$|&|\d+)/g, (_, key) => {
    if (key === '$') return '$';
    if (key === '&') return match[0] ?? '';
    const idx = Number(key);
    if (!Number.isFinite(idx)) return '';
    return match[idx] ?? '';
  });
}

export function describe(target, params) {
  const v = validate(params);
  if (!v.ok) return { prev: '-', next: '-', willChange: false, error: v.error };
  const name = typeof target?.name === 'string' ? target.name : '';
  const m = v.value.regexObject.exec(name);
  if (!m) {
    return {
      prev: name || '(unnamed)',
      next: '(no match)',
      willChange: false,
      skip: true,
      note: 'Regex did not match this instance name; will skip.'
    };
  }
  const resultTag = applyTemplate(v.value.tagTemplate, m);
  if (!resultTag || !resultTag.trim()) {
    return {
      prev: name,
      next: '(empty tag)',
      willChange: false,
      skip: true,
      note: 'Capture-group substitution produced an empty tag; will skip.'
    };
  }
  const existing = Array.isArray(target?.tags) ? target.tags : null;
  if (existing === null) {
    return {
      prev: '(not found)',
      next: '(not found)',
      willChange: false,
      skip: true,
      note: 'Instance not found on this tenant; will skip.'
    };
  }
  const has = existing.includes(resultTag);
  return {
    prev: existing.length ? existing.join(', ') : '(none)',
    next: has ? existing.join(', ') : existing.concat([resultTag]).join(', '),
    willChange: !has,
    skip: has,
    note: has
      ? `Tag "${resultTag}" already present; will skip.`
      : `Will add tag "${resultTag}" (matched "${m[0]}").`
  };
}

export async function commit(target, params, ctx = {}) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  const { client } = ctx;
  if (!client) throw new Error('PanoptaClient required for addServerTag.');
  const name = typeof target?.name === 'string' ? target.name : '';
  const m = v.value.regexObject.exec(name);
  if (!m) {
    return { status: 0, noop: true, skipped: true, reason: 'no-regex-match' };
  }
  const resultTag = applyTemplate(v.value.tagTemplate, m);
  if (!resultTag || !resultTag.trim()) {
    return { status: 0, noop: true, skipped: true, reason: 'empty-tag-after-substitution' };
  }
  // FMN-207 echo: cached null tags == instance not found, skip without GET round-trip.
  if (target?.tags === null) {
    return { status: 0, noop: true, skipped: true, reason: 'instance-not-found' };
  }
  try {
    const result = await client.addServerTag(target.id, [resultTag]);
    return {
      status: result.status,
      tag: resultTag,
      added: result.addedTags.length > 0,
      noop: result.addedTags.length === 0,
      skipped: result.addedTags.length === 0,
      tagsAfter: result.tagsAfter
    };
  } catch (err) {
    if (err?.status === 404) {
      throw new Error(`Instance #${target.id} not found on this tenant.`);
    }
    throw err;
  }
}
