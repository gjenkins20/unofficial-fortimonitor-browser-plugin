// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Service-worker handlers for the "Ask Claude" prototype (FMN-53).
//
// Streams assistant turns + tool-call lifecycle back to the UI via
// chrome.runtime runtime events (emit). The UI sends one 'chat:send'
// per user turn and subscribes to 'chat:event' broadcasts.

import { createProductionPanoptaClient } from '../lib/panopta-client.js';
import { runToolLoop, DEFAULT_MODEL } from '../lib/claude-client.js';
import {
  runToolLoop as runOpenAIToolLoop,
  testConnection as testOpenAIConnection
} from '../lib/openai-compat-client.js';
import { buildToolDefinitions, buildToolHandlers, SYSTEM_PROMPT } from '../lib/claude-tools.js';
import {
  getAskClaudeToolTier,
  getAskClaudeProvider,
  getAskClaudeProviderConfig
} from '../lib/settings.js';

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
        const { messages, model: requestedModel, maxIterations = 8, maxTokens = 2048 } = payload ?? {};
        if (!Array.isArray(messages) || messages.length === 0) {
          throw new TypeError('chat:send: messages is required');
        }
        const [client, tier, provider] = await Promise.all([
          panoptaFactory(),
          getAskClaudeToolTier(),
          getAskClaudeProvider()
        ]);
        const tools = buildToolDefinitions(tier);
        const handlers = buildToolHandlers(client);
        const runTool = async (name, input) => {
          const handler = handlers[name];
          if (!handler) throw new Error(`Unknown tool: ${name}`);
          return await handler(input);
        };

        let result;
        if (provider === 'anthropic') {
          const apiKey = await keyFactory();
          result = await runToolLoop({
            apiKey,
            model: requestedModel ?? DEFAULT_MODEL,
            system: SYSTEM_PROMPT,
            tools,
            messages,
            maxIterations,
            maxTokens,
            signal: ac.signal,
            runTool,
            onEvent: (ev) => emit('chat:event', ev)
          });
        } else {
          // FMN-120: Ollama / LM Studio via OpenAI-compatible API. The
          // surrounding tool dispatch is identical; only the wire
          // protocol differs. The provider-specific URL/model live in
          // chrome.storage.local and are read on each turn so the
          // operator can swap providers without restarting the
          // service worker.
          const cfg = await getAskClaudeProviderConfig(provider);
          if (!cfg.url) {
            throw new Error(`No URL configured for ${provider}. Open Settings and set a base URL.`);
          }
          const effectiveModel = requestedModel ?? cfg.model;
          if (!effectiveModel) {
            throw new Error(`No model configured for ${provider}. Open Settings and set a model name.`);
          }
          result = await runOpenAIToolLoop({
            url: cfg.url,
            apiKey: cfg.apiKey || null,
            model: effectiveModel,
            systemPrompt: SYSTEM_PROMPT,
            tools,
            messages,
            maxIterations,
            maxTokens,
            signal: ac.signal,
            runTool,
            onEvent: (ev) => emit('chat:event', ev)
          });
        }

        return {
          stopReason: result.stopReason,
          messages: result.messages,
          provider,
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

    'chat:test-openai-compat': async (payload) => {
      // FMN-120: probe an Ollama / LM Studio endpoint. Reads either an
      // explicit { provider, url, model, apiKey } passed in the payload
      // (so the Settings UI can test before saving) or falls back to
      // the persisted per-provider config when only a provider is
      // supplied.
      const { provider, url: urlOverride, model: modelOverride, apiKey: apiKeyOverride } = payload ?? {};
      if (!provider || (provider !== 'ollama' && provider !== 'lmstudio')) {
        throw new Error('chat:test-openai-compat: provider must be "ollama" or "lmstudio"');
      }
      let url = urlOverride;
      let model = modelOverride;
      let apiKey = apiKeyOverride;
      if (!url || model === undefined || apiKey === undefined) {
        const cfg = await getAskClaudeProviderConfig(provider);
        url = url ?? cfg.url;
        model = model ?? cfg.model;
        apiKey = apiKey ?? cfg.apiKey;
      }
      const result = await testOpenAIConnection({
        url,
        apiKey: apiKey || null,
        expectedModel: model || null
      });
      return {
        ok: true,
        url,
        model,
        modelFound: result.modelFound,
        models: Array.isArray(result.models) ? result.models.slice(0, 50) : null,
        soft: result.soft === true
      };
    },

    'chat:test-claude-key': async () => {
      // Cheap probe - one message, no tools, no streaming needed but we
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
