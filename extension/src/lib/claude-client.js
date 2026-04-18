// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Anthropic Messages API client for the "Ask Claude" prototype (FMN-53).
//
// Lives in the service worker. Streams via fetch + ReadableStream (SSE parser),
// drives a tool-use loop against a user-supplied Claude API key. Tool schemas
// and handlers are passed in — see claude-tools.js for the FortiMonitor tool
// subset this prototype ships with.
//
// Scope: prototype. No retries, no rate-limit backoff beyond what the Messages
// API itself provides. If this tool graduates from prototype to shipped, the
// error handling should be hardened.
//
// Prompt caching: the tools block is marked ephemeral so repeat turns reuse
// the cached tool definitions (5-min TTL). This is mandatory with ~10+ tool
// schemas; without it every turn re-sends the full tool catalog.

export const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const API_VERSION = '2023-06-01';

export class ClaudeError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = 'ClaudeError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Minimal SSE parser for the Anthropic streaming response.
 * Yields { event, data } objects. `data` is parsed JSON when possible.
 */
export async function* parseSSE(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = null;
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!event) continue;
      let parsed = data;
      try { parsed = JSON.parse(data); } catch { /* keep raw string */ }
      yield { event, data: parsed };
    }
  }
}

/**
 * Stream a single turn of a Messages request. Accumulates content blocks
 * in order and emits incremental deltas via onDelta.
 *
 * Returns the final assistant message: { role: 'assistant', content: [...], stop_reason }.
 */
export async function streamOneTurn({
  apiKey,
  model,
  system,
  tools,
  messages,
  maxTokens = 2048,
  onDelta,
  signal,
  fetchFn = globalThis.fetch.bind(globalThis)
}) {
  if (!apiKey) throw new ClaudeError('No Claude API key configured');
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages
  };
  if (system) body.system = system;
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;

  const res = await fetchFn(`${ANTHROPIC_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch { try { errBody = await res.text(); } catch {} }
    throw new ClaudeError(
      `Anthropic API error: HTTP ${res.status}`,
      { status: res.status, body: errBody }
    );
  }

  const contentBlocks = [];
  let stopReason = null;
  let usage = null;

  for await (const frame of parseSSE(res.body)) {
    const { event, data } = frame;
    if (event === 'message_start') {
      usage = data?.message?.usage ?? null;
    } else if (event === 'content_block_start') {
      const i = data.index;
      contentBlocks[i] = { ...data.content_block };
      if (contentBlocks[i].type === 'text') contentBlocks[i].text = contentBlocks[i].text ?? '';
      if (contentBlocks[i].type === 'tool_use') contentBlocks[i]._inputJson = '';
      onDelta?.({ kind: 'block_start', index: i, block: contentBlocks[i] });
    } else if (event === 'content_block_delta') {
      const i = data.index;
      const d = data.delta;
      if (!contentBlocks[i]) continue;
      if (d.type === 'text_delta') {
        contentBlocks[i].text = (contentBlocks[i].text ?? '') + d.text;
        onDelta?.({ kind: 'text', index: i, text: d.text });
      } else if (d.type === 'input_json_delta') {
        contentBlocks[i]._inputJson += d.partial_json;
        onDelta?.({ kind: 'tool_input_partial', index: i, partial: d.partial_json });
      }
    } else if (event === 'content_block_stop') {
      const i = data.index;
      const b = contentBlocks[i];
      if (b && b.type === 'tool_use' && b._inputJson !== undefined) {
        try { b.input = JSON.parse(b._inputJson || '{}'); } catch { b.input = {}; }
        delete b._inputJson;
      }
      onDelta?.({ kind: 'block_stop', index: i, block: contentBlocks[i] });
    } else if (event === 'message_delta') {
      if (data?.delta?.stop_reason) stopReason = data.delta.stop_reason;
      if (data?.usage) usage = { ...(usage ?? {}), ...data.usage };
    } else if (event === 'message_stop') {
      onDelta?.({ kind: 'message_stop', usage });
    } else if (event === 'error') {
      throw new ClaudeError(
        `Stream error: ${data?.error?.message ?? 'unknown'}`,
        { body: data }
      );
    }
  }

  return {
    role: 'assistant',
    content: contentBlocks.filter(Boolean),
    stopReason,
    usage
  };
}

/**
 * Run a full tool-use loop. Sends messages, executes any tool_use blocks
 * via `runTool`, appends tool_result, loops until end_turn or max iterations.
 *
 * `tools` is the Anthropic tool-definition array. The last entry gets a
 * cache_control marker so the whole tools block is cached (ephemeral,
 * 5-min TTL).
 *
 * onEvent fires for UI updates: block_start, text, block_stop, tool_call_start,
 * tool_call_result, turn_end, loop_end.
 */
export async function runToolLoop({
  apiKey,
  model = DEFAULT_MODEL,
  system,
  tools,
  messages,
  maxIterations = 8,
  maxTokens = 2048,
  runTool,
  onEvent,
  signal,
  fetchFn
}) {
  const workingMessages = messages.slice();
  const cachedTools = withToolCache(tools);

  for (let iter = 0; iter < maxIterations; iter++) {
    const assistant = await streamOneTurn({
      apiKey,
      model,
      system,
      tools: cachedTools,
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
 * Mark the last tool definition as ephemeral-cached so the whole tools
 * block is reused across turns. Mutates a shallow copy — the original
 * array is untouched.
 */
export function withToolCache(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  const out = tools.map((t) => ({ ...t }));
  const last = out[out.length - 1];
  last.cache_control = { type: 'ephemeral' };
  return out;
}
