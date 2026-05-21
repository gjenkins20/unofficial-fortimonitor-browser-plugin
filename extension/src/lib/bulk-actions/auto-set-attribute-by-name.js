// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-226: Bulk action - Auto-set instance attributes by name regex.
//
// Sibling of FMN-225 (auto-tag-by-name); writes attributes instead of
// tags.
//
// params: {
//   regex: string,
//   valueTemplate: string,        e.g. '$1'
//   attributeTypeUrl: string,     full v2 url for an existing
//                                 server_attribute_type ("the key")
//   attributeTypeName?: string    display-only; passed in by configure step
// }
// target: { id, name, attributes?: [{ name, textkey, value, typeUrl, resourceUrl, ... }] }
//
// describe() per row:
//   * no regex match              -> skip
//   * empty substitution result   -> skip
//   * attributes unknown          -> placeholder branch (Preview will
//                                    refresh once the live fetch lands)
//   * existing attribute with the
//     same typeUrl + same value   -> skip (idempotent)
//   * existing attribute with the
//     same typeUrl + different
//     value                       -> v1 reports a CONFLICT (skip; operator
//                                    must resolve in FortiMonitor). The
//                                    underlying server_attribute model
//                                    allows multi-value per type, but
//                                    most operator intents read as
//                                    "single canonical value per key";
//                                    don't double-write.
//   * no existing attribute       -> will create
//
// commit() does the authoritative re-check (listServerAttributes) then
// POST createServerAttribute. Built-in (non-customer-defined) attribute
// types live inline on the server record and never appear in the type
// catalog, so this action is implicitly restricted to customer-defined
// types: there's no typeUrl to choose for "Model" / "Operating System".

export const id = 'auto-set-attribute-by-name';
export const label = 'Auto-set attribute by name pattern';
export const description = 'Set a server attribute derived from a regex match against each instance name. The value template can reference capture groups via $1, $2, etc.';
export const requires = 'apiKey';
export const writeMethod = 'POST /server/{id}/server_attribute';

export function validate(params = {}) {
  const pattern = String(params?.regex ?? '').trim();
  if (!pattern) return { ok: false, error: 'Regex is required.' };
  let re;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return { ok: false, error: `Invalid regex: ${err?.message ?? err}` };
  }
  const valueTemplate = String(params?.valueTemplate ?? '').trim();
  if (!valueTemplate) return { ok: false, error: 'Value template is required.' };
  if (valueTemplate.length > 200) return { ok: false, error: 'Value template is unusually long (>200 chars).' };
  const attributeTypeUrl = String(params?.attributeTypeUrl ?? '').trim();
  if (!attributeTypeUrl) return { ok: false, error: 'Attribute type is required.' };
  return {
    ok: true,
    value: {
      regex: pattern,
      regexObject: re,
      valueTemplate,
      attributeTypeUrl,
      attributeTypeName: typeof params?.attributeTypeName === 'string' ? params.attributeTypeName : null
    }
  };
}

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

function findExisting(attributes, typeUrl) {
  if (!Array.isArray(attributes)) return null;
  return attributes.find((a) => a && a.typeUrl === typeUrl) || null;
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
  const value = applyTemplate(v.value.valueTemplate, m);
  if (!value || !value.trim()) {
    return {
      prev: name,
      next: '(empty value)',
      willChange: false,
      skip: true,
      note: 'Capture-group substitution produced an empty value; will skip.'
    };
  }
  const keyLabel = v.value.attributeTypeName || '(attribute)';
  const attrs = Array.isArray(target?.attributes) ? target.attributes : null;
  if (attrs === null) {
    return {
      prev: '(attributes unknown)',
      next: `+ ${keyLabel} = ${value}`,
      willChange: true,
      note: 'Attribute list not yet fetched; commit will pre-flight.'
    };
  }
  const existing = findExisting(attrs, v.value.attributeTypeUrl);
  if (existing) {
    if (String(existing.value) === value) {
      return {
        prev: `${keyLabel} = ${existing.value}`,
        next: `${keyLabel} = ${existing.value}`,
        willChange: false,
        skip: true,
        note: `Attribute "${keyLabel}" already set to "${value}"; will skip.`
      };
    }
    return {
      prev: `${keyLabel} = ${existing.value}`,
      next: `(conflict; matched "${m[0]}" -> ${value})`,
      willChange: false,
      skip: true,
      conflict: true,
      note: `Instance already has "${keyLabel}" = "${existing.value}"; v1 won't overwrite. Resolve in FortiMonitor or pick a different key.`
    };
  }
  return {
    prev: '(none)',
    next: `+ ${keyLabel} = ${value}`,
    willChange: true,
    note: `Will set ${keyLabel} = "${value}" (matched "${m[0]}").`
  };
}

export async function commit(target, params, ctx = {}) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  const { client } = ctx;
  if (!client) throw new Error('PanoptaClient required for createServerAttribute.');
  const name = typeof target?.name === 'string' ? target.name : '';
  const m = v.value.regexObject.exec(name);
  if (!m) {
    return { status: 0, noop: true, skipped: true, reason: 'no-regex-match' };
  }
  const value = applyTemplate(v.value.valueTemplate, m);
  if (!value || !value.trim()) {
    return { status: 0, noop: true, skipped: true, reason: 'empty-value-after-substitution' };
  }
  // Authoritative re-check against live state. We don't trust target.attributes
  // because it may be stale between Configure and Apply.
  let liveAttrs;
  try {
    liveAttrs = await client.listServerAttributes(target.id);
  } catch (err) {
    if (err?.status === 404) {
      throw new Error(`Instance #${target.id} not found on this tenant.`);
    }
    throw err;
  }
  const existing = findExisting(liveAttrs, v.value.attributeTypeUrl);
  if (existing) {
    if (String(existing.value) === value) {
      return { status: 200, noop: true, skipped: true, reason: 'already-set', attribute: { key: v.value.attributeTypeName, value } };
    }
    return {
      status: 200,
      noop: true,
      skipped: true,
      reason: 'conflict-existing-value',
      attribute: { key: v.value.attributeTypeName, value },
      currentValue: existing.value
    };
  }
  const created = await client.createServerAttribute(target.id, {
    typeUrl: v.value.attributeTypeUrl,
    value
  });
  return {
    status: created.status,
    noop: false,
    attribute: { key: v.value.attributeTypeName, value, resourceUrl: created.location, id: created.resourceId }
  };
}
