// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FortiMonitor tool catalog for the "Ask Claude" feature.
//
// Two layers:
//   1. Hand-written tools (this file's HAND_WRITTEN_TOOLS): summarised,
//      operator-friendly read helpers + acknowledge_outage. These ship
//      narrower input/output shapes than the raw v2 endpoints, e.g.
//      list_servers returns a trimmed { id, name, status } projection
//      instead of the full server object. Hand-written tools always win
//      collisions against codegen entries.
//   2. Codegen tools (extension/src/lib/claude-tools/codegen/*): emitted
//      from the FortiMonitor v2 OpenAPI by tools/codegen/run.mjs (FMN-96)
//      with FMN-108 collision-resolving names. 262 unique definitions
//      across 33 domains. Their handlers go through the dispatcher
//      (codegen/dispatcher.js) which substitutes path/query/body params
//      into a single PanoptaClient._request call.
//   3. Hand-port modules (extension/src/lib/claude-tools/handwritten/*):
//      multi-call workflow tools (bulk_*, composite analyses) that the
//      OpenAPI cannot describe because they are aggregations.
//
// Tier filtering (FMN-97): each tool carries a 'readonly' | 'readwrite' |
// 'all' tier. buildToolDefinitions(tier) filters by the operator's
// Settings choice; 'readonly' includes only readonly tools, 'readwrite'
// includes readonly + readwrite, 'all' includes everything.
//
// Writes are gated at the prompt + UI layer too: SYSTEM_PROMPT instructs
// Claude not to call write tools without an explicit user ask, and the
// chat UI surfaces tool calls so the operator sees them.

import { ALL_CODEGEN_TOOLS } from './claude-tools/codegen/index.js';
import {
  buildAllCodegenHandlers,
  stripSpecForApi
} from './claude-tools/codegen/dispatcher.js';
import { BULK_OPS_TOOLS, buildBulkOpsHandlers } from './claude-tools/handwritten/bulk_operations.js';
import { COMPOSITE_TOOLS, buildCompositeHandlers } from './claude-tools/handwritten/composite.js';

const SYSTEM_PROMPT_BASE = [
  'You are an assistant embedded in the Unofficial FortiMonitor Toolkit browser extension.',
  'You help the user query their FortiMonitor environment using the tools provided.'
].join('\n');

const SYSTEM_PROMPT_HINT_BLOCK = [
  '',
  'Tool selection quick-reference (the user expects you to USE these without asking for clarification):',
  '- "active outages", "current outages", "what is broken right now" -> call list_active_outages (no arguments needed for the account-wide view).',
  '- "outages for server X", "outage history" -> call list_outages with server_id (or no filter for all).',
  '- "outage details", "tell me about outage <id>" -> call get_outage with outage_id.',
  '- "find server X", "look up server by name" -> call search_servers with the name substring.',
  '- "list servers", "show servers" -> call list_servers.',
  '- "tell me about server X" or "server details" -> call get_server with server_id.',
  '- "list interfaces / agent resources / metrics for server X" -> call list_agent_resources_for_server.',
  '- "list templates" / "monitoring templates" -> call list_templates.',
  '- "list fabric connections" / "CSF tunnels" -> call list_fabric_connections.',
  '- "list groups", "server groups" -> call list_server_groups.'
].join('\n');

const SYSTEM_PROMPT_GUIDELINES = [
  '',
  'General guidelines:',
  '- Always call a tool before asking the user for clarification on a question that the tool catalog can answer. For account-wide queries like "active outages", call the tool with no filters first; if the result is too large, then ask the user to narrow.',
  '- Server identifiers are numeric. If the user gives a name, call search_servers first, then use the resulting id.',
  '- Outage lists are paginated; default to page 1 unless the user asks for more.',
  '- Be concise. Summaries over raw JSON dumps.',
  '- Never call write tools (create_*, update_*, delete_*, replace_*, acknowledge_*, bulk_*) without explicit user instruction for a specific resource id.',
  '- If a tool returns an error, tell the user plainly what failed.'
].join('\n');

/**
 * Build the system prompt sent on every chat turn.
 *
 * @param {{ promptHints?: boolean }} [opts]
 *   - promptHints (default true): include the per-query tool-selection
 *     quick-reference block introduced in commit 841247a. The matrix test
 *     toggles this off via storage to A/B the hint's contribution.
 */
export function buildSystemPrompt({ promptHints = true } = {}) {
  if (promptHints) {
    return [SYSTEM_PROMPT_BASE, SYSTEM_PROMPT_HINT_BLOCK, SYSTEM_PROMPT_GUIDELINES].join('\n');
  }
  return [SYSTEM_PROMPT_BASE, SYSTEM_PROMPT_GUIDELINES].join('\n');
}

// Back-compat: the constant export still resolves to the prompt-with-hints
// variant, which is the production default. Callers that need the toggle
// should switch to buildSystemPrompt({ promptHints }).
export const SYSTEM_PROMPT = buildSystemPrompt({ promptHints: true });

/**
 * Filter check: is a tool of `toolTier` included when the operator
 * selected `requestedTier`?
 *   readonly  -> only readonly
 *   readwrite -> readonly + readwrite
 *   all       -> everything
 */
function tierIncludes(toolTier, requestedTier) {
  if (requestedTier === 'all') return true;
  if (requestedTier === 'readwrite') return toolTier === 'readonly' || toolTier === 'readwrite';
  return toolTier === 'readonly';
}

/**
 * The hand-written tool catalog. Each entry carries:
 *   - tier: 'readonly' | 'readwrite' (no 'all' tier in hand-written)
 *   - name, description, input_schema: standard Anthropic tool shape
 *   - _handler: the async function the runtime dispatches when Claude
 *               calls the tool. Stripped before sending to the API.
 *
 * Hand-written tools are intentionally narrower than their codegen
 * equivalents (e.g. list_servers returns { id, name, status } instead of
 * the full server object) so chat token cost stays manageable on the
 * common queries.
 */
const HAND_WRITTEN_TOOLS = [
  {
    name: 'search_servers',
    tier: 'readonly',
    description: 'Search FortiMonitor servers by name substring. Returns a list of matches with id and name. Use this first when the user refers to a server by name rather than id.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name or substring to search for.' },
        limit: { type: 'integer', description: 'Max results (default 25).', default: 25 }
      },
      required: ['name']
    },
    _handler: (client) => async ({ name, limit = 25 }) => {
      const body = await client.listServers({ name, limit });
      const list = body?.server_list ?? [];
      return list.map((s) => ({ id: s.id, name: s.name, status: s.status ?? null }));
    }
  },
  {
    name: 'list_servers',
    tier: 'readonly',
    description: 'List servers in the FortiMonitor account, paginated. Use this for general enumeration; prefer search_servers when you know the name.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Page size (default 25, max 200).', default: 25 },
        offset: { type: 'integer', description: 'Pagination offset.', default: 0 }
      }
    },
    _handler: (client) => async ({ limit = 25, offset = 0 }) => {
      const body = await client.listServers({ limit, offset });
      const list = body?.server_list ?? [];
      return {
        total: body?.meta?.total_count ?? list.length,
        offset,
        limit,
        servers: list.map((s) => ({ id: s.id, name: s.name, status: s.status ?? null }))
      };
    }
  },
  {
    name: 'get_server',
    tier: 'readonly',
    description: 'Get detailed information about a single server by its numeric id.',
    input_schema: {
      type: 'object',
      properties: {
        server_id: { type: 'integer', description: 'Numeric server id.' }
      },
      required: ['server_id']
    },
    _handler: (client) => async ({ server_id }) => {
      const body = await client.getServer(server_id);
      return body;
    }
  },
  {
    name: 'list_active_outages',
    tier: 'readonly',
    description: 'List currently-active (ongoing) outages across the account.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 25 },
        offset: { type: 'integer', default: 0 },
        server_id: { type: 'integer', description: 'Optional filter by server id.' }
      }
    },
    _handler: (client) => async ({ limit = 25, offset = 0, server_id = null }) => {
      const body = await client.listOutages({ limit, offset, serverId: server_id, active: true });
      const list = body?.outage_list ?? [];
      return {
        total: body?.meta?.total_count ?? list.length,
        outages: summarizeOutages(list)
      };
    }
  },
  {
    name: 'list_outages',
    tier: 'readonly',
    description: 'List outages (active and resolved), paginated. Use list_active_outages if you only want ongoing ones.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 25 },
        offset: { type: 'integer', default: 0 },
        server_id: { type: 'integer', description: 'Optional filter by server id.' }
      }
    },
    _handler: (client) => async ({ limit = 25, offset = 0, server_id = null }) => {
      const body = await client.listOutages({ limit, offset, serverId: server_id, active: false });
      const list = body?.outage_list ?? [];
      return {
        total: body?.meta?.total_count ?? list.length,
        outages: summarizeOutages(list)
      };
    }
  },
  {
    name: 'get_outage',
    tier: 'readonly',
    description: 'Get detailed information about a single outage by its numeric id.',
    input_schema: {
      type: 'object',
      properties: { outage_id: { type: 'integer' } },
      required: ['outage_id']
    },
    _handler: (client) => async ({ outage_id }) => await client.getOutage(outage_id)
  },
  {
    name: 'list_agent_resources_for_server',
    tier: 'readonly',
    description: 'List agent resources (metrics/interfaces) configured on a server. Useful for interface-level questions.',
    input_schema: {
      type: 'object',
      properties: {
        server_id: { type: 'integer' },
        limit: { type: 'integer', default: 50 },
        offset: { type: 'integer', default: 0 }
      },
      required: ['server_id']
    },
    _handler: (client) => async ({ server_id, limit = 50, offset = 0 }) => {
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
    }
  },
  {
    name: 'list_fabric_connections',
    tier: 'readonly',
    description: 'List FortiGate Security Fabric connections (OnSight CSF tunnels).',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 25 },
        offset: { type: 'integer', default: 0 }
      }
    },
    _handler: (client) => async ({ limit = 25, offset = 0 }) => {
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
    }
  },
  {
    name: 'list_templates',
    tier: 'readonly',
    description: 'List monitoring templates owned by the account.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 50 },
        offset: { type: 'integer', default: 0 }
      }
    },
    _handler: (client) => async ({ limit = 50, offset = 0 }) => {
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
    }
  },
  {
    name: 'list_server_groups',
    tier: 'readonly',
    description: 'List server groups in the FortiMonitor account.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', default: 50 } }
    },
    _handler: (client) => async ({ limit = 50 }) => {
      const groups = await client.listServerGroups({ limit });
      return groups.map((g) => ({ id: g.id, name: g.name }));
    }
  },
  {
    name: 'acknowledge_outage',
    tier: 'readwrite',
    description: 'Acknowledge a specific outage by id. WRITE operation - only use when the user has explicitly asked to acknowledge a particular outage id.',
    input_schema: {
      type: 'object',
      properties: {
        outage_id: { type: 'integer' },
        message: { type: 'string', description: 'Optional acknowledgement note.' }
      },
      required: ['outage_id']
    },
    _handler: (client) => async ({ outage_id, message = null }) => {
      const result = await client.acknowledgeOutage(outage_id, { message });
      return { ok: true, status: result.status, outage_id };
    }
  }
];

const HAND_WRITTEN_NAMES = new Set(HAND_WRITTEN_TOOLS.map((t) => t.name));

function stripPrivateFields(tool) {
  // eslint-disable-next-line no-unused-vars
  const { _handler, tier, ...rest } = tool;
  return rest;
}

/**
 * Build the Anthropic tool-definition array for the chat turn.
 *
 * @param {('readonly'|'readwrite'|'all')} [tier='readonly'] operator's tier
 * @returns {Array<object>} tool definitions sans internal `_spec` / `_handler` / `tier`
 */
export function buildToolDefinitions(tier = 'readonly', { provider = 'anthropic', filterCodegen = true } = {}) {
  const handWritten = HAND_WRITTEN_TOOLS
    .filter((t) => tierIncludes(t.tier, tier))
    .map(stripPrivateFields);

  const handPort = [...BULK_OPS_TOOLS, ...COMPOSITE_TOOLS]
    .filter((t) => tierIncludes(t.tier, tier))
    .filter((t) => !HAND_WRITTEN_NAMES.has(t.name))
    .map(stripPrivateFields);

  const handPortNames = new Set([...HAND_WRITTEN_NAMES, ...handPort.map((t) => t.name)]);

  // FMN-120: local providers (Ollama, LM Studio) optionally get only
  // the curated handwritten + hand-port catalog. The codegen 260+ tools
  // were observed breaking tool selection on small/medium open models;
  // the matrix test (Phase 2) toggles `filterCodegen` to measure the
  // filter's actual contribution rather than acting on n=3 anecdote.
  // Cloud Anthropic always gets the full catalog.
  if (provider !== 'anthropic' && filterCodegen) {
    return [...handWritten, ...handPort];
  }

  const codegen = ALL_CODEGEN_TOOLS
    .filter((t) => tierIncludes(t.tier, tier))
    .filter((t) => !handPortNames.has(t.name))
    .map(stripSpecForApi);

  return [...handWritten, ...handPort, ...codegen];
}

/**
 * Build the tool-name → handler map for runtime dispatch.
 *
 * Hand-written and hand-port handlers win on collision (they wrap codegen
 * names with summarised behavior). The dispatch is unified - every tool
 * Claude can name has an entry here, regardless of whether it came from
 * hand-written, hand-port, or codegen.
 *
 * @param {object} client - PanoptaClient instance
 */
export function buildToolHandlers(client) {
  if (!client) throw new TypeError('buildToolHandlers: client is required');

  const codegenHandlers = buildAllCodegenHandlers(ALL_CODEGEN_TOOLS, client);
  const bulkHandlers = buildBulkOpsHandlers(client);
  const compositeHandlers = buildCompositeHandlers(client);

  const handWritten = {};
  for (const t of HAND_WRITTEN_TOOLS) {
    handWritten[t.name] = t._handler(client);
  }

  // Order matters: codegen first (lowest priority), then hand-port, then
  // hand-written - later spreads overwrite earlier ones on collision.
  return {
    ...codegenHandlers,
    ...bulkHandlers,
    ...compositeHandlers,
    ...handWritten
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
