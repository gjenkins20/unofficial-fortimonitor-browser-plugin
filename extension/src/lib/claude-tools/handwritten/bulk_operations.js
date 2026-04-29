// FMN-111: hand-port of fortimonitor-mcp-server/src/tools/bulk_operations.py
//
// These tools issue multiple v2 API calls per invocation, with bounded
// concurrency, and aggregate the results. They are not codegen-derivable
// because the OpenAPI describes endpoints, not workflows.
//
// Caps match the python source: 50 outages per bulk_acknowledge,
// 100 servers per bulk tag op. search_servers_advanced and
// get_servers_with_active_outages page until the API runs out.

import { mapWithConcurrency } from './concurrency.js';

const MAX_OUTAGES_PER_BULK = 50;
const MAX_SERVERS_PER_BULK = 100;
const DEFAULT_CONCURRENCY = 5;

export const BULK_OPS_TOOLS = [
  {
    name: 'bulk_acknowledge_outages',
    tier: 'readwrite',
    description: 'Acknowledge multiple outages at once. WRITE - only call when the user has provided a specific list of outage ids and asked for bulk acknowledgement. Caps at 50 outages per call.',
    input_schema: {
      type: 'object',
      properties: {
        outage_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'List of outage ids to acknowledge.'
        },
        message: {
          type: 'string',
          description: 'Optional acknowledgement note applied to every outage.'
        },
        concurrency: {
          type: 'integer',
          description: 'Max simultaneous API calls (default 5, max 10).',
          default: DEFAULT_CONCURRENCY
        }
      },
      required: ['outage_ids']
    }
  },
  {
    name: 'bulk_add_tags',
    tier: 'readwrite',
    description: 'Add one or more tags to many servers via read-modify-write. WRITE - only call when the user has provided server ids and tag names. Caps at 100 servers per call.',
    input_schema: {
      type: 'object',
      properties: {
        server_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'List of server ids to mutate.'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tag names to add. Existing tags are preserved.'
        },
        concurrency: {
          type: 'integer',
          description: 'Max simultaneous API calls (default 5, max 10).',
          default: DEFAULT_CONCURRENCY
        }
      },
      required: ['server_ids', 'tags']
    }
  },
  {
    name: 'bulk_remove_tags',
    tier: 'readwrite',
    description: 'Remove one or more tags from many servers via read-modify-write. WRITE - only call with explicit server-id and tag-name lists from the user. Caps at 100 servers per call.',
    input_schema: {
      type: 'object',
      properties: {
        server_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'List of server ids to mutate.'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tag names to remove. Tags not present on a server are no-ops.'
        },
        concurrency: {
          type: 'integer',
          description: 'Max simultaneous API calls (default 5, max 10).',
          default: DEFAULT_CONCURRENCY
        }
      },
      required: ['server_ids', 'tags']
    }
  },
  {
    name: 'search_servers_advanced',
    tier: 'readonly',
    description: 'Multi-criteria server search. Pages /server and filters client-side by any combination of name substring, status, tag membership, and active-outage flag. Returns trimmed server records.',
    input_schema: {
      type: 'object',
      properties: {
        name_contains: { type: 'string', description: 'Case-insensitive substring match against server name.' },
        status: {
          type: 'string',
          description: 'Exact server status (e.g. "active", "suspended").'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Server must carry every tag in this list.'
        },
        has_active_outages: {
          type: 'boolean',
          description: 'If true, only include servers with at least one active outage.'
        },
        max_results: {
          type: 'integer',
          description: 'Stop paginating once this many matches accumulate (default 200).',
          default: 200
        }
      }
    }
  },
  {
    name: 'get_servers_with_active_outages',
    tier: 'readonly',
    description: 'Convenience wrapper: list servers that currently have at least one active outage. Joins /outage/active with server records, returns one trimmed entry per server.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max servers returned (default 100).', default: 100 }
      }
    }
  }
];

export function buildBulkOpsHandlers(client) {
  if (!client) throw new TypeError('buildBulkOpsHandlers: client is required');

  return {
    bulk_acknowledge_outages: async ({ outage_ids = [], message = null, concurrency = DEFAULT_CONCURRENCY }) => {
      const ids = Array.isArray(outage_ids) ? outage_ids.slice(0, MAX_OUTAGES_PER_BULK) : [];
      if (ids.length === 0) return { acknowledged: 0, results: [] };
      const cap = Math.max(1, Math.min(10, concurrency || DEFAULT_CONCURRENCY));
      const out = await mapWithConcurrency(ids, cap, async (id) => {
        const r = await client.acknowledgeOutage(id, { message });
        return { outage_id: id, status: r.status };
      });
      return {
        acknowledged: out.filter((r) => r.ok).length,
        failed: out.filter((r) => !r.ok).length,
        capped: Array.isArray(outage_ids) && outage_ids.length > MAX_OUTAGES_PER_BULK,
        results: out.map((r, i) => r.ok ? r.value : { outage_id: ids[i], error: r.error })
      };
    },

    bulk_add_tags: async ({ server_ids = [], tags = [], concurrency = DEFAULT_CONCURRENCY }) => {
      const ids = Array.isArray(server_ids) ? server_ids.slice(0, MAX_SERVERS_PER_BULK) : [];
      const tagList = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
      if (ids.length === 0 || tagList.length === 0) return { updated: 0, results: [] };
      const cap = Math.max(1, Math.min(10, concurrency || DEFAULT_CONCURRENCY));
      const out = await mapWithConcurrency(ids, cap, async (id) => {
        const server = await client.getServer(id);
        const current = Array.isArray(server?.tags) ? server.tags.slice() : [];
        const merged = Array.from(new Set([...current, ...tagList]));
        await client._request('PUT', `/server/${encodeURIComponent(id)}`, { body: { ...server, tags: merged } });
        return { server_id: id, added: merged.filter((t) => !current.includes(t)) };
      });
      return {
        updated: out.filter((r) => r.ok).length,
        failed: out.filter((r) => !r.ok).length,
        capped: Array.isArray(server_ids) && server_ids.length > MAX_SERVERS_PER_BULK,
        results: out.map((r, i) => r.ok ? r.value : { server_id: ids[i], error: r.error })
      };
    },

    bulk_remove_tags: async ({ server_ids = [], tags = [], concurrency = DEFAULT_CONCURRENCY }) => {
      const ids = Array.isArray(server_ids) ? server_ids.slice(0, MAX_SERVERS_PER_BULK) : [];
      const tagList = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
      if (ids.length === 0 || tagList.length === 0) return { updated: 0, results: [] };
      const cap = Math.max(1, Math.min(10, concurrency || DEFAULT_CONCURRENCY));
      const remove = new Set(tagList);
      const out = await mapWithConcurrency(ids, cap, async (id) => {
        const server = await client.getServer(id);
        const current = Array.isArray(server?.tags) ? server.tags.slice() : [];
        const next = current.filter((t) => !remove.has(t));
        await client._request('PUT', `/server/${encodeURIComponent(id)}`, { body: { ...server, tags: next } });
        return { server_id: id, removed: current.filter((t) => remove.has(t)) };
      });
      return {
        updated: out.filter((r) => r.ok).length,
        failed: out.filter((r) => !r.ok).length,
        capped: Array.isArray(server_ids) && server_ids.length > MAX_SERVERS_PER_BULK,
        results: out.map((r, i) => r.ok ? r.value : { server_id: ids[i], error: r.error })
      };
    },

    search_servers_advanced: async (input = {}) => {
      const {
        name_contains = null,
        status = null,
        tags = null,
        has_active_outages = null,
        max_results = 200
      } = input;
      const wantTags = Array.isArray(tags) && tags.length > 0 ? new Set(tags) : null;
      const matches = [];
      const PAGE = 100;
      let offset = 0;
      let activeOutageServers = null;
      if (has_active_outages === true) {
        const aoBody = await client.listOutages({ limit: 200, offset: 0, active: true });
        activeOutageServers = new Set();
        for (const o of (aoBody?.outage_list ?? [])) {
          const sid = o.server?.id ?? extractServerIdFromOutage(o);
          if (sid != null) activeOutageServers.add(Number(sid));
        }
      }
      while (matches.length < max_results) {
        const body = await client.listServers({ limit: PAGE, offset });
        const list = body?.server_list ?? [];
        if (list.length === 0) break;
        for (const s of list) {
          if (matches.length >= max_results) break;
          if (name_contains && typeof s.name === 'string' && !s.name.toLowerCase().includes(name_contains.toLowerCase())) continue;
          if (status && s.status !== status) continue;
          if (wantTags) {
            const sTags = Array.isArray(s.tags) ? new Set(s.tags) : new Set();
            let ok = true;
            for (const t of wantTags) if (!sTags.has(t)) { ok = false; break; }
            if (!ok) continue;
          }
          if (activeOutageServers && !activeOutageServers.has(Number(s.id))) continue;
          matches.push({ id: s.id, name: s.name, status: s.status ?? null, tags: s.tags ?? [] });
        }
        const total = body?.meta?.total_count ?? offset + list.length;
        offset += list.length;
        if (offset >= total) break;
      }
      return { total: matches.length, capped: matches.length === max_results, servers: matches };
    },

    get_servers_with_active_outages: async ({ limit = 100 } = {}) => {
      const aoBody = await client.listOutages({ limit: 200, offset: 0, active: true });
      const seen = new Map();
      for (const o of (aoBody?.outage_list ?? [])) {
        const sid = o.server?.id ?? extractServerIdFromOutage(o);
        if (sid == null || seen.has(sid)) continue;
        seen.set(sid, {
          id: sid,
          name: o.server?.name ?? null,
          outage_id: o.id,
          severity: o.severity ?? null,
          start: o.start ?? null
        });
        if (seen.size >= limit) break;
      }
      return { count: seen.size, servers: Array.from(seen.values()) };
    }
  };
}

function extractServerIdFromOutage(outage) {
  const url = outage?.server_url ?? outage?.server?.url ?? null;
  if (typeof url !== 'string') return null;
  const m = url.match(/\/server\/(\d+)\/?$/);
  return m ? Number(m[1]) : null;
}
