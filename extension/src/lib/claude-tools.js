// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FortiMonitor tool subset for the "Ask Claude" prototype (FMN-53).
//
// Tool definitions (Anthropic schema) + JS handlers that call PanoptaClient.
// Mirrors a narrow slice of the fortimonitor-mcp-server Python tools — see
// docs/mcp-chat-prototype.md for the scope rationale.
//
// Writes are gated: acknowledge_outage is the only write in the prototype
// and the UI layer must confirm before dispatching.

export const SYSTEM_PROMPT = [
  'You are an assistant embedded in the Unofficial FortiMonitor Toolkit browser extension.',
  'You help the user query their FortiMonitor environment using the tools provided.',
  'Guidelines:',
  '- When asked about servers, outages, templates, or fabric connections, call tools rather than guessing.',
  '- Server identifiers are numeric. If the user gives a name, call search_servers first, then use the resulting id.',
  '- Outage lists are paginated; default to page 1 unless the user asks for more.',
  '- Be concise. Summaries over raw JSON dumps.',
  '- Never call acknowledge_outage without explicit user instruction for a specific outage id.',
  '- If a tool returns an error, tell the user plainly what failed.'
].join('\n');

/**
 * Build the full Anthropic tool definition array.
 */
export function buildToolDefinitions() {
  return [
    {
      name: 'search_servers',
      description: 'Search FortiMonitor servers by name substring. Returns a list of matches with id and name. Use this first when the user refers to a server by name rather than id.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name or substring to search for.' },
          limit: { type: 'integer', description: 'Max results (default 25).', default: 25 }
        },
        required: ['name']
      }
    },
    {
      name: 'list_servers',
      description: 'List servers in the FortiMonitor account, paginated. Use this for general enumeration; prefer search_servers when you know the name.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Page size (default 25, max 200).', default: 25 },
          offset: { type: 'integer', description: 'Pagination offset.', default: 0 }
        }
      }
    },
    {
      name: 'get_server',
      description: 'Get detailed information about a single server by its numeric id.',
      input_schema: {
        type: 'object',
        properties: {
          server_id: { type: 'integer', description: 'Numeric server id.' }
        },
        required: ['server_id']
      }
    },
    {
      name: 'list_active_outages',
      description: 'List currently-active (ongoing) outages across the account.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 25 },
          offset: { type: 'integer', default: 0 },
          server_id: { type: 'integer', description: 'Optional filter by server id.' }
        }
      }
    },
    {
      name: 'list_outages',
      description: 'List outages (active and resolved), paginated. Use list_active_outages if you only want ongoing ones.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 25 },
          offset: { type: 'integer', default: 0 },
          server_id: { type: 'integer', description: 'Optional filter by server id.' }
        }
      }
    },
    {
      name: 'get_outage',
      description: 'Get detailed information about a single outage by its numeric id.',
      input_schema: {
        type: 'object',
        properties: {
          outage_id: { type: 'integer' }
        },
        required: ['outage_id']
      }
    },
    {
      name: 'list_agent_resources_for_server',
      description: 'List agent resources (metrics/interfaces) configured on a server. Useful for interface-level questions.',
      input_schema: {
        type: 'object',
        properties: {
          server_id: { type: 'integer' },
          limit: { type: 'integer', default: 50 },
          offset: { type: 'integer', default: 0 }
        },
        required: ['server_id']
      }
    },
    {
      name: 'list_fabric_connections',
      description: 'List FortiGate Security Fabric connections (OnSight CSF tunnels).',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 25 },
          offset: { type: 'integer', default: 0 }
        }
      }
    },
    {
      name: 'list_templates',
      description: 'List monitoring templates owned by the account.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 50 },
          offset: { type: 'integer', default: 0 }
        }
      }
    },
    {
      name: 'list_server_groups',
      description: 'List server groups in the FortiMonitor account.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 50 }
        }
      }
    },
    {
      name: 'acknowledge_outage',
      description: 'Acknowledge a specific outage by id. WRITE operation — only use when the user has explicitly asked to acknowledge a particular outage id.',
      input_schema: {
        type: 'object',
        properties: {
          outage_id: { type: 'integer' },
          message: { type: 'string', description: 'Optional acknowledgement note.' }
        },
        required: ['outage_id']
      }
    }
  ];
}

/**
 * Build the tool-name → handler map. Each handler takes the parsed input
 * object and returns a JSON-serializable result.
 */
export function buildToolHandlers(client) {
  if (!client) throw new TypeError('buildToolHandlers: client is required');
  return {
    search_servers: async ({ name, limit = 25 }) => {
      const body = await client.listServers({ name, limit });
      const list = body?.server_list ?? [];
      return list.map((s) => ({ id: s.id, name: s.name, status: s.status ?? null }));
    },
    list_servers: async ({ limit = 25, offset = 0 }) => {
      const body = await client.listServers({ limit, offset });
      const list = body?.server_list ?? [];
      return {
        total: body?.meta?.total_count ?? list.length,
        offset,
        limit,
        servers: list.map((s) => ({ id: s.id, name: s.name, status: s.status ?? null }))
      };
    },
    get_server: async ({ server_id }) => {
      const body = await client.getServer(server_id);
      return body;
    },
    list_active_outages: async ({ limit = 25, offset = 0, server_id = null }) => {
      const body = await client.listOutages({ limit, offset, serverId: server_id, active: true });
      const list = body?.outage_list ?? [];
      return {
        total: body?.meta?.total_count ?? list.length,
        outages: summarizeOutages(list)
      };
    },
    list_outages: async ({ limit = 25, offset = 0, server_id = null }) => {
      const body = await client.listOutages({ limit, offset, serverId: server_id, active: false });
      const list = body?.outage_list ?? [];
      return {
        total: body?.meta?.total_count ?? list.length,
        outages: summarizeOutages(list)
      };
    },
    get_outage: async ({ outage_id }) => {
      return await client.getOutage(outage_id);
    },
    list_agent_resources_for_server: async ({ server_id, limit = 50, offset = 0 }) => {
      const body = await client.listAgentResourcesForServer(server_id, { limit, offset });
      const list = body?.agent_resource_list ?? [];
      return {
        total: body?.meta?.total_count ?? list.length,
        resources: list.map((r) => ({
          id: r.id,
          type: r.agent_resource_type,
          resource_option: r.resource_option ?? null,
          status: r.status ?? null
        }))
      };
    },
    list_fabric_connections: async ({ limit = 25, offset = 0 }) => {
      const body = await client.listFabricConnections({ limit, offset });
      const list = body?.fabric_connection_list ?? body?.objects ?? [];
      return {
        total: body?.meta?.total_count ?? list.length,
        connections: list.map((c) => ({
          id: c.id,
          label: c.label,
          upstream_host: c.upstream_host,
          upstream_sn: c.upstream_sn,
          integration_type: c.integration_type
        }))
      };
    },
    list_templates: async ({ limit = 50, offset = 0 }) => {
      const body = await client._request('GET', `/server_template?limit=${limit}&offset=${offset}`);
      const list = body?.body?.server_template_list ?? [];
      return {
        total: body?.body?.meta?.total_count ?? list.length,
        templates: list.map((t) => ({
          id: extractIdFromUrl(t.url),
          name: t.name,
          template_type: t.template_type,
          applied_server_count: Array.isArray(t.applied_servers) ? t.applied_servers.length : 0
        }))
      };
    },
    list_server_groups: async ({ limit = 50 }) => {
      const groups = await client.listServerGroups({ limit });
      return groups.map((g) => ({ id: g.id, name: g.name }));
    },
    acknowledge_outage: async ({ outage_id, message = null }) => {
      const result = await client.acknowledgeOutage(outage_id, { message });
      return { ok: true, status: result.status, outage_id };
    }
  };
}

function summarizeOutages(list) {
  return list.map((o) => ({
    id: o.id,
    server: o.server?.name ?? o.server_url ?? null,
    active: o.active ?? null,
    acknowledged: o.acknowledged ?? null,
    start: o.start ?? null,
    end: o.end ?? null,
    severity: o.severity ?? null
  }));
}

function extractIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  const parts = url.split('/').filter(Boolean);
  return Number(parts.pop());
}
