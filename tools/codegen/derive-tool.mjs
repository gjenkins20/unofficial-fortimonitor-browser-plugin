// FMN-96: pure transforms from an OpenAPI operation to a claude-tool spec.
//
// Kept as a standalone, dependency-free module so unit tests can exercise
// the naming / domain / tier / spec-shape logic without the rest of the
// codegen pipeline. The runtime never imports this file - it consumes the
// generated output under extension/src/lib/claude-tools/codegen/.

const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * Pluralize a single English noun for naming domain modules and list-style
 * tool names. Cheap heuristic; OpenAPI segments are limited and predictable.
 *   server -> servers
 *   policy -> policies
 *   address -> addresses
 *   onsight_group -> onsight_groups
 */
export function pluralize(s) {
  if (!s) return s;
  if (s.endsWith('y') && !/[aeiou]y$/.test(s)) return s.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/.test(s)) return s + 'es';
  return s + 's';
}

/**
 * Domain name for a path - the first non-placeholder segment, pluralized.
 *   /server/{server_id}/server_attribute -> servers
 *   /cloud_credential/{cloud_credential_id}/cloud_discovery -> cloud_credentials
 *   /outage -> outages
 */
export function deriveDomain(path) {
  const segs = path.split('/').filter(Boolean);
  for (const s of segs) {
    if (!s.startsWith('{')) return pluralize(s);
  }
  return 'misc';
}

/**
 * Last non-placeholder segment of the path, used as the resource noun in
 * tool names.
 *   /server -> server
 *   /server/{server_id} -> server
 *   /server/{server_id}/server_attribute -> server_attribute
 *   /server/{server_id}/server_attribute/{attr_id} -> server_attribute
 */
export function lastResource(path) {
  const segs = path.split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    if (!segs[i].startsWith('{')) return segs[i];
  }
  return null;
}

/**
 * True when the path's last segment is a placeholder (i.e., this operation
 * targets a single resource by id).
 */
export function pathTargetsSingleResource(path) {
  const segs = path.split('/').filter(Boolean);
  return segs.length > 0 && segs[segs.length - 1].startsWith('{');
}

/**
 * Tool name from path + HTTP method. Heuristic, matches how the Python MCP
 * server names its tools wherever possible:
 *   GET    /server                        -> list_servers
 *   GET    /server/{server_id}            -> get_server
 *   POST   /server                        -> create_server
 *   PUT    /server/{server_id}            -> update_server
 *   PATCH  /server/{server_id}            -> update_server
 *   DELETE /server/{server_id}            -> delete_server
 *   GET    /server/{id}/server_attribute  -> list_server_attributes
 *   POST   /server/{id}/server_attribute  -> create_server_attribute
 *   GET    /server/{id}/server_attribute/{aid} -> get_server_attribute
 */
export function deriveToolName(path, method) {
  const m = method.toLowerCase();
  const last = lastResource(path);
  if (!last) return `${m}_unknown`;
  const single = pathTargetsSingleResource(path);
  if (m === 'get') return single ? `get_${last}` : `list_${pluralize(last)}`;
  if (m === 'post') return `create_${last}`;
  if (m === 'put' || m === 'patch') return `update_${last}`;
  if (m === 'delete') return `delete_${last}`;
  return `${m}_${last}`;
}

/**
 * Tier classification from HTTP method. GET is readonly; everything else
 * is readwrite. The 'all' tier is reserved for explicit-opt-in tools that
 * codegen can't infer from method alone (e.g. aggressive bulk ops); none
 * are emitted by codegen today.
 */
export function deriveTier(method) {
  return method.toLowerCase() === 'get' ? 'readonly' : 'readwrite';
}

/**
 * Translate an OpenAPI parameter `schema` into a JSON Schema fragment
 * suitable for an Anthropic tool's input_schema.properties entry.
 *
 * The OpenAPI 3.0.3 spec we consume already uses JSON Schema for
 * parameter definitions, so this is mostly a passthrough with minor
 * normalisations:
 * - drop $ref pointers (Anthropic doesn't resolve them); fall back to
 *   { type: 'object' } so Claude knows the shape is freeform.
 * - keep type, description, enum, items, default, format if present.
 */
export function normalizeParamSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object' };
  if (schema.$ref) return { type: 'object', description: 'Object body (see API docs).' };
  const out = {};
  for (const k of ['type', 'description', 'enum', 'items', 'default', 'format']) {
    if (schema[k] !== undefined) out[k] = schema[k];
  }
  if (!out.type && out.items) out.type = 'array';
  if (!out.type) out.type = 'string';
  return out;
}

/**
 * Convert a single OpenAPI operation into a claude-tool descriptor.
 *
 * Returns an object:
 *   {
 *     name, tier, description, input_schema,
 *     _spec: { method, path, pathParams, queryParams, bodyParams }
 *   }
 *
 * The `_spec` block is metadata for the runtime dispatcher - it lets a
 * single hand-written dispatcher in dispatcher.js run any generated tool
 * without per-tool code generation.
 */
export function operationToTool(path, method, op) {
  const name = deriveToolName(path, method);
  const tier = deriveTier(method);
  const description = (op?.summary || op?.description || `${method.toUpperCase()} ${path}`).trim();

  const properties = {};
  const required = [];
  const pathParams = [];
  const queryParams = [];
  const bodyParams = [];

  for (const p of (op?.parameters ?? [])) {
    if (!p || !p.name) continue;
    const propSchema = normalizeParamSchema(p.schema);
    if (p.description && !propSchema.description) propSchema.description = p.description;
    properties[p.name] = propSchema;
    if (p.in === 'path') {
      pathParams.push(p.name);
      required.push(p.name);
    } else if (p.in === 'query') {
      queryParams.push(p.name);
      if (p.required) required.push(p.name);
    }
  }

  // requestBody: lift each top-level property of the JSON body into the
  // input_schema. Avoids nested "body: {...}" in Claude's tool schema,
  // which makes prompt phrasing simpler.
  const rb = op?.requestBody;
  if (rb && rb.content) {
    const json = rb.content['application/json'] || rb.content[Object.keys(rb.content)[0]];
    if (json?.schema?.properties && typeof json.schema.properties === 'object') {
      for (const [bname, bschema] of Object.entries(json.schema.properties)) {
        if (properties[bname]) continue; // path/query already used the name; skip.
        properties[bname] = normalizeParamSchema(bschema);
        bodyParams.push(bname);
        if (Array.isArray(json.schema.required) && json.schema.required.includes(bname)) {
          required.push(bname);
        }
      }
    } else if (rb.required) {
      // Schema isn't introspectable - mark a generic body field.
      properties.body = { type: 'object', description: 'Request body (see API docs).' };
      bodyParams.push('body');
      required.push('body');
    }
  }

  const input_schema = { type: 'object' };
  if (Object.keys(properties).length > 0) input_schema.properties = properties;
  if (required.length > 0) input_schema.required = Array.from(new Set(required));

  return {
    name,
    tier,
    description,
    input_schema,
    _spec: {
      method: method.toUpperCase(),
      path,
      pathParams,
      queryParams,
      bodyParams
    }
  };
}

/**
 * Walk an OpenAPI 3.x document, return tools grouped by domain.
 *
 * Returns:
 *   {
 *     <domain>: [<tool>, ...],
 *     ...
 *   }
 *
 * Tools are sorted by name within each domain so the generated output is
 * byte-stable across runs (prompt-cache stability per FMN-66).
 */
export function compileToolsByDomain(spec) {
  const byDomain = {};
  const paths = spec?.paths ?? {};
  for (const [p, ops] of Object.entries(paths)) {
    if (!ops || typeof ops !== 'object') continue;
    for (const [verb, op] of Object.entries(ops)) {
      if (!HTTP_VERBS.includes(verb.toLowerCase())) continue;
      if (!op || typeof op !== 'object') continue;
      const tool = operationToTool(p, verb, op);
      const domain = deriveDomain(p);
      if (!byDomain[domain]) byDomain[domain] = [];
      byDomain[domain].push(tool);
    }
  }
  for (const d of Object.keys(byDomain)) {
    byDomain[d].sort((a, b) => a.name.localeCompare(b.name));
  }
  return byDomain;
}

/**
 * Render a domain module as a deterministic JS source string.
 * Keep formatting stable - no timestamps, no Map/Set iteration order
 * surprises - so prompt caches survive identical inputs.
 */
export function renderDomainModule(domain, tools) {
  const header = [
    '// AUTO-GENERATED by tools/codegen/run.mjs - do not edit by hand.',
    '// Source: schema-discovery OpenAPI compiled spec.',
    '// Run: npm run codegen:ask-claude-tools',
    '//',
    `// Domain: ${domain}    Tools: ${tools.length}`,
    ''
  ].join('\n');
  const body = `export const TOOLS = ${stableStringify(tools, 2)};\n`;
  return header + body;
}

/**
 * JSON.stringify with stable key order. Necessary because objects from
 * compileToolsByDomain may have keys in insertion order but other
 * environments could re-emit them differently; deterministic key order
 * makes the codegen byte-stable.
 */
export function stableStringify(value, indent = 2) {
  return JSON.stringify(value, replacer, indent);
  function replacer(_key, v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ordered = {};
      for (const k of Object.keys(v).sort()) ordered[k] = v[k];
      return ordered;
    }
    return v;
  }
}
