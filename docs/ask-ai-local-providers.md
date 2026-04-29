# Ask AI - Local-Provider Setup (FMN-120)

The Ask AI tool can route chat turns to a local Ollama or LM Studio server instead of Anthropic. This page covers the architecture, the gotchas operators hit, and the validated model list.

## Endpoint architecture (per provider)

| Provider | Endpoint the extension uses | Why |
|---|---|---|
| Anthropic | `https://api.anthropic.com/v1/messages` | cloud, native Anthropic |
| Ollama | `http://&lt;host&gt;:11434/api/chat` (Ollama-native NDJSON) | Ollama's `/v1/chat/completions` is an OpenAI-compat shim that **silently drops the `options` field**, including `num_ctx`. Without `num_ctx` the default 4096 truncates the system prompt and breaks tool-result-heavy turns. `/api/chat` honors `options` per request. |
| LM Studio | `http://&lt;host&gt;:1234/v1/chat/completions` (OpenAI-compat) | LM Studio doesn't have an `/api/chat` endpoint; its OpenAI-compat surface DOES honor `options`. |

The extension's Settings UI shows the same configuration shape for both local providers (URL + Model + optional API key); the URL routing is handled internally based on which provider the operator selected.

## Pick a tool-capable model

The chat sends function definitions on every turn and expects the model to emit `tool_calls`. Models without tool training silently ignore the tool catalog and reply with text - which looks like the chat just isn't doing anything useful.

**Confirmed tool-capable on Ollama:**

- `qwen2.5` family (`qwen2.5:7b`, `qwen2.5:14b`, `qwen2.5:32b`, `qwen2.5:72b`) - reliable default
- `qwen3`, `qwen3-coder` - Qwen team's tool-trained 2025 line
- `llama3.1` (8B, 70B), `llama3.2` (3B variants for tools) - Meta
- `mistral-nemo` (12B), `mistral-small` (22B) - Mistral
- `command-r-plus` - Cohere; heavy but very strong tool use
- `firefunction-v2` - Fireworks-AI fine-tune dedicated to function calling

**Will NOT use tools (don't bother):**

- Gemma 1 / 2 / 3 family (including `gemma2:*`, `gemma3:*`, any `gemma*:e*b` variant) - Google didn't include function calling in any Gemma release as of writing
- Llama 2 and base Llama 3 (untrained for tools)
- Phi 2 (Phi 3+ has limited support, not recommended)
- Most coding-only fine-tunes (CodeLlama, deepseek-coder, etc.) - they specialize away from tool use

**Verify any model:**

```
ollama show <model>
```

The `Capabilities:` line must include `tools`. Example:

```
$ ollama show qwen2.5
Model
  architecture        qwen2
  parameters          7.6B
  ...
Capabilities
  completion
  tools
```

The full tool-capable catalog on Ollama: <https://ollama.com/search?c=tools>

## Catalog size for local providers

**Local providers (Ollama, LM Studio) automatically receive a curated handwritten-only catalog**, regardless of the tier setting. The codegen 260+ tools are filtered out for local providers because the larger surface increases tool-selection difficulty for small/medium models — there are name collisions (e.g. `list_server_outages` codegen vs `list_active_outages` handwritten) that pattern-match on similar substrings.

The handwritten catalog is ~10-15 tools, narrow and curated:

- `search_servers`, `list_servers`, `get_server`
- `list_active_outages`, `list_outages`, `get_outage`
- `list_agent_resources_for_server`
- `list_fabric_connections`, `list_templates`, `list_server_groups`
- `acknowledge_outage` (readwrite tier)
- Hand-port composite/bulk tools (e.g. `search_servers_advanced`, `get_servers_with_active_outages`)

The Ask AI tool tier setting still applies (readonly hides writes; readwrite includes them; "all" is functionally equivalent to readwrite for local providers since codegen is excluded), but the catalog never grows to the codegen surface.

**Cloud Anthropic still has access to 260+ tools when the operator picks Anthropic as the provider** — the filter is provider-scoped, not global.

## Context window (`num_ctx`)

The dominant cause of local-LLM failures (truncated system prompt → meta-analysis prose, gibberish output) is Ollama's default 4096-token context window. Tool definitions + tool result + system prompt routinely overflow it on outage-list queries.

The plugin defaults `num_ctx` to **16384** on every Ollama request (set on `/api/chat` request body, where it's actually honored). This closes the gap on the validated model matrix.

If your tenant's outage-list result is unusually large (50+ active outages with full attributes) and you still see truncation warnings (`time=... level=WARN ... msg="truncating input prompt"`) in `ollama serve`'s log, raise the override:

```
chrome.storage.local.set({ 'fm:askAiNumCtx': 32768 })
```

(There's no Settings UI for this yet; set it via the extension's service-worker DevTools console if you need a higher value. The Ollama daemon's VRAM footprint scales with this — at 32k an 8B model needs roughly 6GB Metal VRAM vs 3GB at 8k.)

### Why not just use `/v1/chat/completions`?

Ollama exposes both `/v1/chat/completions` (OpenAI-compat) and `/api/chat` (native). The OpenAI-compat shim silently drops the `options` field because it's not in the OpenAI spec. Pre-warming the model via `/api/generate` with `options.num_ctx` doesn't transfer to subsequent `/v1/chat/completions` calls — Ollama maintains independent loaded model instances per endpoint. The only reliable way to set `num_ctx` per-request on Ollama is through `/api/chat`, which is what the plugin uses.

## Validated model matrix

`tests/e2e/ask-ai-live.spec.js` runs 8 canonical chat scenarios against a real local Ollama. Each scenario fetches ground truth from the FortiMonitor API and asserts that the chat response actually surfaces real data (count + at least one specific record), not just that the right tool fired. The matrix catches the meta-analysis-prose failure mode (the model writing essays about JSON structure instead of presenting data) — that's the failure mode that regular tool-call assertion misses.

As of this writing (commit `3030011`):

| Model | Scenarios passed | Notes |
|---|---|---|
| `qwen3:8b` | 8/8 | clean tool selection, real response prose |
| `qwen2.5:14b` | 8/8 (older run) | one scenario emitted Thai-script prose pre-fix; needs re-run on current commit |

Untested at present: llama3.x family, mistral-nemo, qwen2.5:7b, sub-7B sizes.

### Run it yourself

```
# Run with both pre-pulled models
OLLAMA_LIVE=1 OLLAMA_MODELS=qwen3:8b,qwen2.5:14b npm run test:e2e:ollama-live

# Single-model smoke
OLLAMA_LIVE=1 OLLAMA_MODELS=qwen3:8b npm run test:e2e:ollama-live

# Default matrix (pulls additional models)
OLLAMA_LIVE=1 npm run test:e2e:ollama-live
```

Report goes to `docs/ask-ai-model-matrix.md`. Cell format: `PASS &lt;latency&gt;` or `FAIL: &lt;reason&gt;`. Flags `!ctx` and `!gib` mark cells where Ollama logged truncation or where the response tripped the gibberish heuristic. Per-failure detail includes the first 500 chars of the model's response.

## When the local model still misbehaves

If a tool-capable model with `num_ctx=16384` still picks wrong:

1. **Be explicit.** Say "call list_active_outages with no filters" — small models follow direct tool names well even when they don't infer them.
2. **Bigger model.** Step up to qwen2.5:14b or qwen3:14b. Tool-selection accuracy scales with model size, but any model below 7B will struggle.
3. **Cloud provider for hard queries.** Switch Settings → Anthropic for one-off queries the local model fumbles.

## Ollama: the CORS / `OLLAMA_ORIGINS` gotcha

Ollama's HTTP server applies an Origin allowlist to every incoming request. By default this list covers localhost / 127.0.0.1 / 0.0.0.0 / app:// / file:// / tauri:// / vscode:// - but **not** `chrome-extension://`. A chat turn from the extension will return HTTP 403 with no body until you add the extension origin.

`OLLAMA_ORIGINS` is **additive**, not a replacement - the defaults stay intact.

### Wide allowlist (any extension)

```
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

### Pinned to a specific extension

After loading the extension, find its ID at `chrome://extensions/` (Developer mode on). Then:

```
OLLAMA_ORIGINS="chrome-extension://<your-extension-id>" ollama serve
```

### Windows persistence options

**PowerShell, current session only** (simplest test):

```
$env:OLLAMA_ORIGINS = "chrome-extension://*"
ollama serve
```

The variable disappears when the PowerShell window closes. Stop the running Ollama before this so the new `ollama serve` actually picks up the env.

**PowerShell, persistent for your user account:**

```
[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://*", "User")
```

Restart PowerShell so the new env propagates, then either run `ollama serve` from a fresh shell or restart the Ollama desktop app / service.

**Persistent system-wide** (requires admin PowerShell):

```
[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://*", "Machine")
```

Then restart the Ollama service (`Restart-Service Ollama` in admin PowerShell, or via `services.msc` if you used the official installer's service-mode option).

**GUI path:** System Properties → Advanced → Environment Variables → New (System variables) → name `OLLAMA_ORIGINS`, value `chrome-extension://*`. Restart the Ollama service or sign out/in.

**CMD, current session only:**

```
set OLLAMA_ORIGINS=chrome-extension://*
ollama serve
```

### Verify on Windows

In a fresh PowerShell:

```
echo $env:OLLAMA_ORIGINS                    # should print chrome-extension://*
Get-Process ollama | Select-Object -ExpandProperty StartInfo  # confirm ollama is running
```

Then from any host on the LAN (or the Windows host itself):

```
curl -i -H "Origin: chrome-extension://test" http://<windows-ip>:11434/v1/models
```

200 = ready. 403 = the running Ollama still doesn't have the env var (most often: you set it user-scope but Ollama is running as a system service, or you set it after the service started). Restart the service.

### Windows firewall + LAN access

If reaching the Windows host from another machine fails before any 403 appears (timeout, "Failed to fetch"), Windows Firewall is blocking inbound 11434:

```
New-NetFirewallRule -DisplayName "Ollama" -Direction Inbound -LocalPort 11434 -Protocol TCP -Action Allow
```

Also confirm Ollama is binding to all interfaces, not just 127.0.0.1:

```
[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:11434", "Machine")
```

Restart the Ollama service after that.

### macOS persistence options

**Inline per-shell** (simplest, what we recommend for testing):

```
echo 'export OLLAMA_ORIGINS="chrome-extension://*"' >> ~/.zshrc
source ~/.zshrc
ollama serve
```

**Menu-bar app** (`Ollama.app` from ollama.com/download): the app runs outside your shell, so `export` doesn't reach it. Use `launchctl`:

```
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
launchctl getenv OLLAMA_ORIGINS    # confirm it took
```

Then quit Ollama from the menu bar (llama icon → Quit) and reopen `/Applications/Ollama.app`. `launchctl setenv` only persists for the current login session; for reboot persistence, install a launch agent.

### Verify

```
curl -i -H "Origin: chrome-extension://test" http://localhost:11434/v1/models
```

`HTTP/1.1 200` = ready. `HTTP/1.1 403` = the running Ollama process didn't pick up the env var (almost always: you set it in one shell but Ollama is running in another, or the menu-bar app is running and you used `export` instead of `launchctl setenv`). Stop the running process and start a fresh one in the shell where the var is exported.

## LM Studio

LM Studio's local-server mode at `http://localhost:1234/v1` is OpenAI-compatible out of the box. No equivalent to `OLLAMA_ORIGINS` - LM Studio's server accepts any origin by default.

Caveats:

- LM Studio shows the loaded-model id in the server header; copy that exact string into the **Model** field.
- `/v1/models` returns just the loaded model, not a catalog. The plugin's "Test connection" treats a 404 on `/v1/models` as a soft pass and a 200 as a strict pass.
- Tool-use support depends on the loaded model, not LM Studio itself. Same model whitelist as above.

## Failure modes and what they mean

| Symptom | Cause | Fix |
|---|---|---|
| `HTTP 403 from .../v1/chat/completions` | Ollama allowlist | Set `OLLAMA_ORIGINS`, restart Ollama |
| Test connection passes, chat 403s | Same as above (test GET often skips the Origin header path Ollama checks; POST always sends it) | Set `OLLAMA_ORIGINS`, restart Ollama |
| `Reachable, but model "X" not in /models` | Model not pulled or wrong tag | `ollama pull <model>` or fix the tag in Settings |
| Chat returns text with no tool calls | Model isn't tool-trained | Switch to `qwen2.5` / `llama3.1` / etc. |
| Chat returns text saying "function not available" | Model isn't tool-trained, or the catalog is too big and the model hallucinated a tool name | Tool-trained model + drop to read-only tier |
| `address already in use` on `ollama serve` | Another Ollama already running on 11434 | `lsof -ti:11434` to find PID; stop or restart that one |

## Switching providers without losing config

Provider URL/model/api-key fields persist per provider. Switching from Ollama to LM Studio and back preserves what was saved for each. Provider selection itself is a separate `chrome.storage.local` key (`fm:askClaudeProvider`) and can be flipped freely from Settings.

## See also

- [`mcp-chat-prototype.md`](mcp-chat-prototype.md) - Ask AI scope and tool catalog
- Ollama OpenAI-compat docs: <https://github.com/ollama/ollama/blob/main/docs/openai.md>
- LM Studio API docs: <https://lmstudio.ai/docs/local-server>
- Ollama tool-capable model catalog: <https://ollama.com/search?c=tools>
