// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-172: Bulk action - Schedule Maintenance Window.
//
// params: {
//   name: string,
//   startTime: string (ISO 8601),
//   endTime: string (ISO 8601),
//   description?: string,
//   pauseAllChecks?: boolean (default true)
// }
//
// One MW per RUN covering every opted-in target (NOT one MW per target).
// The sharedState memoization on the commit context lets the first
// per-target commit fire the create; the rest await its promise and
// report as "covered by batch fire". This matches operator intent:
// "schedule MW from 22:00-04:00 for these 25 devices" => one schedule
// in FortiMonitor's MW list, not 25.

const SHARED_KEY = 'mw:schedule';

export const id = 'schedule-maintenance-window';
export const label = 'Schedule Maintenance Window';
export const description = 'Schedule one maintenance window covering every selected instance. Halts alerting + (optionally) checks during the window. One row in FortiMonitor\'s Maintenance Schedules list per run.';
export const requires = 'apiKey';
export const writeMethod = 'POST /maintenance_schedule';

function isIsoDate(s) {
  if (typeof s !== 'string' || !s.trim()) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

export function validate(params = {}) {
  const name = String(params?.name ?? '').trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  if (!isIsoDate(params?.startTime)) return { ok: false, error: 'Start time is required and must be a valid date.' };
  if (!isIsoDate(params?.endTime)) return { ok: false, error: 'End time is required and must be a valid date.' };
  const start = new Date(params.startTime);
  const end = new Date(params.endTime);
  if (end.getTime() <= start.getTime()) {
    return { ok: false, error: 'End time must be after start time.' };
  }
  return {
    ok: true,
    value: {
      name,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      description: typeof params?.description === 'string' ? params.description.trim() : '',
      pauseAllChecks: params?.pauseAllChecks === false ? false : true
    }
  };
}

export function describe(target, params) {
  const v = validate(params);
  if (!v.ok) return { prev: '-', next: '-', willChange: false, error: v.error };
  const start = new Date(v.value.startTime).toLocaleString();
  const end = new Date(v.value.endTime).toLocaleString();
  return {
    prev: '(no MW)',
    next: `→ "${v.value.name}" ${start} – ${end}`,
    willChange: true,
    note: `This instance will be included in the shared "${v.value.name}" maintenance window covering ${start} – ${end}.`
  };
}

export async function commit(target, params, ctx = {}) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  const { client, sharedState } = ctx;
  if (!client) throw new Error('PanoptaClient required for schedule-maintenance-window.');
  if (!(sharedState instanceof Map)) {
    throw new Error('sharedState Map required (per-run scoping for the shared MW create).');
  }
  // The targetUrl is built from /v2/server/{id}; PanoptaClient handles
  // the base URL prefix. We pass relative URLs; FortiMonitor accepts
  // them.
  const targetUrl = `/v2/server/${encodeURIComponent(target.id)}/`;

  // First commit fires the create with the FULL set of opted-in targets
  // from the run. Subsequent commits await the cached promise and
  // report as "covered". sharedState.set is sync, so the second-arrival
  // commit always observes the promise the first put there.
  let promise = sharedState.get(SHARED_KEY);
  if (!promise) {
    const allTargetUrls = Array.isArray(ctx.allTargetUrls) && ctx.allTargetUrls.length > 0
      ? ctx.allTargetUrls
      : [targetUrl];
    promise = client.scheduleMaintenanceWindow({
      name: v.value.name,
      startTime: v.value.startTime,
      endTime: v.value.endTime,
      description: v.value.description,
      pauseAllChecks: v.value.pauseAllChecks,
      targetUrls: allTargetUrls
    });
    sharedState.set(SHARED_KEY, promise);
  }
  const result = await promise;
  return {
    status: result.status,
    noop: false,
    maintenanceWindow: {
      id: result.id,
      url: result.url,
      name: v.value.name,
      startTime: v.value.startTime,
      endTime: v.value.endTime,
      shared: true
    }
  };
}
