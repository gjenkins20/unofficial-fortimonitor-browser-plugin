// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-196: Bulk action - Apply Stock Fabric Templates.
//
// Given Fabric-onboarded devices the operator picked, the Configure step
// fetches each device's fabricSystemData + FortiMonitor's nounOptions
// vocabulary + the tenant's templates, runs them through fabric-profile.js
// and recommendation-engine.js, and produces a list of recommendations
// the operator opts in/out of. This action commits that list:
//
//   For each opted-in recommendation:
//     1. Ensure a Monitoring Policy exists that maps the (Make, Model)
//        predicate to the chosen template. Idempotent by name.
//     2. For each device in applies_to_server_ids, attach the chosen
//        template via PanoptaClient.attachTemplate (v2 fallback per
//        operator decision, FMN-196 / 2026-05-12). Idempotent via
//        listServerTemplateMappings pre-flight.
//
// Per-profile policy creation is memoized through ctx.sharedState so
// concurrent commits for the same profile do not race or duplicate.
//
// params shape (built by the Configure step, FMN-196 phase D):
//   {
//     dry_run: bool,     // when true, commit simulates without writing
//     recommendations: [
//       {
//         profile_key: 'FortiGate::FGVMA6::Fabric',
//         make: 'FortiGate', model: 'FGVMA6', connection_type: 'Fabric',
//         applies_to_server_ids: [42024061, ...],
//         chosen_template: { id: 101, name: 'FortiGate FGVMA6 Fabric' } | null,
//         policy_proposal: {
//           name: 'Apply Stock FortiGate template',
//           clauses: [{ datatype, match_type, match_key, match_value }, ...],
//           warnings: []
//         },
//         opted_in: true | false
//       },
//       ...
//     ]
//   }
//
// Dry-run semantics: when params.dry_run is true, commit() makes ZERO
// writes. It still reads (listServerTemplateMappings and the rulesets
// list, both idempotent) so the per-row result still shows would-create
// vs would-skip accurately. The Configure step surfaces a dry-run toggle;
// operators preview before committing for real.

export const id = 'apply-stock-fabric-templates';
export const label = 'Apply Stock Fabric Templates';
export const description = 'Profile Fabric devices, recommend matching templates, and create Monitoring Policies that auto-apply them.';
export const requires = 'apiKey+session';
export const writeMethod = 'POST /monitoring_policy/addRuleset + POST /server/{id}/template';

export function validate(params = {}) {
  const recs = Array.isArray(params?.recommendations) ? params.recommendations : null;
  if (!recs) return { ok: false, error: 'recommendations list is required.' };
  const optedIn = recs.filter((r) => r && r.opted_in === true);
  if (optedIn.length === 0) {
    return { ok: false, error: 'No recommendations opted in. Check at least one row in the Configure step.' };
  }
  for (const r of optedIn) {
    if (!r.profile_key || typeof r.profile_key !== 'string') {
      return { ok: false, error: 'Each opted-in recommendation must carry profile_key.' };
    }
    if (!Array.isArray(r.applies_to_server_ids) || r.applies_to_server_ids.length === 0) {
      return { ok: false, error: `Recommendation "${r.profile_key}" has no target server ids.` };
    }
    if (!r.chosen_template || typeof r.chosen_template.id !== 'number') {
      return { ok: false, error: `Recommendation "${r.profile_key}" has no chosen template.` };
    }
    if (!r.policy_proposal || typeof r.policy_proposal.name !== 'string') {
      return { ok: false, error: `Recommendation "${r.profile_key}" has no policy proposal.` };
    }
  }
  return {
    ok: true,
    value: {
      dry_run: params?.dry_run === true,
      recommendations: recs
    }
  };
}

export function describe(target, params) {
  const v = validate(params);
  if (!v.ok) return { prev: '-', next: '-', willChange: false, error: v.error };
  const rec = findRecForTarget(target, v.value.recommendations);
  if (!rec) {
    return {
      prev: '(unmatched)',
      next: '(skipped)',
      willChange: false,
      note: 'This device is not covered by an opted-in recommendation.'
    };
  }
  const dryRun = v.value.dry_run === true;
  const templates = Array.isArray(target?.template_names) ? target.template_names : null;
  const tName = rec.chosen_template.name;
  if (templates === null) {
    return {
      prev: '(templates unknown)',
      next: `${dryRun ? '(dry-run) ' : ''}+ ${tName} (via policy "${rec.policy_proposal.name}")`,
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
          ? `Template already attached; policy "${rec.policy_proposal.name}" will be ensured but template attach is a no-op.`
          : `Will ensure policy "${rec.policy_proposal.name}" and attach template "${tName}".`)
  };
}

export async function commit(target, params, ctx = {}) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  const { dry_run: dryRun, recommendations } = v.value;
  const { client, fortimonitorClient, sharedState } = ctx;
  if (!client) throw new Error('PanoptaClient required for template attach.');
  if (!fortimonitorClient) throw new Error('FortimonitorClient required for policy creation.');
  if (!(sharedState instanceof Map)) {
    throw new Error('sharedState Map required (per-run scoping for policy preflight memoization).');
  }

  const rec = findRecForTarget(target, recommendations);
  if (!rec) {
    return { status: 200, noop: true, reason: 'no-matching-recommendation', dry_run: dryRun };
  }

  // Phase 1: ensure the Monitoring Policy exists. Memoized per profile so
  // concurrent commits for the same profile await one creation.
  // In dry-run mode, this resolves to a simulated would-create/would-skip
  // result and makes ZERO writes (the rulesets list is still fetched for
  // the existence check; that's a read).
  const policy = await ensurePolicyForRecommendation(rec, fortimonitorClient, sharedState, dryRun);

  // Phase 2: attach the chosen template to this device. Reuses the same
  // pattern as apply-template.js (listServerTemplateMappings pre-flight).
  const templateUrl = rec.chosen_template.url
    || rec.chosen_template.resourceUrl
    || buildTemplateUrlFromId(rec.chosen_template.id, client);
  const mappings = await client.listServerTemplateMappings(target.id);
  const alreadyAttached = mappings.some((m) =>
    m.templateId === rec.chosen_template.id
    || (templateUrl && m.templateUrl === templateUrl)
  );

  if (alreadyAttached) {
    return {
      status: 200,
      noop: policy.created === false,
      reason: 'template-already-attached',
      dry_run: dryRun,
      policy: { id: policy.id, name: policy.name, created: policy.created, would_create: policy.would_create ?? false },
      template: { id: rec.chosen_template.id, name: rec.chosen_template.name }
    };
  }

  if (dryRun) {
    return {
      status: 200,
      noop: false,
      reason: 'dry-run',
      dry_run: true,
      policy: { id: policy.id, name: policy.name, created: false, would_create: policy.would_create ?? false },
      template: {
        id: rec.chosen_template.id,
        name: rec.chosen_template.name,
        would_attach: true
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
    policy: { id: policy.id, name: policy.name, created: policy.created },
    template: {
      id: rec.chosen_template.id,
      name: rec.chosen_template.name,
      mappingId: attachResult.resourceId ?? null
    }
  };
}

// ---------- helpers ----------

function findRecForTarget(target, recommendations) {
  if (!target || target.id == null) return null;
  for (const r of recommendations) {
    if (r.opted_in !== true) continue;
    if (!Array.isArray(r.applies_to_server_ids)) continue;
    if (r.applies_to_server_ids.includes(target.id)) return r;
  }
  return null;
}

function buildTemplateUrlFromId(templateId, client) {
  // PanoptaClient.attachTemplate accepts either templateUrl or
  // templateId-derived URL. The handler-side list-templates-with-groups
  // returns just { id, name, server_group_name }, so we synthesize the
  // URL here. Mirrors the convention in PanoptaClient.attachTemplate.
  if (templateId == null) return null;
  const base = (client?.baseUrl || '').replace(/\/$/, '');
  return `${base}/server_template/${encodeURIComponent(templateId)}`;
}

/**
 * Ensure a Monitoring Policy exists for the recommendation. Returns the
 * cached promise so concurrent commits for the same profile do not race.
 *
 * Result shape:
 *   live mode: { id, name, created: bool }
 *   dry-run:   { id: null|number, name, created: false, would_create: bool }
 */
function ensurePolicyForRecommendation(rec, fortimonitorClient, sharedState, dryRun = false) {
  const stateKey = dryRun ? `policy:dry:${rec.profile_key}` : `policy:${rec.profile_key}`;
  const cached = sharedState.get(stateKey);
  if (cached) {
    // Late-comers within the same run: await the original promise but
    // override `created` / `would_create` to false because THIS row did
    // not cause the create. The per-row UI reads this to distinguish
    // "this row created the policy" from "another row did."
    return cached.then((result) => ({
      ...result,
      created: false,
      would_create: false
    }));
  }
  const promise = dryRun
    ? simulatePolicyCreate(rec, fortimonitorClient, sharedState)
    : createOrFindPolicy(rec, fortimonitorClient, sharedState);
  sharedState.set(stateKey, promise);
  return promise;
}

async function createOrFindPolicy(rec, fortimonitorClient, sharedState) {
  const rulesets = await getCachedRulesets(fortimonitorClient, sharedState);
  const existing = rulesets.find((r) => r && r.name === rec.policy_proposal.name);
  if (existing) {
    return { id: existing.id, name: existing.name, created: false };
  }
  const created = await fortimonitorClient.createMonitoringPolicy({
    name: rec.policy_proposal.name,
    index: 0,
    description: ''
  });
  const config = {
    rules: [
      {
        enabled: true,
        name: `Apply ${rec.chosen_template.name} to ${rec.make} ${rec.model}`,
        conditions: [
          {
            clauses: (rec.policy_proposal.clauses || []).map((c) => ({
              datatype: c.datatype,
              match_type: c.match_type,
              match_key: c.match_key ?? null,
              match_value: c.match_value,
              error: false
            })),
            operator: 'and'
          }
        ],
        actions: [
          { action_type: 'apply_template', action_value: String(rec.chosen_template.id) }
        ]
      }
    ]
  };
  await fortimonitorClient.updateMonitoringPolicyConfig(created.id, config);
  return { id: created.id, name: created.name, created: true };
}

async function simulatePolicyCreate(rec, fortimonitorClient, sharedState) {
  // Dry-run path: read-only. We still call the rulesets list so the
  // per-row result accurately reflects would-create vs would-skip.
  const rulesets = await getCachedRulesets(fortimonitorClient, sharedState);
  const existing = rulesets.find((r) => r && r.name === rec.policy_proposal.name);
  if (existing) {
    return { id: existing.id, name: existing.name, created: false, would_create: false };
  }
  return { id: null, name: rec.policy_proposal.name, created: false, would_create: true };
}

function getCachedRulesets(fortimonitorClient, sharedState) {
  const key = 'rulesets:list';
  const cached = sharedState.get(key);
  if (cached) return cached;
  const promise = fortimonitorClient.getMonitoringPolicyPageData().then((data) =>
    Array.isArray(data?.rulesets) ? data.rulesets : []
  );
  sharedState.set(key, promise);
  return promise;
}
