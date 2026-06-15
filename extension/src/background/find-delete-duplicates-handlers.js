// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-269: service-worker handlers for the Find & Delete Duplicates tool.
//
// Only the FIND half lives here: page the /v2/server list (raw, so we keep
// `fqdn` which the parsed wrapper drops) and run the real analyzeDuplicates.
// The DELETE half is NOT reimplemented - the tool reuses bulk-composer:commit
// with actionId 'delete-instance', so there is exactly one delete path + one
// confirm gate across the toolkit.

import { createProductionPanoptaClient } from '../lib/panopta-client.js';
import { analyzeDuplicates } from '../lib/observation-analyzers/duplicate.js';

const PAGE_LIMIT = 100;
const MAX_PAGES = 500; // hard backstop (~50k instances)

/**
 * @param {object} deps
 * @param {() => Promise<object>} [deps.getClient]  test seam; defaults to the
 *   production PanoptaClient factory.
 * @param {{ emit?: (name:string, payload:object) => void }} [deps.events]
 *   broadcast channel; the find loop emits per-page progress on it so the UI
 *   can show an elapsed timer + a progress bar (FMN-271).
 */
export function createFindDeleteDuplicatesHandlers({ getClient, events } = {}) {
  const factory = getClient ?? (() => createProductionPanoptaClient());
  const emit = (name, payload) => { try { events?.emit?.(name, payload); } catch { /* no listener */ } };

  return {
    // Returns analyzeDuplicates() result over the live /v2/server list.
    // Emits find-delete-duplicates:find-progress { scanned, total } per page
    // so the UI can render determinate progress (total from meta.total_count).
    'find-delete-duplicates:find': async () => {
      const client = await factory();
      const servers = [];
      let offset = 0;
      let total = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await client.getJson(`/server?limit=${PAGE_LIMIT}&offset=${offset}`);
        const list = Array.isArray(body?.server_list) ? body.server_list : [];
        if (total == null) {
          const t = body?.meta?.total_count;
          total = Number.isFinite(t) ? t : null;
        }
        for (const o of list) {
          servers.push({
            url: typeof o?.url === 'string' ? o.url : null,
            id: o?.id ?? null,
            name: o?.name ?? '',
            fqdn: o?.fqdn ?? '',
            created: o?.created ?? ''
          });
        }
        emit('find-delete-duplicates:find-progress', { scanned: servers.length, total });
        if (list.length < PAGE_LIMIT) break;
        offset += PAGE_LIMIT;
      }
      const result = analyzeDuplicates({ servers });
      // Attach the scanned count even on the available:false path so the UI
      // can say "scanned N, found 0" rather than a bare empty.
      return { ...result, scanned: servers.length };
    }
  };
}
