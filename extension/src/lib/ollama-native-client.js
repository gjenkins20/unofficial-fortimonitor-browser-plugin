// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-120: Ollama-native /api/chat client for Ask AI.
//
// Why this exists when openai-compat-client.js already targets Ollama:
// Ollama's /v1/chat/completions endpoint is a thin OpenAI-compat shim
// that silently drops the `options` field. That field is the only way
// to set num_ctx, temperature, top_p, etc. per-request - and num_ctx
// in particular is critical because Ollama's default 4096 truncates
// the system prompt on tool-result-heavy turns. Pre-warming via
// /api/generate doesn't transfer (separate model sessions).
//
// /api/chat IS Ollama-native and DOES honor options.num_ctx. Different
// streaming format (NDJSON), slightly different tool-call shape (no
// id wrapper, just function: {name, arguments}). This client wraps
// those differences and exposes the same runToolLoop / streamOneTurn
// surface the OpenAI-compat client does, so claude-chat-handlers.js
// can branch on provider with minimal code change.
//
// LM Studio still uses /v1/chat/completions (it doesn't have /api/chat).

import { anthropicToOpenAIMessages, toOpenAIToolList } from './openai-compat-client.js';

export const DEFAULT_MAX_TOKENS = 2048;

export class OllamaError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = 'OllamaError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Convert /v1-style URL (e.g. http://localhost:11434/v1) to Ollama
 * native base (http://localhost:11434). Ollama serves both at the
 * same root; we just strip the /v1.
 */
function toNativeBase(url) {
  return String(url || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

/**
 * Stream one chat turn against /api/chat. Returns a normalized
 * assistant message in Anthropic content-block shape so the
 * surrounding tool-loop can be shared with the OpenAI-compat path.
 *
 * Returns:
 *   { role: 'assistant', content: [...content_blocks], stopReason, usage }
 */
export async function streamOneTurn({
  url,
  apiKey,
  model,
  systemPrompt,
  tools,
  messages,
  maxTokens = DEFAULT_MAX_TOKENS,
  options,
  onDelta,
  signal,
  fetchFn = globalThis.fetch.bind(globalThis)
}) {
  if (!url) throw new OllamaError('ollama-native client: url is required');
  if (!model) throw new OllamaError('ollama-native client: model is required');

  // Ollama /api/chat takes OpenAI-shaped messages but we still need
  // to flatten Anthropic tool_use/tool_result content blocks. Reuse
  // the OpenAI-compat converter; the message shape is the same up to
  // the tool-call format.
  const openaiMessages = anthropicToOpenAIMessages(messages);
  const finalMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...openaiMessages]
    : openaiMessages;

  // Ollama /api/chat accepts the OpenAI tool shape directly:
  // { type: 'function', function: { name, description, parameters } }
  const ollamaTools = toOpenAIToolList(tools);

  const body = {
    model,
    messages: finalMessages,
    stream: true
  };
  if (ollamaTools.length > 0) {
    body.tools = ollamaTools;
  }
  // Per-request runtime options. num_ctx is the dominant one; Ollama's
  // /api/chat applies it and may reload the model with the new context
  // size if it differs from the loaded instance. Bake max_tokens in
  // here as num_predict (Ollama's name for it).
  const runtimeOptions = { ...(options || {}) };
  if (typeof maxTokens === 'number' && !('num_predict' in runtimeOptions)) {
    runtimeOptions.num_predict = maxTokens;
  }
  if (Object.keys(runtimeOptions).length > 0) {
    body.options = runtimeOptions;
  }
  // Hold the model in memory between scenarios so the matrix doesn't
  // pay cold-load latency on every chat turn.
  body.keep_alive = '10m';

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const endpoint = `${toNativeBase(url)}/api/chat`;
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch { try { errBody = await res.text(); } catch {} }
    throw new OllamaError(
      `ollama /api/chat: HTTP ${res.status}${errBody ? ` - ${typeof errBody === 'string' ? errBody.slice(0, 300) : JSON.stringify(errBody).slice(0, 300)}` : ''}`,
      { status: res.status, body: errBody }
    );
  }

  // Accumulate the streamed response.
  let textBuffer = '';
  let stopReason = null;
  let usage = null;
  // Tool calls in Ollama come as full objects (no fragmenting), one
  // per chunk. Collect them in order.
  const toolCalls = [];

  for await (const obj of parseNDJSON(res.body)) {
    if (obj?.message?.content) {
      const chunk = String(obj.message.content);
      if (chunk) {
        textBuffer += chunk;
        onDelta?.({ kind: 'text', text: chunk });
      }
    }
    if (Array.isArray(obj?.message?.tool_calls)) {
      for (const tc of obj.message.tool_calls) {
        if (!tc?.function?.name) continue;
        const id = tc.id ?? `call_${toolCalls.length}_${Date.now()}`;
        toolCalls.push({
          id,
          name: tc.function.name,
          input: typeof tc.function.arguments === 'object'
            ? tc.function.arguments
            : safeParseJson(tc.function.arguments) ?? {}
        });
        onDelta?.({ kind: 'tool_call_start', index: toolCalls.length - 1, id });
      }
    }
    if (obj?.done === true) {
      // Ollama's done_reason is "stop" / "load" / "length" / similar.
      const reason = obj.done_reason ?? 'stop';
      stopReason = mapDoneReason(reason, toolCalls.length > 0);
      usage = {
        prompt_tokens: obj.prompt_eval_count ?? null,
        completion_tokens: obj.eval_count ?? null,
        total_duration: obj.total_duration ?? null,
        load_duration: obj.load_duration ?? null,
        eval_duration: obj.eval_duration ?? null
      };
    }
  }

  if (!stopReason) {
    stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
  }

  const contentBlocks = [];
  if (textBuffer) contentBlocks.push({ type: 'text', text: textBuffer });
  for (const tc of toolCalls) {
    contentBlocks.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: tc.input
    });
  }

  onDelta?.({ kind: 'message_stop', usage });

  return {
    role: 'assistant',
    content: contentBlocks,
    stopReason,
    usage
  };
}

function mapDoneReason(reason, hasToolCalls) {
  if (hasToolCalls) return 'tool_use';
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'load': return 'end_turn'; // model load completion, treat as turn end
    default: return reason;
  }
}

/**
 * NDJSON parser. Each frame is a single JSON object on its own line.
 * Ollama emits one per token-chunk during streaming; the final object
 * has done=true.
 */
async function* parseNDJSON(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch { /* skip malformed */ }
    }
  }
  // Final partial line, if any.
  if (buffer.trim()) {
    try { yield JSON.parse(buffer); } catch {}
  }
}

function safeParseJson(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Run a full tool-use loop against /api/chat. Mirrors runToolLoop in
 * openai-compat-client.js so claude-chat-handlers.js can branch on
 * provider with minimal change.
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
  options,
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
      options,
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
