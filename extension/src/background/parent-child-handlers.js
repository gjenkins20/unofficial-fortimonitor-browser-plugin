// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-280: background handlers for the top-level Parent/Child Associations tool.
//
//   parent-child:resolve - resolve child/parent tokens (IDs or names) to
//                          servers, fetch each child's current parent, and
//                          compute per-row Preview status. One round-trip.
//   parent-child:apply   - run the writes per child: Set via v2
//                          setServerParentInstance, Remove via session-auth
//                          removeServerParentInstance (the verified FMN-277/279
//                          methods). Emits parent-child:row-done progress.
//
// Reuses resolveTargets (IDs pass through, names resolve by exact match) and the
// pure status logic in lib/parent-child-mapping.js.

import { mapConcurrent } from '../lib/concurrency.js';
import { createProductionPanoptaClient, PANOPTA_BASE } from '../lib/panopta-client.js';
import { createProductionClient as createFortimonitorClient } from '../lib/fortimonitor-client.js';
import { resolveTargets } from './attribute-handlers.js';
import { setRowStatus, removeRowStatus } from '../lib/parent-child-mapping.js';

const DEFAULT_CONCURRENCY = 3;
const MAX_ROWS = 500;

const serverUrl = (id) => `${PANOPTA_BASE}/server/${id}`;
const idFromUrl = (url) => { const m = String(url || '').match(/\/server\/(\d+)\/?$/); return m ? Number(m[1]) : null; };

export function createParentChildHandlers({ events = {}, getClient, getFortimonitorClient } = {}) {
  const emit = events.emit ?? (() => {});
  const factory = getClient ?? (() => createProductionPanoptaClient());
  const fmFactory = getFortimonitorClient ?? (() => createFortimonitorClient());

  return {
    'parent-child:resolve': async (payload = {}) => {
      const mode = payload?.mode === 'remove' ? 'remove' : 'set';
      const rows = Array.isArray(payload?.rows) ? payload.rows.slice(0, MAX_ROWS) : [];
      if (rows.length === 0) return { mode, rows: [] };
      const client = await factory();

      // Resolve children (and parents, for set) - order-preserving, deduped.
      const childRes = await resolveTargets({ entries: rows.map((r) => String(r.childToken ?? '').trim()), client });
      const parentRes = mode === 'set'
        ? await resolveTargets({ entries: rows.map((r) => String(r.parentToken ?? '').trim()), client })
        : [];

      // Current parent url per unique resolved child.
      const currentByChildId = new Map();
      const uniqueChildIds = [...new Set(childRes.filter((r) => r.status === 'resolved').map((r) => r.serverId))];
      await mapConcurrent(uniqueChildIds, async (cid) => {
        try { currentByChildId.set(cid, (await client.getServer(cid))?.parent_server ?? null); }
        catch { currentByChildId.set(cid, null); }
      }, { concurrency: DEFAULT_CONCURRENCY });

      // Resolve current-parent NAMES on demand (cached by url).
      const parentNameCache = new Map();
      const resolveCurrentParent = async (url) => {
        if (!url) return null;
        if (parentNameCache.has(url)) return parentNameCache.get(url);
        const id = idFromUrl(url);
        let name = null;
        try { name = (await client.getServer(id))?.name ?? null; } catch { /* keep id-only */ }
        const o = { id, name, url };
        parentNameCache.set(url, o);
        return o;
      };

      const out = [];
      for (let i = 0; i < rows.length; i++) {
        const cr = childRes[i];
        const child = cr?.status === 'resolved' ? { id: cr.serverId, name: cr.displayName, url: serverUrl(cr.serverId) } : null;
        const childError = cr?.status !== 'resolved' ? (cr?.error ?? 'Unresolved') : null;
        const currentUrl = child ? (currentByChildId.get(child.id) ?? null) : null;
        const currentParent = await resolveCurrentParent(currentUrl);
        if (mode === 'remove') {
          out.push({ childToken: rows[i].childToken, child, childError, currentParent, status: removeRowStatus({ child, currentParentUrl: currentUrl }) });
        } else {
          const pr = parentRes[i];
          const parent = pr?.status === 'resolved' ? { id: pr.serverId, name: pr.displayName, url: serverUrl(pr.serverId) } : null;
          const parentError = pr?.status !== 'resolved' ? (pr?.error ?? 'Unresolved') : null;
          out.push({ childToken: rows[i].childToken, child, childError, parentToken: rows[i].parentToken, parent, parentError, currentParent, status: setRowStatus({ child, parent, currentParentUrl: currentUrl }) });
        }
      }
      return { mode, rows: out };
    },

    'parent-child:apply': async (payload = {}) => {
      const mode = payload?.mode === 'remove' ? 'remove' : 'set';
      const rows = Array.isArray(payload?.rows) ? payload.rows.slice(0, MAX_ROWS) : [];
      if (rows.length === 0) return { results: [] };
      const client = await factory();
      const fm = mode === 'remove' ? await fmFactory() : null;
      const concurrency = Math.max(1, Math.min(10, payload?.concurrency || DEFAULT_CONCURRENCY));

      const settled = await mapConcurrent(rows, async (row, i) => {
        emit('parent-child:row-start', { index: i, childId: row.childId, childName: row.childName });
        try {
          const result = mode === 'remove'
            ? await fm.removeServerParentInstance(row.childId)
            : await client.setServerParentInstance(row.childId, row.parentUrl);
          const done = { index: i, childId: row.childId, childName: row.childName, status: 'succeeded', noop: !!result?.noop };
          emit('parent-child:row-done', done);
          return done;
        } catch (err) {
          const done = { index: i, childId: row.childId, childName: row.childName, status: 'failed', error: err?.message ?? String(err) };
          emit('parent-child:row-done', done);
          return done;
        }
      }, { concurrency });

      return { results: settled.map((s) => s.value) };
    }
  };
}
