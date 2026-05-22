// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-200: Bulk action - Profile + Create Templates from similar devices.
//
// Consumes the cluster list built by the Configure step (FMN-200 phase E):
// runs template-ensurer per cluster (memoized through ctx.sharedState so
// concurrent commits for the same cluster don't race), then attaches
// the resulting template to each picked device in the cluster.
//
// params shape (built by Configure step):
//   {
//     dry_run: bool,
//     destination_group: 'grp-{id}',   // tenant server group for new templates
//     template_type: 'fabric_template' (default) | other,
//     clusters: [
//       {
//         key,                              // stable cluster id
//         make, model,
//         applies_to_server_ids: number[],
//         proposed_template_name: string,   // operator-editable in UI
//         proposed_resources: [{ plugin_textkey, resource_textkey, name, units? }, ...],
//         sample_device_id: number,         // representative device
//         opted_in: bool,
//         clone_from_device: bool           // when true, creates via clone path (sourceServerId)
//       },
//       ...
//     ]
//   }

import { ensureTemplate } from '../template-ensurer.js';

export const id = 'profile-and-create-templates';
export const label = 'Profile + Create Templates';
export const description = 'Cluster Fabric devices by configuration similarity, propose one template per cluster, create + attach.';
export const requires = 'apiKey+session';
export const writeMethod = 'POST /config/createServerTemplate + /config/monitoring/editAgentMetric + /server/{id}/template';

export function validate(params = {}) {
  const clusters = Array.isArray(params?.clusters) ? params.clusters : null;
  if (!clusters) return { ok: false, error: 'clusters list is required.' };
  const optedIn = clusters.filter((c) => c && c.opted_in === true);
  if (optedIn.length === 0) {
    return { ok: false, error: 'No clusters opted in. Check at least one row in the Configure step.' };
  }
  const destGroup = String(params?.destination_group ?? '').trim();
  const newGroupName = String(params?.destination_group_create_name ?? '').trim();
  if (!destGroup && !newGroupName) {
    return { ok: false, error: 'Destination group is required: pick an existing group or enter a new group name.' };
  }
  if (destGroup && newGroupName) {
    return { ok: false, error: 'Pick either an existing group OR enter a new group name, not both.' };
  }
  for (const c of optedIn) {
    if (!c.key || typeof c.key !== 'string') {
      return { ok: false, error: 'Each opted-in cluster must carry a key.' };
    }
    if (!Array.isArray(c.applies_to_server_ids) || c.applies_to_server_ids.length === 0) {
      return { ok: false, error: `Cluster "${c.key}" has no target server ids.` };
    }
    if (!c.proposed_template_name || typeof c.proposed_template_name !== 'string') {
      return { ok: false, error: `Cluster "${c.key}" has no proposed_template_name.` };
    }
  }
  return {
    ok: true,
    value: {
      dry_run: params?.dry_run === true,
      destination_group: destGroup || null,
      destination_group_create_name: newGroupName || null,
      template_type: typeof params?.template_type === 'string' && params.template_type.trim()
        ? params.template_type.trim()
        : 'fabric_template',
      create_mpws: params?.create_mpws === true,
      clusters
    }
  };
}

export function describe(target, params) {
  const v = validate(params);
  if (!v.ok) return { prev: '-', next: '-', willChange: false, error: v.error };
  const cluster = findClusterForTarget(target, v.value.clusters);
  if (!cluster) {
    return {
      prev: '(unmatched)',
      next: '(skipped)',
      willChange: false,
      note: 'This device is not in an opted-in cluster.'
    };
  }
  const dryRun = v.value.dry_run;
  const templates = Array.isArray(target?.template_names) ? target.template_names : null;
  const tName = cluster.proposed_template_name;
  if (templates === null) {
    return {
      prev: '',
      next: `${dryRun ? '(dry-run) ' : ''}+ ${tName}`,
      willChange: true,
      note: `${dryRun ? 'Dry-run: no writes will be made. ' : ''}Will ensure cluster template "${tName}" and attach it to this device (skipped at commit if already attached).`
    };
  }
  const has = templates.includes(tName);
  return {
    prev: templates.length ? templates.join(', ') : '(none)',
    next: has ? templates.join(', ') : templates.concat([tName]).join(', '),
    willChange: !has,
    note: (dryRun ? 'Dry-run: no writes will be made. ' : '')
      + (has
          ? `Template "${tName}" already attached; commit will skip.`
          : `Will ensure cluster template "${tName}" and attach it to this device.`)
  };
}

export async function commit(target, params, ctx = {}) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  const { dry_run: dryRun, destination_group, destination_group_create_name, template_type, create_mpws, clusters } = v.value;
  const { client, fortimonitorClient, sharedState } = ctx;
  if (!client) throw new Error('PanoptaClient required for template attach + name lookup.');
  if (!fortimonitorClient) throw new Error('FortimonitorClient required for template create.');
  if (!(sharedState instanceof Map)) {
    throw new Error('sharedState Map required (per-run scoping for ensure-template memoization).');
  }

  const cluster = findClusterForTarget(target, clusters);
  if (!cluster) {
    return { status: 200, noop: true, reason: 'no-matching-cluster', dry_run: dryRun };
  }

  // Resolve destination group: pick the prefixed id directly, or ensure
  // the named group exists (memoized so concurrent commits for the same
  // run don't race to create the group multiple times).
  const resolvedDestGroup = await ensureDestinationGroup({
    destination_group,
    destination_group_create_name,
    panopta: client,
    sharedState,
    dryRun
  });

  // FMN-211: per-cluster template_type. The Configure step now sources
  // each cluster's template_type from /config/get_create_server_template_data
  // for the cluster's representative device (Fabric FortiAP/Switch
  // returns "fabric_template"; SNMP-monitored devices return
  // "network_device_template"). Fall back to the params-level default
  // (always "fabric_template") for clusters that didn't have a defaults
  // fetch resolved.
  const clusterTemplateType = (typeof cluster.template_type === 'string' && cluster.template_type.trim())
    ? cluster.template_type.trim()
    : template_type;

  const ensureResult = await ensureForCluster(cluster, {
    panopta: client,
    fmClient: fortimonitorClient,
    sharedState,
    destination_group: resolvedDestGroup,
    template_type: clusterTemplateType,
    dryRun
  });

  // FMN-228: optional MPW authoring step. Same shared-state memoization
  // pattern apply-stock-fabric-templates uses: first commit for a cluster
  // creates the cached MPW promise; the rest await it. Memoizes the
  // rulesets list + nounOptions fetch so we don't hammer the
  // monitoring_policy endpoints across concurrent per-target commits.
  let mpwResult = null;
  if (create_mpws) {
    mpwResult = await ensureMpwForCluster(cluster, {
      ensureResult,
      fmClient: fortimonitorClient,
      panoptaClient: client,
      sharedState,
      dryRun
    });
  }

  if (dryRun) {
    return {
      status: 200,
      noop: false,
      reason: 'dry-run',
      dry_run: true,
      template: {
        name: ensureResult.name,
        would_create: !!ensureResult.would_create,
        would_populate_count: ensureResult.would_populate_count ?? 0,
        would_attach: true
      },
      mpw: mpwResult
    };
  }

  // Attach the template to this device. Reuses the apply-template
  // pre-flight pattern from FMN-155 (PanoptaClient.attachTemplate +
  // listServerTemplateMappings idempotence check).
  const templateUrl = buildTemplateUrlFromId(ensureResult.templateId, client);
  const mappings = await client.listServerTemplateMappings(target.id);
  const alreadyAttached = mappings.some((m) =>
    m.templateId === ensureResult.templateId
    || (templateUrl && m.templateUrl === templateUrl)
  );
  if (alreadyAttached) {
    return {
      status: 200,
      noop: ensureResult.created === false && ensureResult.reused === true,
      reason: 'template-already-attached',
      dry_run: false,
      mpw: mpwResult,
      template: {
        id: ensureResult.templateId,
        name: ensureResult.name,
        created: ensureResult.created,
        reused: ensureResult.reused,
        populated_count: ensureResult.populated_count
      }
    };
  }

  const attachResult = await client.attachTemplate(target.id, {
    templateUrl,
    continuous: true
  });
  return {
    status: attachResult.status,
    noop: false,
    dry_run: false,
    mpw: mpwResult,
    template: {
      id: ensureResult.templateId,
      name: ensureResult.name,
      created: ensureResult.created,
      reused: ensureResult.reused,
      populated_count: ensureResult.populated_count,
      mappingId: attachResult.resourceId ?? null
    }
  };
}

// ---------- helpers ----------

function findClusterForTarget(target, clusters) {
  if (!target || target.id == null) return null;
  for (const c of clusters) {
    if (c?.opted_in !== true) continue;
    if (!Array.isArray(c.applies_to_server_ids)) continue;
    if (c.applies_to_server_ids.includes(target.id)) return c;
  }
  return null;
}

function buildTemplateUrlFromId(templateId, client) {
  if (templateId == null) return null;
  const base = (client?.baseUrl || '').replace(/\/$/, '');
  return `${base}/server_template/${encodeURIComponent(templateId)}`;
}

/**
 * Resolve the destination server group. Two paths:
 *
 *   1. destination_group set (e.g. "grp-617598") - return as-is.
 *   2. destination_group_create_name set - look up by name; if found,
 *      return its prefixed id. If not found, create via
 *      PanoptaClient.createServerGroup, then return.
 *
 * Memoized in sharedState by the input key, so concurrent commits for
 * the same run share one resolution / create operation.
 *
 * Dry-run: looks up by name (read); if not found, returns a placeholder
 * value WITHOUT creating. The placeholder is "(would-create) <name>"
 * which downstream surfaces in the dry-run row's note.
 */
async function ensureDestinationGroup({ destination_group, destination_group_create_name, panopta, sharedState, dryRun }) {
  if (destination_group) return destination_group;
  const name = destination_group_create_name;
  const cacheKey = `server_group:${dryRun ? 'dry:' : ''}${name}`;
  const cached = sharedState.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    const groups = await panopta.listServerGroups();
    const existing = groups.find((g) => g && g.name === name);
    if (existing) return `grp-${existing.id}`;
    if (dryRun) {
      // Dry-run: do not create. Return a placeholder string so the
      // downstream ensureTemplate input validation passes (the value
      // never reaches the wire in dry-run mode).
      return `(would-create) ${name}`;
    }
    const created = await panopta.createServerGroup(name);
    if (!created || created.id == null) {
      throw new Error(`createServerGroup for "${name}" returned no id`);
    }
    // FMN-237: record run-scoped creation so the commit handler can
    // pull it into the journal after settle. Per-row results don't
    // carry this (it's shared across the whole run).
    const journaled = sharedState.get('__journaled.server_groups') || [];
    journaled.push({ id: created.id, name: created.name ?? name });
    sharedState.set('__journaled.server_groups', journaled);
    return `grp-${created.id}`;
  })();
  sharedState.set(cacheKey, promise);
  return promise;
}

/**
 * Memoized ensure-template per cluster. First commit for a cluster runs
 * the create+populate; subsequent commits for the same cluster (within
 * the same run) await the same promise. Late-comers override created /
 * would_create to false so per-row UI distinguishes "this row caused the
 * create" from "another row did."
 */
function ensureForCluster(cluster, { panopta, fmClient, sharedState, destination_group, template_type, dryRun }) {
  const stateKey = dryRun ? `template:dry:${cluster.key}` : `template:${cluster.key}`;
  const cached = sharedState.get(stateKey);
  if (cached) {
    return cached.then((result) => ({
      ...result,
      created: false,
      reused: result.reused,
      would_create: false
    }));
  }
  const cloneFromDevice = cluster.clone_from_device === true;
  const promise = ensureTemplate(
    { panopta, fmClient },
    {
      name: cluster.proposed_template_name,
      templateType: template_type,
      destinationGroup: destination_group,
      sourceServerId: cloneFromDevice ? cluster.sample_device_id : null,
      // FMN-200 follow-up: select_options must be "yes" for a populated
      // clone (FMN-203 finding: select_options="no" produces empty shell
      // even with sourceServerId set). For the non-clone path the value
      // doesn't affect the populate logic (we run per-metric add via
      // addTemplateMetric), but defaulting "yes" keeps the wire
      // consistent with the SPA's own create-from-device flow.
      selectOptions: cloneFromDevice ? 'yes' : 'no',
      resources: cluster.proposed_resources || [],
      dryRun
    }
  );
  sharedState.set(stateKey, promise);
  return promise;
}

// FMN-228: optional MPW-authoring step. Adapts the createOrFindPolicy /
// simulatePolicyCreate pattern from apply-stock-fabric-templates.js to
// the profile-and-create-templates surface. One MPW per cluster, keyed
// by name so re-runs are idempotent. The MPW is generated AFTER the
// cluster's template is ensured so it can reference the new template id.
async function ensureMpwForCluster(cluster, { ensureResult, fmClient, panoptaClient, sharedState, dryRun }) {
  if (!cluster || !ensureResult) return null;
  const proposalName = buildMpwName(cluster, ensureResult);
  const stateKey = dryRun ? `mpw:dry:${cluster.key}` : `mpw:${cluster.key}`;
  const cached = sharedState.get(stateKey);
  if (cached) return cached;
  const promise = dryRun
    ? simulateMpwCreate(cluster, ensureResult, proposalName, fmClient, sharedState)
    : createOrFindMpw(cluster, ensureResult, proposalName, fmClient, sharedState, panoptaClient);
  sharedState.set(stateKey, promise);
  return promise;
}

function buildMpwName(cluster, ensureResult) {
  const templateName = ensureResult.name || cluster.proposed_template_name || '(template)';
  const make = cluster.make || '(make)';
  const model = cluster.model || '(model)';
  return `Toolkit: auto-attach ${templateName} to ${make} ${model}`;
}

async function createOrFindMpw(cluster, ensureResult, proposalName, fmClient, sharedState, panoptaClient) {
  const rulesets = await getCachedRulesets(fmClient, sharedState);
  const existing = rulesets.find((r) => r && r.name === proposalName);
  if (existing) {
    return { id: existing.id, name: existing.name, created: false, reused: true };
  }
  // Need nounOptions for clause construction. Memoize alongside rulesets.
  const nounOptions = await getCachedNounOptions(fmClient, sharedState);
  // FMN-228 QA fix (2026-05-21): fetch the sample device's actual
  // server_attribute values so the attribute clause's match_value
  // matches what the device carries (e.g. fortigate.model="FGVMA6"),
  // not the cluster.model field (which is fabricSystemData.model_number
  // like "VM64-AWS" - a different namespace).
  const sampleAttrs = await getSampleDeviceAttributes(cluster, panoptaClient, sharedState);
  const clauses = buildClausesFromCluster(cluster, nounOptions, sampleAttrs);
  const warnings = [];
  if (clauses.length === 0) {
    warnings.push('No vocabulary entries for this cluster\'s make/model; MPW created without predicate (will match everything by default).');
  }
  const created = await fmClient.createMonitoringPolicy({
    name: proposalName,
    index: 0,
    description: ''
  });
  const config = {
    rules: [
      {
        enabled: true,
        name: `Apply ${ensureResult.name} to ${cluster.make} ${cluster.model}`,
        conditions: [
          {
            clauses: clauses.map((c) => ({ ...c, error: false })),
            operator: 'and'
          }
        ],
        actions: [
          { action_type: 'apply_template', action_value: String(ensureResult.templateId) }
        ]
      }
    ]
  };
  await fmClient.updateMonitoringPolicyConfig(created.id, config);
  return { id: created.id, name: created.name, created: true, reused: false, warnings };
}

async function simulateMpwCreate(cluster, ensureResult, proposalName, fmClient, sharedState) {
  // Dry-run: still read rulesets so the per-row result reflects the
  // would-create-vs-would-skip decision honestly.
  const rulesets = await getCachedRulesets(fmClient, sharedState);
  const existing = rulesets.find((r) => r && r.name === proposalName);
  if (existing) {
    return { id: existing.id, name: existing.name, created: false, would_create: false, reused: true };
  }
  return { id: null, name: proposalName, created: false, would_create: true, reused: false };
}

function getCachedRulesets(fmClient, sharedState) {
  const key = 'mpw:rulesets';
  const cached = sharedState.get(key);
  if (cached) return cached;
  const promise = fmClient.getMonitoringPolicyPageData().then((data) =>
    Array.isArray(data?.rulesets) ? data.rulesets : []
  );
  sharedState.set(key, promise);
  return promise;
}

function getCachedNounOptions(fmClient, sharedState) {
  const key = 'mpw:nounOptions';
  const cached = sharedState.get(key);
  if (cached) return cached;
  const promise = fmClient.getMonitoringPolicyPageData().then((data) => data?.nounOptions ?? {});
  sharedState.set(key, promise);
  return promise;
}

// Build the policy clauses from a cluster's (make, model) plus the
// sample device's live server_attribute values.
//
// FMN-228 QA finding (2026-05-21):
//   * device_type clauses require match_type "pick_multiple"
//     (rendered as "Is" in the UI). "pick_one" renders blank.
//   * attribute clauses' match_value must equal the live attribute
//     value on the device (e.g. fortigate.model="FGVMA6"), NOT the
//     cluster's `model` field (which is fabricSystemData.model_number
//     like "VM64-AWS" - a different identifier namespace). If the
//     sample device doesn't carry the attribute, the model clause is
//     omitted; the rule still matches by device_type.
function buildClausesFromCluster(cluster, nounOptions, sampleAttrs = {}) {
  const out = [];
  const make = String(cluster?.make ?? '').trim();
  if (!make) return out;

  const familyList = Array.isArray(nounOptions?.device_types) ? nounOptions.device_types : [];
  const lowerMake = make.toLowerCase();
  const familyHit = familyList.find((opt) =>
    opt && typeof opt.label === 'string'
    && (opt.label.toLowerCase() === lowerMake || opt.label.toLowerCase().includes(lowerMake))
  );
  if (familyHit) {
    // FMN-228 QA finding (2026-05-21): pick_multiple match_value is a
    // JSON array of option values, not a string. Captured live from an
    // operator-built save: "match_value": ["[sub_type]fortinet.fortigate"].
    out.push({ datatype: 'device_type', match_type: 'pick_multiple', match_key: null, match_value: [familyHit.value] });
  }

  // Attribute clause: pin to the device's actual .model attribute value
  // (looked up from sampleAttrs) rather than cluster.model. The textkey
  // is discovered from the nounOptions vocabulary (e.g. fortigate.model
  // for FortiGate, fortiap.model for FortiAP).
  const groups = Array.isArray(nounOptions?.attribute_types) ? nounOptions.attribute_types : [];
  let group = groups.find((g) => g && typeof g.label === 'string' && g.label.toLowerCase() === lowerMake);
  if (!group) {
    group = groups.find((g) => g && typeof g.label === 'string' && g.label.toLowerCase().includes(lowerMake));
  }
  if (group && Array.isArray(group.options)) {
    for (const opt of group.options) {
      if (!opt || typeof opt.value !== 'string') continue;
      const i = opt.value.indexOf(',');
      const textkey = i < 0 ? opt.value : opt.value.slice(i + 1);
      if (textkey.endsWith('.model')) {
        const liveValue = sampleAttrs[textkey];
        if (liveValue !== undefined && liveValue !== null && String(liveValue).trim() !== '') {
          out.push({ datatype: 'attribute', match_type: 'pick_one', match_key: textkey, match_value: String(liveValue) });
        }
        break;
      }
    }
  }
  return out;
}

// FMN-228 QA fix: fetch the cluster's representative device's
// server_attribute list once per run and memoize. Returns
// { textkey: value } so buildClausesFromCluster can resolve the
// attribute-clause match_value.
async function getSampleDeviceAttributes(cluster, panoptaClient, sharedState) {
  if (!cluster || !cluster.sample_device_id) return {};
  if (!panoptaClient || typeof panoptaClient.listServerAttributes !== 'function') return {};
  const key = `mpw:sampleAttrs:${cluster.sample_device_id}`;
  const cached = sharedState.get(key);
  if (cached) return cached;
  const promise = panoptaClient.listServerAttributes(cluster.sample_device_id)
    .then((rows) => {
      const map = {};
      for (const r of (Array.isArray(rows) ? rows : [])) {
        if (r && typeof r.textkey === 'string' && r.value !== undefined && r.value !== null) {
          map[r.textkey] = r.value;
        }
      }
      return map;
    })
    .catch(() => ({}));
  sharedState.set(key, promise);
  return promise;
}

// Exported for tests
export const _internals = { buildMpwName, buildClausesFromCluster };
