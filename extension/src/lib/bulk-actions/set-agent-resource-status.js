// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-171: Bulk action - Set Agent Resource Status.
//
// params: { filter: string, status: 'active' | 'suspended' }
// target: { id, name, agentResources?: { matched: [...], total } | null }
//
// Per FMN-34 (memory + CLAUDE.md): agent_resource.status=suspended
// halts metric collection but does NOT change port scope. The two
// systems are independent. Operators wanting port-scope changes use
// FMN-162's Add/Remove Port Scope.
//
// The filter is a case-insensitive substring matched against each
// resource's name | plugin_textkey | resource_textkey. An empty
// filter would target every agent_resource on every target; v1
// rejects that to prevent foot-guns. Operator who genuinely wants
// to bulk-suspend every resource on a fleet can use a wildcard like
// "*" (which we coerce to empty internally but still warn against).

export const id = 'set-agent-resource-status';
export const label = 'Set Agent Resource Status';
export const description = 'Suspend or resume agent_resources on each selected instance, filtered by a case-insensitive substring on name / plugin_textkey / resource_textkey. Halts metric collection without deleting the resource.';
export const requires = 'apiKey';
export const writeMethod = 'PUT /server/{id}/agent_resource/{id}';

export function validate(params = {}) {
  const filter = String(params?.filter ?? '').trim();
  if (!filter) {
    return { ok: false, error: 'A filter string is required (matched against agent_resource name / plugin_textkey / resource_textkey).' };
  }
  const status = String(params?.status ?? '').trim();
  if (status !== 'active' && status !== 'suspended') {
    return { ok: false, error: "Status must be 'active' (resume) or 'suspended'." };
  }
  return { ok: true, value: { filter, status } };
}

export function describe(target, params) {
  const v = validate(params);
  if (!v.ok) return { prev: '-', next: '-', willChange: false, error: v.error };
  const data = target?.agentResources;
  if (data === undefined) {
    return {
      prev: '(resources unknown)',
      next: `→ ${v.value.status}`,
      willChange: true,
      note: 'Agent resources not yet fetched; commit will pre-flight.'
    };
  }
  if (data === null) {
    return {
      prev: '(not found)',
      next: '(not found)',
      willChange: false,
      skip: true,
      note: 'Instance not found or fetch failed; will skip.'
    };
  }
  const matched = Array.isArray(data.matched) ? data.matched : [];
  if (matched.length === 0) {
    return {
      prev: '(no matches)',
      next: '(no matches)',
      willChange: false,
      skip: true,
      note: `No agent_resource matched filter "${v.value.filter}".`
    };
  }
  const willChangeCount = matched.filter((r) => r.status !== v.value.status).length;
  if (willChangeCount === 0) {
    return {
      prev: `${matched.length} matched, all ${v.value.status}`,
      next: `${matched.length} matched, all ${v.value.status}`,
      willChange: false,
      skip: true,
      note: `All ${matched.length} matched resources are already "${v.value.status}".`
    };
  }
  return {
    prev: `${matched.length} matched`,
    next: `${willChangeCount} → ${v.value.status}`,
    willChange: true,
    note: `Will flip ${willChangeCount} of ${matched.length} matched agent_resource${matched.length === 1 ? '' : 's'} to "${v.value.status}".`
  };
}

export async function commit(target, params, ctx = {}) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  const { client } = ctx;
  if (!client) throw new Error('PanoptaClient required for set-agent-resource-status.');
  // We always re-fetch the matched-set at commit time (don't trust
  // the Configure-time enrichment) so that concurrent edits between
  // Configure and Apply can't surprise us with a stale match list.
  let body;
  try {
    body = await client.listAgentResourcesForServer(target.id, { limit: 200 });
  } catch (err) {
    if (err?.status === 404) {
      throw new Error(`Instance #${target.id} not found on this tenant.`);
    }
    throw err;
  }
  const list = Array.isArray(body?.agent_resource_list) ? body.agent_resource_list : [];
  const lcFilter = v.value.filter.toLowerCase();
  const matchedAll = list.filter((r) => {
    const hay = `${r?.name ?? r?.name_override ?? ''}|${r?.plugin_textkey ?? ''}|${r?.resource_textkey ?? ''}`.toLowerCase();
    return hay.includes(lcFilter);
  });
  if (matchedAll.length === 0) {
    return { status: 200, noop: true, skipped: true, reason: 'no-matches', matched: 0 };
  }
  const toFlip = matchedAll.filter((r) => (r?.status ?? null) !== v.value.status);
  if (toFlip.length === 0) {
    return { status: 200, noop: true, skipped: true, reason: 'already-in-status', matched: matchedAll.length };
  }
  let flipped = 0;
  const failures = [];
  for (const r of toFlip) {
    const url = typeof r?.url === 'string' ? r.url : '';
    const m = url.match(/\/agent_resource\/(\d+)\/?$/);
    const arId = m ? Number(m[1]) : null;
    if (arId == null) continue;
    try {
      const res = await client.setAgentResourceStatus(target.id, arId, v.value.status);
      if (!res.noop) flipped++;
    } catch (err) {
      failures.push({ id: arId, error: err?.message ?? String(err) });
    }
  }
  return {
    status: 200,
    noop: flipped === 0,
    matched: matchedAll.length,
    flipped,
    failures: failures.length > 0 ? failures : undefined
  };
}
