// FMN-112: hand-port of fortimonitor-mcp-server/src/tools/composite.py
//
// These tools issue 3-6 GETs and aggregate. The codegen pipeline cannot
// emit them because the OpenAPI describes endpoints, not analyses.
// All read-only.

import { mapWithConcurrency } from './concurrency.js';

export const COMPOSITE_TOOLS = [
  {
    name: 'investigate_server',
    tier: 'readonly',
    description: 'One-shot snapshot of a server: details, recent outages, agent resources, attached templates, and applied attributes. Use this when the user asks "what is going on with server X" - returns enough context to answer most follow-ups without further calls.',
    input_schema: {
      type: 'object',
      properties: {
        server_id: { type: 'integer', description: 'Numeric server id.' },
        outage_limit: { type: 'integer', description: 'Recent outages to include (default 10).', default: 10 },
        agent_resource_limit: { type: 'integer', description: 'Agent resources to include (default 25).', default: 25 }
      },
      required: ['server_id']
    }
  },
  {
    name: 'compare_servers',
    tier: 'readonly',
    description: 'Side-by-side details for N server ids. Returns one trimmed record per server with status, agent_resource_count, attached_template_count. Use when the user asks "compare X and Y".',
    input_schema: {
      type: 'object',
      properties: {
        server_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'List of server ids to compare. Caps at 10.'
        }
      },
      required: ['server_ids']
    }
  },
  {
    name: 'audit_monitoring_coverage',
    tier: 'readonly',
    description: 'Find servers without monitoring templates attached. Pages /server up to a cap and checks each server\'s template mapping list. Slower than other tools - use for small environments or scoped by name_contains.',
    input_schema: {
      type: 'object',
      properties: {
        name_contains: { type: 'string', description: 'Optional substring filter to scope the audit before checking templates.' },
        max_servers: { type: 'integer', description: 'Cap on servers checked (default 50, max 200).', default: 50 }
      }
    }
  },
  {
    name: 'generate_incident_timeline',
    tier: 'readonly',
    description: 'Chronological merge of an outage and adjacent signals: outage details, recent outages on the same server (before/after), and the server snapshot. Use to reconstruct what happened around an incident.',
    input_schema: {
      type: 'object',
      properties: {
        outage_id: { type: 'integer', description: 'The focal outage id.' },
        window_minutes: { type: 'integer', description: 'How many minutes before/after to include adjacent outages (default 60).', default: 60 }
      },
      required: ['outage_id']
    }
  },
  {
    name: 'find_flapping_servers',
    tier: 'readonly',
    description: 'Heuristic over recent outages: servers with N or more outages in a rolling window. Returns a ranked list. Useful for "which servers keep flapping today".',
    input_schema: {
      type: 'object',
      properties: {
        min_outages: { type: 'integer', description: 'Threshold for inclusion (default 3).', default: 3 },
        lookback_outages: { type: 'integer', description: 'How many recent outages to scan (default 200, max 500).', default: 200 }
      }
    }
  }
];

export function buildCompositeHandlers(client) {
  if (!client) throw new TypeError('buildCompositeHandlers: client is required');

  return {
    investigate_server: async ({ server_id, outage_limit = 10, agent_resource_limit = 25 }) => {
      const [server, outagesBody, resourcesBody, templatesBody] = await Promise.all([
        client.getServer(server_id),
        client.listOutages({ limit: outage_limit, serverId: server_id, active: false }),
        client.listAgentResourcesForServer(server_id, { limit: agent_resource_limit }),
        client.listServerTemplateMappings(server_id, { pageSize: 50, maxPages: 1 })
      ]);
      let attributes = [];
      try {
        attributes = await client.listServerAttributes(server_id, { pageSize: 50, maxPages: 1 });
      } catch (err) {
        attributes = [{ error: err?.message ?? String(err) }];
      }
      return {
        server: pickServerFields(server),
        outages: summarizeOutages(outagesBody?.outage_list ?? []),
        agent_resources: (resourcesBody?.agent_resource_list ?? []).map((r) => ({
          id: r.id,
          type: r.agent_resource_type,
          resource_option: r.resource_option ?? null,
          status: r.status ?? null
        })),
        templates: templatesBody.map((m) => ({ template_id: m.templateId, continuous: m.continuous })),
        attributes: attributes.map((a) => ({ name: a.name, value: a.value, textkey: a.textkey }))
      };
    },

    compare_servers: async ({ server_ids = [] }) => {
      const ids = Array.isArray(server_ids) ? server_ids.slice(0, 10) : [];
      if (ids.length === 0) return { servers: [] };
      const out = await mapWithConcurrency(ids, 5, async (id) => {
        const [server, resourcesBody, templatesBody] = await Promise.all([
          client.getServer(id),
          client.listAgentResourcesForServer(id, { limit: 1, offset: 0 }),
          client.listServerTemplateMappings(id, { pageSize: 1, maxPages: 1 })
        ]);
        return {
          ...pickServerFields(server),
          agent_resource_count: resourcesBody?.meta?.total_count ?? (resourcesBody?.agent_resource_list ?? []).length,
          attached_template_count: templatesBody.length
        };
      });
      return {
        servers: out.map((r, i) => r.ok ? r.value : { id: ids[i], error: r.error })
      };
    },

    audit_monitoring_coverage: async ({ name_contains = null, max_servers = 50 } = {}) => {
      const cap = Math.max(1, Math.min(200, max_servers));
      const PAGE = 100;
      const candidates = [];
      let offset = 0;
      while (candidates.length < cap) {
        const body = await client.listServers({ limit: PAGE, offset });
        const list = body?.server_list ?? [];
        if (list.length === 0) break;
        for (const s of list) {
          if (candidates.length >= cap) break;
          if (name_contains && typeof s.name === 'string' && !s.name.toLowerCase().includes(name_contains.toLowerCase())) continue;
          const id = s.id ?? extractIdFromUrl(s.url);
          if (id != null) candidates.push({ id, name: s.name });
        }
        const total = body?.meta?.total_count ?? offset + list.length;
        offset += list.length;
        if (offset >= total) break;
      }
      const checked = await mapWithConcurrency(candidates, 5, async (s) => {
        const mappings = await client.listServerTemplateMappings(s.id, { pageSize: 1, maxPages: 1 });
        return { ...s, template_count: mappings.length };
      });
      const without = checked
        .filter((r) => r.ok && r.value.template_count === 0)
        .map((r) => r.value);
      return {
        scanned: candidates.length,
        capped: candidates.length === cap,
        without_templates: without
      };
    },

    generate_incident_timeline: async ({ outage_id, window_minutes = 60 }) => {
      const outage = await client.getOutage(outage_id);
      const serverUrl = outage?.server_url ?? outage?.server?.url ?? null;
      const m = typeof serverUrl === 'string' ? serverUrl.match(/\/server\/(\d+)\/?$/) : null;
      const serverId = m ? Number(m[1]) : (outage?.server?.id ?? null);
      let server = null;
      let adjacent = [];
      if (serverId != null) {
        try { server = await client.getServer(serverId); } catch { server = null; }
        try {
          const body = await client.listOutages({ limit: 50, serverId, active: false });
          const all = body?.outage_list ?? [];
          adjacent = all.filter((o) => withinWindow(o, outage, window_minutes)).map(summarizeOneOutage);
        } catch {
          adjacent = [];
        }
      }
      return {
        focal_outage: summarizeOneOutage(outage),
        server: server ? pickServerFields(server) : null,
        adjacent_outages: adjacent
      };
    },

    find_flapping_servers: async ({ min_outages = 3, lookback_outages = 200 } = {}) => {
      const cap = Math.max(1, Math.min(500, lookback_outages));
      const counts = new Map();
      const PAGE = 100;
      let offset = 0;
      while (offset < cap) {
        const body = await client.listOutages({ limit: Math.min(PAGE, cap - offset), offset, active: false });
        const list = body?.outage_list ?? [];
        if (list.length === 0) break;
        for (const o of list) {
          const sid = o.server?.id ?? extractServerIdFromOutage(o);
          if (sid == null) continue;
          const key = Number(sid);
          if (!counts.has(key)) counts.set(key, { id: key, name: o.server?.name ?? null, outage_count: 0 });
          counts.get(key).outage_count += 1;
        }
        offset += list.length;
        const total = body?.meta?.total_count ?? offset;
        if (offset >= total) break;
      }
      const flapping = [...counts.values()]
        .filter((s) => s.outage_count >= min_outages)
        .sort((a, b) => b.outage_count - a.outage_count);
      return { scanned: offset, threshold: min_outages, flapping };
    }
  };
}

function pickServerFields(server) {
  if (!server || typeof server !== 'object') return null;
  return {
    id: server.id ?? extractIdFromUrl(server.url),
    name: server.name ?? null,
    status: server.status ?? null,
    tags: Array.isArray(server.tags) ? server.tags : []
  };
}

function summarizeOutages(list) {
  return list.map(summarizeOneOutage);
}

function summarizeOneOutage(o) {
  return {
    id: o?.id ?? null,
    active: o?.active ?? null,
    acknowledged: o?.acknowledged ?? null,
    severity: o?.severity ?? null,
    start: o?.start ?? null,
    end: o?.end ?? null
  };
}

function extractServerIdFromOutage(outage) {
  const url = outage?.server_url ?? outage?.server?.url ?? null;
  if (typeof url !== 'string') return null;
  const m = url.match(/\/server\/(\d+)\/?$/);
  return m ? Number(m[1]) : null;
}

function extractIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  const parts = url.split('/').filter(Boolean);
  const n = Number(parts.pop());
  return Number.isFinite(n) ? n : null;
}

function withinWindow(otherOutage, focal, windowMinutes) {
  if (!otherOutage || otherOutage.id === focal?.id) return false;
  const focalStart = parseTime(focal?.start);
  const otherStart = parseTime(otherOutage?.start);
  if (focalStart == null || otherStart == null) return false;
  return Math.abs(otherStart - focalStart) <= windowMinutes * 60_000;
}

function parseTime(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
