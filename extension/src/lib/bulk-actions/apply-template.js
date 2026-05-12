// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155: Bulk action - Apply Template.
//
// params: { templateUrl: string, templateId: number, templateName: string,
//           continuous?: boolean }
//
// Uses the existing PanoptaClient.attachTemplate() (POST /server/{id}/
// template). The v2 API does NOT dedupe; a repeat POST creates a
// second mapping row. commit() pre-flights via listServerTemplateMappings
// to short-circuit when the template is already attached.

export const id = 'apply-template';
export const label = 'Apply Template';
export const description = 'Attach a monitoring template to each selected instance. Already-attached instances are skipped.';
export const requires = 'apiKey';
export const writeMethod = 'POST /server/{id}/template';

export function validate(params = {}) {
  const url = String(params?.templateUrl ?? '').trim();
  if (!url) return { ok: false, error: 'Template is required.' };
  return {
    ok: true,
    value: {
      templateUrl: url,
      templateId: params?.templateId ?? null,
      templateName: String(params?.templateName ?? '').trim() || null,
      continuous: params?.continuous !== false
    }
  };
}

export function describe(target, params) {
  const v = validate(params);
  if (!v.ok) return { prev: '-', next: '-', willChange: false, error: v.error };
  const { templateName, templateUrl } = v.value;
  const label = templateName || templateUrl;
  const templates = Array.isArray(target?.template_names) ? target.template_names : null;
  if (templates === null) {
    return {
      prev: '(templates unknown)',
      next: `+ ${label}`,
      willChange: true,
      note: 'Server template list not in cache; commit will pre-flight.'
    };
  }
  const has = templates.includes(label);
  return {
    prev: templates.length ? templates.join(', ') : '(none)',
    next: has ? templates.join(', ') : templates.concat([label]).join(', '),
    willChange: !has,
    note: has ? 'Template already attached; commit will skip.' : null
  };
}

export async function commit(target, params, { client }) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  const { templateUrl, templateId, continuous } = v.value;
  // Pre-flight to avoid creating duplicate mapping rows.
  const mappings = await client.listServerTemplateMappings(target.id);
  if (mappings.some((m) => m.templateUrl === templateUrl || (templateId && m.templateId === templateId))) {
    return { status: 200, noop: true, reason: 'already-attached' };
  }
  const result = await client.attachTemplate(target.id, { templateUrl, continuous });
  return {
    status: result.status,
    noop: false,
    mappingId: result.resourceId ?? null,
    templateId
  };
}
