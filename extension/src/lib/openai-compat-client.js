// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// OpenAI-compatible Chat Completions client for "Ask Claude" against
// local LLMs (Ollama, LM Studio). FMN-120.
//
// Same surface as claude-client.js (parseSSE, streamOneTurn, runToolLoop)
// so claude-chat-handlers.js can dispatch on provider and re-use the
// surrounding tool-execution loop. Notable differences from the
// Anthropic client:
//   - No prompt caching (cache_control). Local providers don't bill per
//     token and don't honor Anthropic's caching headers.
//   - Tool definitions go on the wire as
//     { type: 'function', function: { name, description, parameters } }
//     instead of Anthropic's flat { name, description, input_schema }.
//   - Tool calls come back as
//     assistant.tool_calls = [{ id, type, function: { name, arguments } }]
//     where `arguments` is a JSON-encoded string the client must parse.
//   - System prompt is prepended as a { role: 'system', content } message
//     instead of a top-level `system` field.
//   - SSE framing uses a single anonymous `data:` channel with sentinel
//     `data: [DONE]` instead of Anthropic's named-event frames.
//
// The runtime tool dispatcher is provider-agnostic: runToolLoop accepts
// the same `runTool(name, input)` callback the Anthropic client uses,
// and the calling code in claude-chat-handlers.js does not need to know
// which provider answered.

export const DEFAULT_MAX_TOKENS = 2048;

export class OpenAICompatError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = 'OpenAICompatError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Convert an Anthropic-shape tool definition to the OpenAI function-tool
 * shape. Drops Anthropic-specific fields (cache_control, tier metadata
 * if present) and accepts either a top-level input_schema or a
 * pre-extracted `parameters` field.
 *
 * @param {object} tool { name, description, input_schema | parameters, ... }
 * @returns {object} { type: 'function', function: { name, description, parameters } }
 */
export function toOpenAIToolShape(tool) {
  if (!tool || typeof tool !== 'object') {
    throw new TypeError('toOpenAIToolShape: tool must be an object');
  }
  if (typeof tool.name !== 'string' || !tool.name) {
    throw new TypeError('toOpenAIToolShape: tool.name is required');
  }
  const parameters = tool.input_schema ?? tool.parameters ?? { type: 'object', properties: {} };
  const fn = {
    name: tool.name,
    parameters
  };
  if (typeof tool.description === 'string' && tool.description) {
    fn.description = tool.description;
  }
  return { type: 'function', function: fn };
}

/**
 * Convert a list of Anthropic-shape tools to OpenAI function tools.
 * Returns [] for null/empty inputs (callers omit the field rather than
 * sending an empty list).
 */
export function toOpenAIToolList(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools.map(toOpenAIToolShape);
}

/**
 * Convert an Anthropic-style messages array (with `tool_use` and
 * `tool_result` content blocks) to the OpenAI chat-completions message
 * shape. The shapes diverge in several ways:
 *
 *   Anthropic assistant turn that calls a tool:
 *     { role: 'assistant', content: [
 *         { type: 'text', text: '...' },
 *         { type: 'tool_use', id, name, input }
 *     ]}
 *
 *   OpenAI assistant turn that calls a tool:
 *     { role: 'assistant', content: '...', tool_calls: [
 *         { id, type: 'function', function: { name, arguments: '<json>' } }
 *     ]}
 *
 *   Anthropic tool result:
 *     { role: 'user', content: [
 *         { type: 'tool_result', tool_use_id, content, is_error }
 *     ]}
 *
 *   OpenAI tool result:
 *     { role: 'tool', tool_call_id, content }
 *
 * Plain string-content messages pass through unchanged.
 *
 * @param {object[]} messages Anthropic-shaped messages
 * @returns {object[]} OpenAI-shaped messages
 */
export function anthropicToOpenAIMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const { role, content } = msg;
    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) {
      out.push({ role, content: '' });
      continue;
    }
    if (role === 'user') {
      const toolResults = content.filter((b) => b?.type === 'tool_result');
      const textParts = content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text);
      // Tool results become individual { role: 'tool' } messages,
      // emitted in order. Free-text user content (rare in tool loops)
      // becomes a separate user message.
      if (textParts.length > 0) {
        out.push({ role: 'user', content: textParts.join('\n') });
      }
      for (const tr of toolResults) {
        const text = typeof tr.content === 'string'
          ? tr.content
          : JSON.stringify(tr.content ?? null);
        out.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: text
        });
      }
      continue;
    }
    if (role === 'assistant') {
      const textParts = content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text);
      const toolUses = content.filter((b) => b?.type === 'tool_use');
      const assistantMsg = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : ''
      };
      if (toolUses.length > 0) {
        assistantMsg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: 'function',
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input ?? {})
          }
        }));
      }
      out.push(assistantMsg);
      continue;
    }
    // System or other roles - flatten to text.
    const textParts = content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text);
    out.push({ role, content: textParts.join('\n') });
  }
  return out;
}

/**
 * SSE parser for OpenAI Chat Completions streaming. Yields the parsed
 * JSON for each `data:` frame, terminating on the `data: [DONE]`
 * sentinel. Multi-line `data:` is concatenated per the SSE spec.
 */
export async function* parseSSE(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) data += line.slice(5).trimStart();
      }
      if (!data) continue;
      if (data === '[DONE]') return;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      yield parsed;
    }
  }
}

/**
 * Stream one chat-completions turn. Accumulates assistant text and any
 * tool_calls fragments, returning a normalized assistant message in
 * Anthropic content-block shape so the surrounding tool-loop can be
 * shared with claude-client.js.
 *
 * Returns:
 *   { role: 'assistant', content: [...content_blocks], stopReason, usage }
 *
 *   stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop'
 *     mapped from OpenAI's finish_reason ('stop'/'length'/'tool_calls'/null).
 */
export async function streamOneTurn({
  url,
  apiKey,
  model,
  systemPrompt,
  tools,
  messages,
  maxTokens = DEFAULT_MAX_TOKENS,
  onDelta,
  signal,
  fetchFn = globalThis.fetch.bind(globalThis)
}) {
  if (!url) throw new OpenAICompatError('OpenAI-compat client: url is required');
  if (!model) throw new OpenAICompatError('OpenAI-compat client: model is required');

  const openaiMessages = anthropicToOpenAIMessages(messages);
  const finalMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...openaiMessages]
    : openaiMessages;

  const body = {
    model,
    messages: finalMessages,
    stream: true,
    max_tokens: maxTokens
  };
  const openaiTools = toOpenAIToolList(tools);
  if (openaiTools.length > 0) {
    body.tools = openaiTools;
    body.tool_choice = 'auto';
  }

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream'
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const endpoint = `${url.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch { try { errBody = await res.text(); } catch {} }
    throw new OpenAICompatError(
      formatHttpError(res.status, errBody, endpoint),
      { status: res.status, body: errBody }
    );
  }

  // Accumulators for the streamed assistant message.
  let textBuffer = '';
  let stopReason = null;
  let usage = null;
  // Tool-call accumulator keyed by `index` per OpenAI's streaming spec.
  // Each entry: { id, name, argsBuffer }
  const toolCalls = new Map();

  for await (const event of parseSSE(res.body)) {
    const choice = event?.choices?.[0];
    if (!choice) {
      if (event?.usage) usage = { ...(usage ?? {}), ...event.usage };
      continue;
    }
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      textBuffer += delta.content;
      onDelta?.({ kind: 'text', text: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        let entry = toolCalls.get(idx);
        if (!entry) {
          entry = { id: tc.id ?? null, name: '', argsBuffer: '' };
          toolCalls.set(idx, entry);
          onDelta?.({ kind: 'tool_call_start', index: idx, id: entry.id });
        }
        if (tc.id && !entry.id) entry.id = tc.id;
        const fn = tc.function ?? {};
        if (typeof fn.name === 'string' && fn.name) entry.name = fn.name;
        if (typeof fn.arguments === 'string' && fn.arguments) {
          entry.argsBuffer += fn.arguments;
          onDelta?.({ kind: 'tool_input_partial', index: idx, partial: fn.arguments });
        }
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason);
    }
    if (event?.usage) usage = { ...(usage ?? {}), ...event.usage };
  }

  const contentBlocks = [];
  if (textBuffer) {
    contentBlocks.push({ type: 'text', text: textBuffer });
  }
  // Emit tool_use blocks in `index` order so handlers see them in the
  // sequence the model emitted.
  const indices = Array.from(toolCalls.keys()).sort((a, b) => a - b);
  for (const idx of indices) {
    const entry = toolCalls.get(idx);
    if (!entry || !entry.name) continue;
    let parsedInput = {};
    try {
      parsedInput = entry.argsBuffer ? JSON.parse(entry.argsBuffer) : {};
    } catch {
      parsedInput = { __raw_arguments: entry.argsBuffer };
    }
    contentBlocks.push({
      type: 'tool_use',
      id: entry.id ?? `call_${idx}`,
      name: entry.name,
      input: parsedInput
    });
  }
  // If finish_reason wasn't surfaced (some local models drop it), infer
  // from accumulated state: any tool_calls means tool_use.
  if (!stopReason) {
    stopReason = toolCalls.size > 0 ? 'tool_use' : 'end_turn';
  }

  onDelta?.({ kind: 'message_stop', usage });

  return {
    role: 'assistant',
    content: contentBlocks,
    stopReason,
    usage
  };
}

/**
 * Build a human-readable error message from an HTTP status + parsed
 * body. Adds a provider-specific hint for the most common gotcha:
 * Ollama returns 403 when the request Origin isn't in OLLAMA_ORIGINS.
 * Browser-extension fetches always include an `Origin: chrome-extension://...`
 * header, so a fresh Ollama install will reject every request from the
 * plugin until the operator restarts Ollama with
 * `OLLAMA_ORIGINS="chrome-extension://*"` (or the specific extension id).
 *
 * The "is this a private/LAN address?" check covers: localhost,
 * 127.x.x.x, 0.0.0.0, RFC1918 ranges (10/8, 172.16/12, 192.168/16),
 * link-local (169.254/16), .local mDNS hostnames, and single-segment
 * hostnames - so a LAN Ollama at 192.168.1.125 still gets the right
 * hint instead of being told to check an API key.
 */
function formatHttpError(status, body, endpoint) {
  const bodySnippet = (() => {
    if (!body) return '';
    if (typeof body === 'string') return body.slice(0, 300);
    try { return JSON.stringify(body).slice(0, 300); } catch { return ''; }
  })();
  let msg = `HTTP ${status} from ${endpoint}`;
  if (bodySnippet) msg += ` - ${bodySnippet}`;
  const isLocal = isPrivateOrLoopbackUrl(endpoint);
  if (status === 403 && isLocal) {
    msg += ' (The extension auto-rewrites Origin to http://localhost for local providers; if a 403 still gets through, the rewrite rule may have failed to register. Fallback: restart Ollama with OLLAMA_ORIGINS="chrome-extension://*" in its environment. Windows: $env:OLLAMA_ORIGINS="chrome-extension://*" then ollama serve - or set it via System Properties -> Environment Variables and restart the Ollama service)';
  } else if ((status === 401 || status === 403) && !isLocal) {
    msg += ' (check API key)';
  }
  return msg;
}

/**
 * True when the URL points at a loopback, RFC1918, link-local, mDNS,
 * or single-segment hostname. Used to decide whether a 403 is more
 * likely a CORS / OLLAMA_ORIGINS issue (private network) versus an
 * authentication issue (public API).
 *
 * Exported for unit tests.
 */
export function isPrivateOrLoopbackUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return false; }
  const host = u.hostname;
  if (!host) return false;
  if (host === 'localhost') return true;
  if (host === '0.0.0.0') return true;
  if (host.endsWith('.local')) return true;
  if (!host.includes('.')) return true; // bare hostname like "ollama-server"
  // IPv4 private ranges.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
  }
  return false;
}

function mapFinishReason(finish) {
  switch (finish) {
    case 'stop': return 'end_turn';
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'function_call': return 'tool_use'; // legacy single-call API
    default: return finish;
  }
}

/**
 * Run a full tool-use loop against an OpenAI-compatible endpoint. Mirrors
 * runToolLoop in claude-client.js so callers can branch on provider and
 * use the same interface.
 *
 * onEvent fires for UI updates with the same event names as the
 * Anthropic loop: turn (deltas), turn_end, tool_call_start,
 * tool_call_result, loop_end.
 */
export async function runToolLoop({
  url,
  apiKey,
  model,
  systemPrompt,
  tools,
  messages,
  maxIterations = 8,
  maxTokens = DEFAULT_MAX_TOKENS,
  runTool,
  onEvent,
  signal,
  fetchFn
}) {
  const workingMessages = messages.slice();

  for (let iter = 0; iter < maxIterations; iter++) {
    const assistant = await streamOneTurn({
      url,
      apiKey,
      model,
      systemPrompt,
      tools,
      messages: workingMessages,
      maxTokens,
      onDelta: (ev) => onEvent?.({ phase: 'turn', iter, ...ev }),
      signal,
      fetchFn
    });

    workingMessages.push({ role: assistant.role, content: assistant.content });
    onEvent?.({ phase: 'turn_end', iter, stopReason: assistant.stopReason });

    if (assistant.stopReason !== 'tool_use') {
      onEvent?.({ phase: 'loop_end', reason: assistant.stopReason, iterations: iter + 1 });
      return { messages: workingMessages, stopReason: assistant.stopReason };
    }

    const toolUseBlocks = assistant.content.filter((b) => b?.type === 'tool_use');
    const toolResults = [];
    for (const tu of toolUseBlocks) {
      onEvent?.({ phase: 'tool_call_start', name: tu.name, id: tu.id, input: tu.input });
      let result;
      let isError = false;
      try {
        result = await runTool(tu.name, tu.input ?? {});
      } catch (err) {
        result = { error: err?.message ?? String(err) };
        isError = true;
      }
      const resultText = typeof result === 'string'
        ? result
        : JSON.stringify(result, null, 2);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: resultText,
        is_error: isError
      });
      onEvent?.({ phase: 'tool_call_result', name: tu.name, id: tu.id, isError, result });
    }
    workingMessages.push({ role: 'user', content: toolResults });
  }

  onEvent?.({ phase: 'loop_end', reason: 'max_iterations', iterations: maxIterations });
  return { messages: workingMessages, stopReason: 'max_iterations' };
}

/**
 * Probe an OpenAI-compatible endpoint to verify reachability and that
 * the configured model exists. Returns
 *   { ok: true, models: [...] } on success
 * Throws OpenAICompatError on transport or auth failure.
 *
 * `expectedModel` is optional; when provided, the function additionally
 * verifies the model appears in the /models response and includes a
 * `modelFound` boolean in the result. Some providers (LM Studio in
 * certain configurations) don't expose /models; treat a 404 there as a
 * non-fatal soft pass.
 */
export async function testConnection({
  url,
  apiKey,
  expectedModel = null,
  fetchFn = globalThis.fetch.bind(globalThis),
  signal
} = {}) {
  if (!url) throw new OpenAICompatError('testConnection: url is required');
  const headers = { 'Accept': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const endpoint = `${url.replace(/\/+$/, '')}/models`;
  let res;
  try {
    res = await fetchFn(endpoint, { method: 'GET', headers, signal });
  } catch (err) {
    throw new OpenAICompatError(
      `Cannot reach ${endpoint}: ${err?.message ?? String(err)}`,
      { status: null, body: null }
    );
  }
  if (res.status === 404) {
    return { ok: true, models: null, modelFound: null, soft: true };
  }
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch { try { body = await res.text(); } catch {} }
    throw new OpenAICompatError(
      formatHttpError(res.status, body, endpoint),
      { status: res.status, body }
    );
  }
  let parsed = null;
  try { parsed = await res.json(); } catch {
    throw new OpenAICompatError(`${endpoint} did not return JSON`, { status: res.status });
  }
  const models = Array.isArray(parsed?.data) ? parsed.data : [];
  const ids = models.map((m) => m?.id).filter(Boolean);
  const modelFound = expectedModel ? ids.includes(expectedModel) : null;
  return { ok: true, models: ids, modelFound, soft: false };
}
