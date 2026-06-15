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
// SERVERS ONLY (operator directive 2026-06-15): even though the endpoint
// CAN delete templates, this action must not. commit() first verifies the
// id is a real server via the v2 API (GET /server/{id}) and SKIPS anything
// that isn't (a template id, or an already-gone instance, both 404 there) -
// so a template id can never reach the template-capable delete endpoint.
// This is why the action requires an API key in addition to the session.
//
// FortiMonitor deletion is NOT suspension: agent_resources and metric
// history are destroyed, not paused (FMN-34). There is no undo. The
// confirm phrase is the load-bearing guard - keep it.

export const id = 'delete-instance';
export const label = 'Delete Instances';
export const description = 'Permanently delete each selected instance from FortiMonitor. Servers only - template ids are skipped. Irreversible: agent_resources and metric history are destroyed, not suspended.';
export const requires = 'apiKey+session';
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
  const { client, fortimonitorClient } = ctx;
  if (!fortimonitorClient) throw new Error('FortimonitorClient required for delete-instance.');
  if (!client) throw new Error('PanoptaClient (v2 API key) required for delete-instance - it verifies the target is a server before deleting.');
  if (target?.id == null || String(target.id).trim() === '') {
    throw new Error('Target id is required for delete-instance.');
  }

  // Servers only: confirm the id resolves as a server before issuing the
  // template-capable /config/deleteServer. GET /v2/server/{id} returns 200
  // for a server, 404 for a template id OR an already-gone instance - in
  // both cases we must NOT delete, so skip. This guarantees a template id
  // can never reach the delete endpoint.
  try {
    await client.getJson(`/server/${encodeURIComponent(target.id)}`);
  } catch (err) {
    if (err?.status === 404) {
      return { status: 404, noop: true, skipped: true, reason: 'not-a-server', deleted: false, id: target.id };
    }
    throw err;
  }

  try {
    const res = await fortimonitorClient.deleteServerOrTemplate(target.id);
    return { status: res?.status ?? 200, noop: false, deleted: true, id: target.id };
  } catch (err) {
    // A 404 here means the server disappeared between the verify GET and the
    // delete (raced) - treat as an idempotent skip, the desired end-state
    // already holds.
    if (err?.status === 404) {
      return { status: 404, noop: true, skipped: true, reason: 'not-found', deleted: false, id: target.id };
    }
    throw err;
  }
}
