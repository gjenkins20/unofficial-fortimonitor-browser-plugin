// FMN-120: tests for the Ollama-native /api/chat client. The
// OpenAI-compat shim drops options.num_ctx silently; this client uses
// /api/chat which honors it. Tests cover NDJSON parsing, tool-call
// shape conversion, options passthrough, and endpoint URL handling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  streamOneTurn,
  runToolLoop,
  anthropicToOllamaMessages,
  OllamaError
} from '../src/lib/ollama-native-client.js';

function streamFrom(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    }
  });
}

function fakeResponse({ ok = true, status = 200, bodyChunks = null, jsonBody = null }) {
  return {
    ok, status,
    body: bodyChunks ? streamFrom(bodyChunks) : null,
    async json() { return jsonBody; },
    async text() { return jsonBody == null ? '' : JSON.stringify(jsonBody); }
  };
}

test('streamOneTurn assembles content from NDJSON chunks and finishes on done=true', async () => {
  const chunks = [
    JSON.stringify({ message: { content: 'hello ' }, done: false }) + '\n',
    JSON.stringify({ message: { content: 'world' }, done: false }) + '\n',
    JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 50, eval_count: 12 }) + '\n'
  ];
  let captured;
  const fetchFn = async (url, init) => { captured = { url, init }; return fakeResponse({ bodyChunks: chunks }); };
  const result = await streamOneTurn({
    url: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    messages: [{ role: 'user', content: 'hi' }],
    fetchFn
  });
  assert.equal(result.role, 'assistant');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, 'hello world');
  assert.equal(result.usage.prompt_tokens, 50);
  assert.equal(result.usage.completion_tokens, 12);
  // Endpoint stripped /v1 -> /api/chat.
  assert.equal(captured.url, 'http://localhost:11434/api/chat');
});

test('streamOneTurn forwards options.num_ctx in request body', async () => {
  const chunks = [JSON.stringify({ done: true, done_reason: 'stop' }) + '\n'];
  let captured;
  const fetchFn = async (url, init) => { captured = init; return fakeResponse({ bodyChunks: chunks }); };
  await streamOneTurn({
    url: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    options: { num_ctx: 16384 },
    messages: [{ role: 'user', content: 'hi' }],
    fetchFn
  });
  const body = JSON.parse(captured.body);
  assert.equal(body.options.num_ctx, 16384);
  assert.equal(body.keep_alive, '10m');
});

test('streamOneTurn folds maxTokens into options.num_predict if not present', async () => {
  const chunks = [JSON.stringify({ done: true, done_reason: 'stop' }) + '\n'];
  let captured;
  const fetchFn = async (url, init) => { captured = init; return fakeResponse({ bodyChunks: chunks }); };
  await streamOneTurn({
    url: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    maxTokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    fetchFn
  });
  const body = JSON.parse(captured.body);
  assert.equal(body.options.num_predict, 1024);
});

test('streamOneTurn captures Ollama tool_calls into Anthropic-shape tool_use blocks', async () => {
  const chunks = [
    JSON.stringify({
      message: {
        content: '',
        tool_calls: [{ function: { name: 'list_active_outages', arguments: {} } }]
      },
      done: false
    }) + '\n',
    JSON.stringify({ done: true, done_reason: 'stop' }) + '\n'
  ];
  const fetchFn = async () => fakeResponse({ bodyChunks: chunks });
  const result = await streamOneTurn({
    url: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    messages: [{ role: 'user', content: 'what outages?' }],
    fetchFn
  });
  assert.equal(result.stopReason, 'tool_use');
  const toolUse = result.content.find((b) => b.type === 'tool_use');
  assert.ok(toolUse);
  assert.equal(toolUse.name, 'list_active_outages');
  assert.deepEqual(toolUse.input, {});
  assert.ok(typeof toolUse.id === 'string' && toolUse.id.length > 0);
});

test('streamOneTurn parses string tool-call arguments via JSON.parse', async () => {
  // Some models emit arguments as a JSON-encoded string instead of an object.
  const chunks = [
    JSON.stringify({
      message: {
        tool_calls: [{ function: { name: 'search_servers', arguments: '{"name":"fgt"}' } }]
      },
      done: false
    }) + '\n',
    JSON.stringify({ done: true, done_reason: 'stop' }) + '\n'
  ];
  const fetchFn = async () => fakeResponse({ bodyChunks: chunks });
  const result = await streamOneTurn({
    url: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    messages: [{ role: 'user', content: 'find fgt' }],
    fetchFn
  });
  const toolUse = result.content.find((b) => b.type === 'tool_use');
  assert.deepEqual(toolUse.input, { name: 'fgt' });
});

test('streamOneTurn maps done_reason=length to max_tokens', async () => {
  const chunks = [
    JSON.stringify({ message: { content: 'truncated' }, done: false }) + '\n',
    JSON.stringify({ done: true, done_reason: 'length' }) + '\n'
  ];
  const fetchFn = async () => fakeResponse({ bodyChunks: chunks });
  const result = await streamOneTurn({
    url: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    messages: [{ role: 'user', content: 'x' }],
    fetchFn
  });
  assert.equal(result.stopReason, 'max_tokens');
});

test('streamOneTurn throws OllamaError on non-2xx', async () => {
  const fetchFn = async () => fakeResponse({ ok: false, status: 500, jsonBody: { error: 'boom' } });
  await assert.rejects(
    streamOneTurn({
      url: 'http://localhost:11434/v1',
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'x' }],
      fetchFn
    }),
    OllamaError
  );
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

test('streamOneTurn handles bare URL without /v1 suffix', async () => {
  const chunks = [JSON.stringify({ done: true, done_reason: 'stop' }) + '\n'];
  let captured;
  const fetchFn = async (url) => { captured = url; return fakeResponse({ bodyChunks: chunks }); };
  await streamOneTurn({
    url: 'http://localhost:11434',
    model: 'qwen3:8b',
    messages: [{ role: 'user', content: 'x' }],
    fetchFn
  });
  assert.equal(captured, 'http://localhost:11434/api/chat');
});

// ---------- anthropicToOllamaMessages ----------

test('anthropicToOllamaMessages drops id and type from tool_calls (Ollama-native shape)', () => {
  const out = anthropicToOllamaMessages([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'looking up' },
        { type: 'tool_use', id: 'call_1', name: 'list_active_outages', input: { limit: 25 } }
      ]
    }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'looking up');
  assert.equal(out[0].tool_calls.length, 1);
  // No id, no type; just function: { name, arguments }
  assert.ok(!('id' in out[0].tool_calls[0]));
  assert.ok(!('type' in out[0].tool_calls[0]));
  assert.equal(out[0].tool_calls[0].function.name, 'list_active_outages');
  // arguments is an OBJECT, not a JSON-encoded string
  assert.deepEqual(out[0].tool_calls[0].function.arguments, { limit: 25 });
});

test('anthropicToOllamaMessages converts tool_result to {role:tool, content} without tool_call_id', () => {
  const out = anthropicToOllamaMessages([
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '{"count":17}' }
      ]
    }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'tool');
  assert.equal(out[0].content, '{"count":17}');
  // Ollama doesn't expect tool_call_id and rejects unknown fields in
  // some configurations.
  assert.ok(!('tool_call_id' in out[0]));
});

test('anthropicToOllamaMessages preserves string-content messages', () => {
  const out = anthropicToOllamaMessages([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' }
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' }
  ]);
});

test('anthropicToOllamaMessages emits user text + tool results in order', () => {
  const out = anthropicToOllamaMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'follow up' },
        { type: 'tool_result', tool_use_id: 'c', content: 'ok' }
      ]
    }
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, 'follow up');
  assert.equal(out[1].role, 'tool');
  assert.equal(out[1].content, 'ok');
});

test('runToolLoop dispatches tool calls and returns final assistant text', async () => {
  // Turn 1: emits a tool_use.
  const turn1 = [
    JSON.stringify({
      message: {
        tool_calls: [{ function: { name: 'list_active_outages', arguments: {} } }]
      },
      done: false
    }) + '\n',
    JSON.stringify({ done: true, done_reason: 'stop' }) + '\n'
  ];
  // Turn 2: emits text and stops.
  const turn2 = [
    JSON.stringify({ message: { content: 'There are 17 outages.' }, done: false }) + '\n',
    JSON.stringify({ done: true, done_reason: 'stop' }) + '\n'
  ];
  let callIdx = 0;
  const fetchFn = async () => {
    const chunks = callIdx === 0 ? turn1 : turn2;
    callIdx++;
    return fakeResponse({ bodyChunks: chunks });
  };
  const calls = [];
  const result = await runToolLoop({
    url: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    tools: [{ name: 'list_active_outages', description: 'd', input_schema: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'what outages?' }],
    runTool: async (name, input) => {
      calls.push({ name, input });
      return { count: 17 };
    },
    fetchFn
  });
  assert.equal(callIdx, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'list_active_outages');
  assert.equal(result.stopReason, 'end_turn');
  // Final assistant message should contain the text turn-2 emitted.
  const lastAsst = result.messages.filter((m) => m.role === 'assistant').pop();
  const textBlock = lastAsst.content.find((b) => b.type === 'text');
  assert.equal(textBlock.text, 'There are 17 outages.');
});
