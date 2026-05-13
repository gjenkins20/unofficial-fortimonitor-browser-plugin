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
      prev: '(templates unknown)',
      next: `${dryRun ? '(dry-run) ' : ''}+ ${tName}`,
      willChange: true,
      note: `${dryRun ? 'Dry-run: no writes will be made. ' : ''}Template list not in cache; commit will pre-flight.`
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
  const { dry_run: dryRun, destination_group, destination_group_create_name, template_type, clusters } = v.value;
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

  const ensureResult = await ensureForCluster(cluster, {
    panopta: client,
    fmClient: fortimonitorClient,
    sharedState,
    destination_group: resolvedDestGroup,
    template_type,
    dryRun
  });

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
      }
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
  const promise = ensureTemplate(
    { panopta, fmClient },
    {
      name: cluster.proposed_template_name,
      templateType: template_type,
      destinationGroup: destination_group,
      sourceServerId: cluster.clone_from_device === true ? cluster.sample_device_id : null,
      resources: cluster.proposed_resources || [],
      dryRun
    }
  );
  sharedState.set(stateKey, promise);
  return promise;
}
