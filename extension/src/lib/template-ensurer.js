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
 * @property {string} plugin_textkey      Required - device's monitoring
 *                                        category textkey (e.g.
 *                                        "fortinet.fortigate",
 *                                        "fortinet.fortiap"). Sourced
 *                                        from the cluster's per-device
 *                                        monitoring_config. No default
 *                                        fallback (FMN-211): a missing
 *                                        plugin_textkey reaching this
 *                                        layer means the clusterer or
 *                                        caller skipped a field; refuse
 *                                        the write rather than guess.
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

  // Live tenant observation (2026-05-13): /config/createServerTemplate
  // often returns HTTP 504 even though the server-side create finished
  // (verified: 10/10 504-failed attempts during FMN-200 phase F QA
  // created the template anyway, just couldn't deliver the success
  // response under the gateway's ~90s window). Strategy: race the create
  // fetch against a poll loop that watches for the new template name to
  // appear in listTemplates. Whichever resolves first wins. The poll
  // pessimistically caps at 120s so true failures still surface.
  const createPromise = fmClient.createServerTemplate({
    name, templateType, destinationGroup, sourceServerId, selectOptions
  }).then(() => ({ source: 'create' }), (err) => ({ source: 'create-error', err }));

  const pollPromise = (async () => {
    const maxMs = 120_000;
    const start = Date.now();
    let lastListSize = -1;
    while (Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 3_000));
      const list = await panopta.listTemplates();
      lastListSize = list.length;
      const hit = list.find((t) => t.name === name);
      if (hit) return { source: 'poll', hit };
    }
    return { source: 'poll-timeout', lastListSize };
  })();

  const raceResult = await Promise.race([createPromise, pollPromise]);

  let created = null;
  if (raceResult.source === 'poll') {
    created = raceResult.hit;
  } else if (raceResult.source === 'create') {
    // create resolved cleanly; do one more list to grab the id
    const list = await panopta.listTemplates();
    created = list.find((t) => t.name === name) || null;
  } else if (raceResult.source === 'create-error') {
    // create threw; await the poll to either find the template (server
    // succeeded despite the error) or report poll-timeout (real failure).
    const polled = await pollPromise;
    if (polled.source === 'poll') {
      created = polled.hit;
    } else {
      throw raceResult.err;
    }
  }
  if (!created) {
    throw new Error('createServerTemplate completed but new template not findable by name');
  }

  let populated_count = 0;
  if (!sourceServerId && Array.isArray(resources) && resources.length > 0) {
    for (const r of resources) {
      if (!r || !r.resource_textkey) continue;
      if (!r.plugin_textkey || typeof r.plugin_textkey !== 'string') {
        // FMN-211: refuse to write a metric whose plugin_textkey wasn't
        // captured. Routing a FortiAP metric through "fortinet.fortigate"
        // (the old fallback) would silently corrupt the template. The
        // clusterer reads category.textkey from the device's actual
        // monitoring_config; a missing value means the source data
        // wasn't populated correctly.
        throw new Error(`ensureTemplate: resource "${r.resource_textkey}" has no plugin_textkey; cannot route addTemplateMetric without knowing the device's monitoring category`);
      }
      await fmClient.addTemplateMetric({
        templateId: created.id,
        pluginTextkey: r.plugin_textkey,
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
