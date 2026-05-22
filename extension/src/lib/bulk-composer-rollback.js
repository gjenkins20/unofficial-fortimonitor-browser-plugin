// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-237: undo what a Bulk Action Composer run created.
//
// Walks the journal record's `order` list in reverse, calling the
// inverse operation for each entry. Treats 404 / not-found as a
// successful no-op (operator may have already manually cleaned up).
//
// Reverse-walk order is the journal's natural creation order reversed,
// which lines up with the dependency teardown:
//   MPWs first (they reference templates).
//   Template attachments next (they hold the metric history we want gone).
//   Templates next (now safe to delete; nothing references them).
//   Server groups last (templates that were inside them are gone).
//   Attributes / tags are independent and ordered by their row index.

const STEP_KINDS = Object.freeze({
  TEMPLATE: 'template',
  MPW: 'mpw',
  SERVER_GROUP: 'server_group',
  ATTACH: 'attach',
  ATTR: 'attr',
  TAG: 'tag'
});

const STATUS = Object.freeze({
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  ALREADY_GONE: 'already-gone'
});

function parseOrderToken(token) {
  if (typeof token !== 'string') return null;
  const [kind, ...rest] = token.split(':');
  return { kind, parts: rest };
}

function isNotFoundError(err) {
  if (!err) return false;
  // PanoptaError and FortimonitorError both carry status; 404 ~= already gone.
  const status = err.status ?? err.statusCode ?? null;
  if (status === 404) return true;
  // Some endpoints respond 405 / 410 / 400 for "no such resource". Match
  // common "not found" text fragments defensively.
  const msg = String(err.message || '').toLowerCase();
  if (msg.includes('not found')) return true;
  if (msg.includes('no such')) return true;
  if (msg.includes('does not exist')) return true;
  return false;
}

/**
 * Run rollback for a single journal entry.
 *
 *   record: the journal entry as stored by appendRun()
 *   clients: { panopta, fortimonitor }  - either may be null if the
 *             corresponding client isn't available; missing-client steps
 *             surface as 'failed' with a clear error.
 *
 * Returns { steps: [{ kind, identity, status, error? }], startedAt, finishedAt }.
 */
export async function rollbackRun(record, clients = {}) {
  if (!record || typeof record !== 'object') {
    throw new TypeError('rollbackRun: record required');
  }
  const { panopta, fortimonitor } = clients;
  const startedAt = new Date().toISOString();
  const steps = [];
  const order = Array.isArray(record.order) ? record.order : [];

  // Walk reverse-creation. Each token maps to an entry in record.created
  // or record.attached; we look up the full row for params.
  for (let i = order.length - 1; i >= 0; i--) {
    const parsed = parseOrderToken(order[i]);
    if (!parsed) continue;
    const step = await executeStep(parsed, record, { panopta, fortimonitor });
    if (step) steps.push(step);
  }

  // After the order-driven walk, capture anything in `created` that
  // wasn't reflected in `order` (defensive: aggregateRunEffects skips
  // duplicates so an attr/tag could still appear here if a future
  // action populated created without order). Run them last.
  const seen = new Set(order);
  for (const attr of (record.created?.attributes || [])) {
    const key = `attr:${attr.serverId}:${attr.attributeId}`;
    if (seen.has(key)) continue;
    const step = await executeAttrStep(attr, panopta);
    if (step) steps.push(step);
  }
  for (const tag of (record.created?.tags || [])) {
    const key = `tag:${tag.serverId}:${tag.tag}`;
    if (seen.has(key)) continue;
    const step = await executeTagStep(tag, panopta);
    if (step) steps.push(step);
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    steps
  };
}

async function executeStep(parsed, record, { panopta, fortimonitor }) {
  const { kind, parts } = parsed;
  switch (kind) {
    case STEP_KINDS.MPW: {
      const id = Number(parts[0]);
      const entry = (record.created?.mpws || []).find((m) => Number(m.id) === id);
      return runStep(kind, `mpw:${id}`, entry?.name ?? `MPW #${id}`, async () => {
        if (!fortimonitor) throw new Error('FortimonitorClient unavailable; cannot delete MPW.');
        await fortimonitor.deleteMonitoringPolicy(id);
      });
    }
    case STEP_KINDS.ATTACH: {
      const serverId = Number(parts[0]);
      const templateId = Number(parts[1]);
      const entry = (record.attached?.templateAttachments || []).find(
        (a) => Number(a.serverId) === serverId && Number(a.templateId) === templateId
      );
      const label = entry?.templateName ? `attach ${entry.templateName} -> server ${serverId}` : `attach t${templateId}/s${serverId}`;
      return runStep(kind, `attach:${serverId}:${templateId}`, label, async () => {
        if (!panopta) throw new Error('PanoptaClient unavailable; cannot detach template.');
        await panopta.detachTemplate(serverId, templateId, { strategy: 'delete' });
      });
    }
    case STEP_KINDS.TEMPLATE: {
      const id = Number(parts[0]);
      const entry = (record.created?.templates || []).find((t) => Number(t.id) === id);
      return runStep(kind, `template:${id}`, entry?.name ?? `Template #${id}`, async () => {
        if (!fortimonitor) throw new Error('FortimonitorClient unavailable; cannot delete template.');
        await fortimonitor.deleteServerOrTemplate(id);
      });
    }
    case STEP_KINDS.SERVER_GROUP: {
      const id = Number(parts[0]);
      const entry = (record.created?.server_groups || []).find((g) => Number(g.id) === id);
      return runStep(kind, `server_group:${id}`, entry?.name ?? `Server group #${id}`, async () => {
        if (!panopta) throw new Error('PanoptaClient unavailable; cannot delete server_group.');
        await panopta.deleteServerGroup(id);
      });
    }
    case STEP_KINDS.ATTR: {
      const serverId = Number(parts[0]);
      const attributeId = Number(parts[1]);
      const entry = (record.created?.attributes || []).find(
        (a) => Number(a.serverId) === serverId && Number(a.attributeId) === attributeId
      );
      return executeAttrStep(entry ?? { serverId, attributeId }, panopta);
    }
    case STEP_KINDS.TAG: {
      const serverId = Number(parts[0]);
      const tag = parts.slice(1).join(':');
      const entry = (record.created?.tags || []).find(
        (t) => Number(t.serverId) === serverId && t.tag === tag
      );
      return executeTagStep(entry ?? { serverId, tag }, panopta);
    }
    default:
      return null;
  }
}

async function executeAttrStep(attr, panopta) {
  if (!attr || attr.serverId == null || attr.attributeId == null) return null;
  const label = attr.typeUrl ? `attribute ${attr.attributeId} on server ${attr.serverId}` : `attribute ${attr.attributeId}`;
  return runStep(STEP_KINDS.ATTR, `attr:${attr.serverId}:${attr.attributeId}`, label, async () => {
    if (!panopta) throw new Error('PanoptaClient unavailable; cannot delete attribute.');
    await panopta.deleteServerAttribute({ serverId: attr.serverId, attributeId: attr.attributeId });
  });
}

async function executeTagStep(entry, panopta) {
  if (!entry || entry.serverId == null || !entry.tag) return null;
  return runStep(STEP_KINDS.TAG, `tag:${entry.serverId}:${entry.tag}`, `tag "${entry.tag}" on server ${entry.serverId}`, async () => {
    if (!panopta) throw new Error('PanoptaClient unavailable; cannot remove tag.');
    await panopta.removeServerTag(entry.serverId, [entry.tag]);
  });
}

async function runStep(kind, identity, label, op) {
  try {
    await op();
    return { kind, identity, label, status: STATUS.SUCCEEDED };
  } catch (err) {
    if (isNotFoundError(err)) {
      return { kind, identity, label, status: STATUS.ALREADY_GONE };
    }
    return {
      kind, identity, label,
      status: STATUS.FAILED,
      error: err?.message ?? String(err)
    };
  }
}

export const _internals = { parseOrderToken, isNotFoundError };
export { STEP_KINDS, STATUS };
