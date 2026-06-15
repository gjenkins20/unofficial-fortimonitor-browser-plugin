// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Bulk action - Delete Instances.
//
// params: { confirm: string }  (must equal CONFIRM_PHRASE - the type-to-
//   confirm gate rendered on the Preview step; enforced again here AND in
//   the service worker via validate() so a delete can never run without it)
// target: { id, name }
//
// DESTRUCTIVE + IRREVERSIBLE. commit() fires the session-auth endpoint
// POST /config/deleteServer (FortimonitorClient.deleteServerOrTemplate).
// Per FMN-238 that endpoint deletes both servers AND server_templates -
// they share the s-{id} numeric namespace and the form field is
// "server_id" for both. There is no v2 DELETE for /server_template (live
// 405), so this session surface is the only programmatic delete path.
//
// FortiMonitor deletion is NOT suspension: agent_resources and metric
// history are destroyed, not paused (FMN-34). There is no undo. The
// confirm phrase is the load-bearing guard - keep it.

export const id = 'delete-instance';
export const label = 'Delete Instances';
export const description = 'Permanently delete each selected instance (server or template) from FortiMonitor. Irreversible: agent_resources and metric history are destroyed, not suspended.';
export const requires = 'session';
export const writeMethod = 'POST /config/deleteServer';

// The exact string the operator must type on the Preview step to arm the
// run. Case-sensitive on purpose. Exported so the UI gate and tests share
// one source of truth.
export const CONFIRM_PHRASE = 'DELETE';

export function validate(params = {}) {
  const confirm = String(params?.confirm ?? '');
  if (confirm !== CONFIRM_PHRASE) {
    return { ok: false, error: `Type ${CONFIRM_PHRASE} to confirm permanent deletion.` };
  }
  return { ok: true, value: { confirm } };
}

// describe() is intentionally independent of the confirm gate: the Preview
// table should always show "exists -> DELETED" so the operator sees the
// full blast radius BEFORE typing the phrase. The gate lives in the UI +
// validate(), not here. There is no offline state that makes a delete a
// no-op, so every existing target "will change"; a genuinely-gone instance
// surfaces as a 404 skip at commit time.
export function describe(target /*, params */) {
  return {
    prev: 'exists',
    next: 'DELETED',
    willChange: true,
    note: 'Permanent deletion. Agent resources and metric history are destroyed, not suspended. No undo.'
  };
}

export async function commit(target, params, ctx = {}) {
  const v = validate(params);
  if (!v.ok) throw new Error(v.error);
  const { fortimonitorClient } = ctx;
  if (!fortimonitorClient) throw new Error('FortimonitorClient required for delete-instance.');
  if (target?.id == null || String(target.id).trim() === '') {
    throw new Error('Target id is required for delete-instance.');
  }
  try {
    const res = await fortimonitorClient.deleteServerOrTemplate(target.id);
    return { status: res?.status ?? 200, noop: false, deleted: true, id: target.id };
  } catch (err) {
    // A 404 means the instance is already gone on this tenant - treat as a
    // skip (idempotent: the desired end-state already holds) rather than a
    // hard failure, matching the other actions' not-found handling.
    if (err?.status === 404) {
      return { status: 404, noop: true, skipped: true, reason: 'not-found', deleted: false, id: target.id };
    }
    throw err;
  }
}
