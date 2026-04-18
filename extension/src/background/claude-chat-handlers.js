// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Service-worker handlers for the "Ask Claude" prototype (FMN-53).
//
// Streams assistant turns + tool-call lifecycle back to the UI via
// chrome.runtime runtime events (emit). The UI sends one 'chat:send'
// per user turn and subscribes to 'chat:event' broadcasts.

import { createProductionPanoptaClient } from '../lib/panopta-client.js';
import { runToolLoop, DEFAULT_MODEL } from '../lib/claude-client.js';
import { buildToolDefinitions, buildToolHandlers, SYSTEM_PROMPT } from '../lib/claude-tools.js';

const CLAUDE_KEY_STORAGE_KEY = 'claude.apiKey';

async function getClaudeApiKey(storage = chrome.storage.local) {
  const data = await storage.get(CLAUDE_KEY_STORAGE_KEY);
  const key = data?.[CLAUDE_KEY_STORAGE_KEY];
  if (!key) throw new Error('No Claude API key configured. Open Settings and paste your Anthropic key.');
  return key;
}

export function createClaudeChatHandlers({ events = {}, getPanoptaClient, getApiKey } = {}) {
  const emit = events.emit ?? (() => {});
  const panoptaFactory = getPanoptaClient ?? (() => createProductionPanoptaClient());
  const keyFactory = getApiKey ?? (() => getClaudeApiKey());

  let currentRun = null;

  return {
    'chat:send': async (payload) => {
      if (currentRun) throw new Error('A chat turn is already running');
      const ac = new AbortController();
      currentRun = { ac, startedAt: new Date().toISOString() };
      try {
        const { messages, model = DEFAULT_MODEL, maxIterations = 8, maxTokens = 2048 } = payload ?? {};
        if (!Array.isArray(messages) || messages.length === 0) {
          throw new TypeError('chat:send: messages is required');
        }
        const [apiKey, client] = await Promise.all([keyFactory(), panoptaFactory()]);
        const tools = buildToolDefinitions();
        const handlers = buildToolHandlers(client);

        const result = await runToolLoop({
          apiKey,
          model,
          system: SYSTEM_PROMPT,
          tools,
          messages,
          maxIterations,
          maxTokens,
          signal: ac.signal,
          runTool: async (name, input) => {
            const handler = handlers[name];
            if (!handler) throw new Error(`Unknown tool: ${name}`);
            return await handler(input);
          },
          onEvent: (ev) => emit('chat:event', ev)
        });

        return {
          stopReason: result.stopReason,
          messages: result.messages,
          startedAt: currentRun.startedAt,
          finishedAt: new Date().toISOString()
        };
      } finally {
        currentRun = null;
      }
    },

    'chat:abort': async () => {
      if (!currentRun) return { aborted: false, reason: 'no active run' };
      currentRun.ac.abort();
      return { aborted: true };
    },

    'chat:status': async () => {
      return { running: currentRun !== null, startedAt: currentRun?.startedAt ?? null };
    },

    'chat:test-claude-key': async () => {
      // Cheap probe — one message, no tools, no streaming needed but we
      // reuse the streaming path for consistency.
      const apiKey = await keyFactory();
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }]
        })
      });
      if (!res.ok) {
        let bodyText = null;
        try { bodyText = await res.text(); } catch {}
        throw new Error(`Claude API HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
      }
      return { ok: true, status: res.status };
    }
  };
}
