// FMN-96: runtime dispatcher for codegen-emitted tool definitions.
//
// The codegen output (sibling .js modules in this directory) is pure data:
// each tool definition carries an `_spec` block with method, path,
// pathParams, queryParams, bodyParams. This dispatcher converts that
// metadata into an async handler that calls the existing PanoptaClient
// without a per-tool hand-written function. One handler shape covers
// every endpoint-direct tool the codegen emits.
//
// Keep this file hand-written. It must stay aligned with the codegen
// output's `_spec` shape - if derive-tool.mjs ever changes the spec
// schema, update this file and re-run codegen.

/**
 * Build a single async handler for one codegen tool.
 *
 * @param {{ method: string, path: string, pathParams: string[],
 *           queryParams: string[], bodyParams: string[] }} spec
 * @param {object} client - a PanoptaClient instance with _request(method, path, { body }).
 * @returns {(input: object) => Promise<any>}
 */
export function buildCodegenHandler(spec, client) {
  return async (input = {}) => {
    let path = spec.path;
    for (const p of spec.pathParams) {
      const v = input[p];
      if (v === undefined || v === null) {
        throw new Error(`Tool requires path parameter '${p}'`);
      }
      path = path.replace(`{${p}}`, encodeURIComponent(String(v)));
    }

    const params = new URLSearchParams();
    for (const q of spec.queryParams) {
      const v = input[q];
      if (v === undefined || v === null) continue;
      params.set(q, String(v));
    }
    const qs = params.toString();
    const fullPath = qs ? `${path}?${qs}` : path;

    let body = null;
    if (spec.bodyParams.length > 0) {
      body = {};
      for (const b of spec.bodyParams) {
        if (input[b] !== undefined) body[b] = input[b];
      }
      if (Object.keys(body).length === 0) body = null;
    }

    const result = await client._request(spec.method, fullPath, body !== null ? { body } : undefined);
    // PanoptaClient._request returns { res, body }. Tools want the parsed body.
    return result?.body ?? null;
  };
}

/**
 * Build a name -> handler map for an array of codegen tool definitions.
 *
 * @param {Array<{ name: string, _spec: object }>} tools
 * @param {object} client
 * @returns {Record<string, (input: object) => Promise<any>>}
 */
export function buildAllCodegenHandlers(tools, client) {
  if (!client) throw new TypeError('buildAllCodegenHandlers: client is required');
  const handlers = {};
  for (const t of tools) {
    if (!t || !t.name || !t._spec) continue;
    handlers[t.name] = buildCodegenHandler(t._spec, client);
  }
  return handlers;
}

/**
 * Strip the codegen-internal `_spec` field from a tool definition so the
 * payload sent to Anthropic doesn't include it. Anthropic rejects unknown
 * top-level fields on a tool definition; codegen output keeps `_spec`
 * for the dispatcher only.
 */
export function stripSpecForApi(tool) {
  // eslint-disable-next-line no-unused-vars
  const { _spec, tier, ...rest } = tool;
  // tier is also stripped here so the codegen output behaves like the
  // hand-written tools in claude-tools.js (which strip tier in
  // buildToolDefinitions).
  return rest;
}
