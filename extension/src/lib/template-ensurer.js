// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-200: idempotent ensure-template helper.
//
// Pure-orchestration logic; clients (PanoptaClient + FortimonitorClient)
// are injected so this module is testable in Node without Chrome APIs.
// Both the SW handler (bulk-composer:ensure-template) and the action
// descriptor (apply-best-practice-fabric-template) call this helper.
//
// Behavior:
//   1. Look up existing template by exact name via panopta.listTemplates.
//   2. If found, return reused.
//   3. If dryRun, return would_create signal without writes.
//   4. Otherwise, create the template shell via
//      fmClient.createServerTemplate. Re-list to discover the new id
//      (FMN-199 capture showed the response body is too thin to extract
//      id reliably).
//   5. For each resource, call fmClient.addTemplateMetric. Skipped when
//      sourceServerId was set (clone-from-device already populates).

/**
 * @typedef {Object} EnsureResourceSpec
 * @property {string} resource_textkey
 * @property {string} [plugin_textkey]    Defaults to "fortinet.fortigate".
 * @property {string} [name]
 * @property {string} [units]
 *
 * @typedef {Object} EnsureTemplateOptions
 * @property {string} name                Template name. Idempotence key.
 * @property {string} templateType        e.g. "fabric_template".
 * @property {string} destinationGroup    e.g. "grp-617598".
 * @property {number|null} [sourceServerId]  Set for clone-from-device.
 * @property {"yes"|"no"} [selectOptions]    Mirror of the SPA's
 *                                           select_options field.
 *                                           FMN-203 finding: must be "yes"
 *                                           for a populated clone when
 *                                           sourceServerId is set.
 * @property {EnsureResourceSpec[]} [resources]
 * @property {boolean} [dryRun]
 *
 * @typedef {Object} EnsureResult
 * @property {number|null} templateId
 * @property {string} name
 * @property {boolean} created
 * @property {boolean} reused
 * @property {number} populated_count
 * @property {boolean} dry_run
 * @property {boolean} [would_create]
 * @property {number} [would_populate_count]
 *
 * @typedef {Object} EnsureClients
 * @property {{ listTemplates: () => Promise<Array<{id:number, name:string}>> }} panopta
 * @property {{
 *   createServerTemplate: (opts: object) => Promise<any>,
 *   addTemplateMetric: (opts: object) => Promise<any>
 * }} fmClient
 */

/**
 * @param {EnsureClients} clients
 * @param {EnsureTemplateOptions} opts
 * @returns {Promise<EnsureResult>}
 */
export async function ensureTemplate({ panopta, fmClient }, opts = {}) {
  const {
    name,
    templateType,
    destinationGroup,
    sourceServerId = null,
    selectOptions = sourceServerId == null ? 'no' : 'yes',
    resources = [],
    dryRun = false
  } = opts;

  if (!name || typeof name !== 'string') {
    throw new Error('ensureTemplate: name is required');
  }
  if (!templateType || typeof templateType !== 'string') {
    throw new Error('ensureTemplate: templateType is required');
  }
  if (!destinationGroup || typeof destinationGroup !== 'string') {
    throw new Error('ensureTemplate: destinationGroup is required');
  }
  if (!panopta || typeof panopta.listTemplates !== 'function') {
    throw new Error('ensureTemplate: panopta.listTemplates is required');
  }
  if (!fmClient || typeof fmClient.createServerTemplate !== 'function' || typeof fmClient.addTemplateMetric !== 'function') {
    throw new Error('ensureTemplate: fmClient.createServerTemplate + addTemplateMetric are required');
  }

  const existing = (await panopta.listTemplates()).find((t) => t.name === name);
  if (existing) {
    return {
      templateId: existing.id,
      name: existing.name,
      created: false,
      reused: true,
      populated_count: 0,
      dry_run: !!dryRun
    };
  }
  if (dryRun) {
    return {
      templateId: null,
      name,
      created: false,
      reused: false,
      would_create: true,
      would_populate_count: Array.isArray(resources) ? resources.length : 0,
      populated_count: 0,
      dry_run: true
    };
  }

  await fmClient.createServerTemplate({
    name,
    templateType,
    destinationGroup,
    sourceServerId,
    selectOptions
  });
  const created = (await panopta.listTemplates()).find((t) => t.name === name);
  if (!created) {
    throw new Error('createServerTemplate succeeded but new template not findable by name');
  }

  let populated_count = 0;
  if (!sourceServerId && Array.isArray(resources) && resources.length > 0) {
    for (const r of resources) {
      if (!r || !r.resource_textkey) continue;
      await fmClient.addTemplateMetric({
        templateId: created.id,
        pluginTextkey: r.plugin_textkey || 'fortinet.fortigate',
        resourceTextkey: r.resource_textkey,
        pluginName: r.name || r.resource_textkey,
        resourceName: r.name || r.resource_textkey,
        units: r.units || ''
      });
      populated_count += 1;
    }
  }
  return {
    templateId: created.id,
    name: created.name,
    created: true,
    reused: false,
    populated_count,
    dry_run: false
  };
}
