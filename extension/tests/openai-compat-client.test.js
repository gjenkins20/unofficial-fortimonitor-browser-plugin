// FMN-120: unit tests for the OpenAI-compatible client used to drive
// Ask Claude against local Ollama / LM Studio servers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSSE,
  toOpenAIToolShape,
  toOpenAIToolList,
  anthropicToOpenAIMessages,
  streamOneTurn,
  runToolLoop,
  testConnection,
  OpenAICompatError
} from '../src/lib/openai-compat-client.js';

function streamFrom(chunks) {
  // Build a ReadableStream that emits each entry of `chunks` as a Uint8Array.
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    }
  });
}

function fakeResponse({ ok = true, status = 200, bodyChunks = null, jsonBody = null }) {
  return {
    ok,
    status,
    body: bodyChunks ? streamFrom(bodyChunks) : null,
    async json() { return jsonBody; },
    async text() { return jsonBody == null ? '' : JSON.stringify(jsonBody); }
  };
}

// ---------- parseSSE ----------

test('parseSSE yields parsed JSON frames and stops on [DONE]', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  const events = [];
  for await (const ev of parseSSE(streamFrom(chunks))) events.push(ev);
  assert.equal(events.length, 2);
  assert.equal(events[0].choices[0].delta.content, 'hi');
  assert.equal(events[1].choices[0].delta.content, ' there');
});

test('parseSSE handles a frame split across reads', async () => {
  // Cut the first frame in half so the parser must buffer.
  const chunks = [
    'data: {"choices":[{"de',
    'lta":{"content":"hello"}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  const events = [];
  for await (const ev of parseSSE(streamFrom(chunks))) events.push(ev);
  assert.equal(events.length, 1);
  assert.equal(events[0].choices[0].delta.content, 'hello');
});

test('parseSSE skips frames without a data: line', async () => {
  const chunks = [
    ': keepalive\n\n',
    'data: {"choices":[]}\n\n',
    'data: [DONE]\n\n'
  ];
  const events = [];
  for await (const ev of parseSSE(streamFrom(chunks))) events.push(ev);
  assert.equal(events.length, 1);
});

// ---------- toOpenAIToolShape ----------

test('toOpenAIToolShape rewrites Anthropic shape to OpenAI function-tool shape', () => {
  const anthropic = {
    name: 'list_servers',
    description: 'List FortiMonitor servers',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer' } },
      required: []
    }
  };
  const out = toOpenAIToolShape(anthropic);
  assert.equal(out.type, 'function');
  assert.equal(out.function.name, 'list_servers');
  assert.equal(out.function.description, 'List FortiMonitor servers');
  assert.deepEqual(out.function.parameters, anthropic.input_schema);
});

test('toOpenAIToolShape omits description when missing', () => {
  const out = toOpenAIToolShape({ name: 'noop', input_schema: { type: 'object', properties: {} } });
  assert.equal(out.function.description, undefined);
});

test('toOpenAIToolShape provides a default parameters object when none supplied', () => {
  const out = toOpenAIToolShape({ name: 'noop' });
  assert.deepEqual(out.function.parameters, { type: 'object', properties: {} });
});

test('toOpenAIToolShape accepts pre-extracted parameters field', () => {
  const params = { type: 'object', properties: { x: { type: 'number' } } };
  const out = toOpenAIToolShape({ name: 'foo', parameters: params });
  assert.deepEqual(out.function.parameters, params);
});

test('toOpenAIToolShape throws for missing name', () => {
  assert.throws(() => toOpenAIToolShape({ description: 'no name' }), /name is required/);
});

test('toOpenAIToolList returns an empty array for nullish/empty input', () => {
  assert.deepEqual(toOpenAIToolList(null), []);
  assert.deepEqual(toOpenAIToolList(undefined), []);
  assert.deepEqual(toOpenAIToolList([]), []);
});

test('toOpenAIToolList maps every tool', () => {
  const tools = [
    { name: 'a', description: 'A' },
    { name: 'b', description: 'B' }
  ];
  const out = toOpenAIToolList(tools);
  assert.equal(out.length, 2);
  assert.equal(out[0].function.name, 'a');
  assert.equal(out[1].function.name, 'b');
});

// ---------- anthropicToOpenAIMessages ----------

test('anthropicToOpenAIMessages preserves string-content messages', () => {
  const out = anthropicToOpenAIMessages([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' }
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' }
  ]);
});

test('anthropicToOpenAIMessages converts assistant tool_use to tool_calls', () => {
  const out = anthropicToOpenAIMessages([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking up.' },
        { type: 'tool_use', id: 'call_1', name: 'search_servers', input: { name: 'fgt' } }
      ]
    }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'Looking up.');
  assert.equal(out[0].tool_calls.length, 1);
  assert.equal(out[0].tool_calls[0].id, 'call_1');
  assert.equal(out[0].tool_calls[0].type, 'function');
  assert.equal(out[0].tool_calls[0].function.name, 'search_servers');
  assert.equal(out[0].tool_calls[0].function.arguments, JSON.stringify({ name: 'fgt' }));
});

test('anthropicToOpenAIMessages converts tool_result to tool-role messages', () => {
  const out = anthropicToOpenAIMessages([
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '{"id":1}' },
        { type: 'tool_result', tool_use_id: 'call_2', content: '{"id":2}', is_error: true }
      ]
    }
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'tool');
  assert.equal(out[0].tool_call_id, 'call_1');
  assert.equal(out[0].content, '{"id":1}');
  assert.equal(out[1].role, 'tool');
  assert.equal(out[1].tool_call_id, 'call_2');
});

test('anthropicToOpenAIMessages emits user text + tool results in order', () => {
  const out = anthropicToOpenAIMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'follow up' },
        { type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }
      ]
    }
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, 'follow up');
  assert.equal(out[1].role, 'tool');
});

// ---------- streamOneTurn ----------

test('streamOneTurn assembles streamed text and finish_reason=stop', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  let captured;
  const fetchFn = async (url, init) => {
    captured = { url, init };
    return fakeResponse({ bodyChunks: chunks });
  };
  const result = await streamOneTurn({
    url: 'http://localhost:11434/v1',
    apiKey: 'sk-test',
    model: 'qwen2.5',
    systemPrompt: 'be brief',
    tools: [{ name: 'noop', description: 'd', input_schema: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'hi' }],
    fetchFn
  });
  assert.equal(result.role, 'assistant');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, 'hello world');

  // Verify wire details.
  assert.equal(captured.url, 'http://localhost:11434/v1/chat/completions');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'qwen2.5');
  assert.equal(body.stream, true);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'be brief');
  assert.equal(body.messages[1].role, 'user');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-test');
});

test('streamOneTurn omits Authorization header when no apiKey is provided', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  let captured;
  const fetchFn = async (url, init) => { captured = init; return fakeResponse({ bodyChunks: chunks }); };
  await streamOneTurn({
    url: 'http://localhost:11434/v1',
    model: 'qwen2.5',
    messages: [{ role: 'user', content: 'hi' }],
    fetchFn
  });
  assert.equal(captured.headers.Authorization, undefined);
});

test('streamOneTurn accumulates fragmented tool_call arguments and parses input', async () => {
  // Streaming spec: function.arguments arrives as a sequence of string
  // deltas that the client must concatenate before JSON.parse.
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"search_servers","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"name\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"fgt\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  const fetchFn = async () => fakeResponse({ bodyChunks: chunks });
  const result = await streamOneTurn({
    url: 'http://localhost:1234/v1',
    model: 'foo',
    messages: [{ role: 'user', content: 'find fgt' }],
    fetchFn
  });
  assert.equal(result.stopReason, 'tool_use');
  const toolUse = result.content.find((b) => b.type === 'tool_use');
  assert.ok(toolUse, 'tool_use block emitted');
  assert.equal(toolUse.id, 'call_x');
  assert.equal(toolUse.name, 'search_servers');
  assert.deepEqual(toolUse.input, { name: 'fgt' });
});

test('streamOneTurn infers tool_use when finish_reason is missing but tool_calls exist', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"foo","arguments":"{}"}}]}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  const fetchFn = async () => fakeResponse({ bodyChunks: chunks });
  const result = await streamOneTurn({
    url: 'http://localhost:11434/v1',
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    fetchFn
  });
  assert.equal(result.stopReason, 'tool_use');
});

test('streamOneTurn maps finish_reason=length to max_tokens', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"truncated"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"length","delta":{}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  const fetchFn = async () => fakeResponse({ bodyChunks: chunks });
  const result = await streamOneTurn({
    url: 'http://x/v1', model: 'm',
    messages: [{ role: 'user', content: 'x' }], fetchFn
  });
  assert.equal(result.stopReason, 'max_tokens');
});

test('streamOneTurn throws OpenAICompatError on non-2xx response', async () => {
  const fetchFn = async () => fakeResponse({ ok: false, status: 503, jsonBody: { error: 'down' } });
  await assert.rejects(
    streamOneTurn({ url: 'http://x/v1', model: 'm', messages: [{ role: 'user', content: 'x' }], fetchFn }),
    OpenAICompatError
  );
});

test('streamOneTurn 403 against localhost includes an OLLAMA_ORIGINS hint', async () => {
  const fetchFn = async () => fakeResponse({ ok: false, status: 403, jsonBody: { error: 'forbidden' } });
  let caught;
  try {
    await streamOneTurn({
      url: 'http://localhost:11434/v1',
      model: 'qwen2.5',
      messages: [{ role: 'user', content: 'x' }],
      fetchFn
    });
  } catch (err) { caught = err; }
  assert.ok(caught instanceof OpenAICompatError);
  assert.equal(caught.status, 403);
  assert.match(caught.message, /OLLAMA_ORIGINS/);
  assert.match(caught.message, /chrome-extension/);
});

test('streamOneTurn 401 against a remote URL hints at API key, not OLLAMA_ORIGINS', async () => {
  const fetchFn = async () => fakeResponse({ ok: false, status: 401, jsonBody: { error: 'no key' } });
  let caught;
  try {
    await streamOneTurn({
      url: 'https://api.example.com/v1',
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      fetchFn
    });
  } catch (err) { caught = err; }
  assert.ok(caught instanceof OpenAICompatError);
  assert.match(caught.message, /check API key/);
  assert.doesNotMatch(caught.message, /OLLAMA_ORIGINS/);
});

test('streamOneTurn error message includes a body snippet when present', async () => {
  const fetchFn = async () => fakeResponse({ ok: false, status: 500, jsonBody: { error: 'internal explosion' } });
  let caught;
  try {
    await streamOneTurn({
      url: 'http://x/v1', model: 'm',
      messages: [{ role: 'user', content: 'x' }], fetchFn
    });
  } catch (err) { caught = err; }
  assert.match(caught.message, /internal explosion/);
});

test('streamOneTurn requires url and model', async () => {
  await assert.rejects(
    streamOneTurn({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    /url is required/
  );
  await assert.rejects(
    streamOneTurn({ url: 'http://x/v1', messages: [{ role: 'user', content: 'x' }] }),
    /model is required/
  );
});

// ---------- runToolLoop ----------

test('runToolLoop dispatches tool calls and forwards results back to the model', async () => {
  // Turn 1: model emits a tool_use for search_servers.
  // Turn 2: model returns plain text and stop.
  const turn1 = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"search_servers","arguments":"{\\"name\\":\\"fgt\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  const turn2 = [
    'data: {"choices":[{"delta":{"content":"Found 1 server"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  let callIdx = 0;
  const fetchFn = async () => {
    const chunks = callIdx === 0 ? turn1 : turn2;
    callIdx++;
    return fakeResponse({ bodyChunks: chunks });
  };
  const calls = [];
  const events = [];
  const result = await runToolLoop({
    url: 'http://localhost:11434/v1',
    model: 'qwen2.5',
    systemPrompt: 'be brief',
    tools: [{ name: 'search_servers', description: 'find', input_schema: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'find fgt' }],
    runTool: async (name, input) => {
      calls.push({ name, input });
      return { matches: [{ id: 1, name: 'fgt-1' }] };
    },
    onEvent: (ev) => events.push(ev),
    fetchFn
  });
  assert.equal(callIdx, 2, 'two HTTP calls (tool turn + final turn)');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'search_servers');
  assert.deepEqual(calls[0].input, { name: 'fgt' });
  assert.equal(result.stopReason, 'end_turn');
  // Verify a tool_call_result event was emitted.
  assert.ok(events.some((e) => e.phase === 'tool_call_result'));
  assert.ok(events.some((e) => e.phase === 'loop_end' && e.reason === 'end_turn'));
});

test('runToolLoop returns max_iterations when the model never stops', async () => {
  // Model always emits a tool_use; loop should bail after maxIterations.
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"noop","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  const fetchFn = async () => fakeResponse({ bodyChunks: chunks });
  const result = await runToolLoop({
    url: 'http://x/v1',
    model: 'm',
    tools: [{ name: 'noop', description: 'd', input_schema: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'go' }],
    maxIterations: 2,
    runTool: async () => ({ ok: true }),
    fetchFn
  });
  assert.equal(result.stopReason, 'max_iterations');
});

// ---------- testConnection ----------

test('testConnection returns modelFound=true when the model appears in /models', async () => {
  const fetchFn = async (url) => {
    assert.equal(url, 'http://localhost:11434/v1/models');
    return {
      ok: true, status: 200,
      async json() { return { data: [{ id: 'qwen2.5' }, { id: 'llama3.1' }] }; },
      async text() { return ''; }
    };
  };
  const r = await testConnection({ url: 'http://localhost:11434/v1', expectedModel: 'qwen2.5', fetchFn });
  assert.equal(r.ok, true);
  assert.equal(r.modelFound, true);
  assert.deepEqual(r.models, ['qwen2.5', 'llama3.1']);
});

test('testConnection returns modelFound=false when the model is missing', async () => {
  const fetchFn = async () => ({
    ok: true, status: 200,
    async json() { return { data: [{ id: 'llama3.1' }] }; },
    async text() { return ''; }
  });
  const r = await testConnection({ url: 'http://localhost:11434/v1', expectedModel: 'qwen2.5', fetchFn });
  assert.equal(r.modelFound, false);
});

test('testConnection treats 404 on /models as a soft pass (server reachable, no catalog)', async () => {
  const fetchFn = async () => ({ ok: false, status: 404, async json() { return null; }, async text() { return ''; } });
  const r = await testConnection({ url: 'http://localhost:1234/v1', expectedModel: 'm', fetchFn });
  assert.equal(r.ok, true);
  assert.equal(r.soft, true);
});

test('testConnection sends Authorization header when apiKey is present', async () => {
  let captured;
  const fetchFn = async (url, init) => {
    captured = init;
    return { ok: true, status: 200, async json() { return { data: [] }; }, async text() { return ''; } };
  };
  await testConnection({ url: 'http://x/v1', apiKey: 'sk-foo', fetchFn });
  assert.equal(captured.headers.Authorization, 'Bearer sk-foo');
});

test('testConnection wraps transport failures in OpenAICompatError', async () => {
  const fetchFn = async () => { throw new Error('connect ECONNREFUSED'); };
  await assert.rejects(
    testConnection({ url: 'http://localhost:99999/v1', fetchFn }),
    OpenAICompatError
  );
});
