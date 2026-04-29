# Ask AI - Local-Provider Setup (FMN-120)

The Ask AI tool can route chat turns to a local OpenAI-compatible server (Ollama or LM Studio) instead of Anthropic. This page covers the gotchas operators hit when setting that up.

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

**Local providers (Ollama, LM Studio) automatically receive a curated handwritten-only catalog**, regardless of the tier setting. The codegen 260+ tools are filtered out for local providers because they consistently break tool selection on small/medium open models:

- qwen3:8b on readonly picked codegen `list_server_outages` (requires `server_id`) over handwritten `list_active_outages` (no params), then asked the user for a server id instead of just listing outages.
- qwen2.5:14b made the same mistake even when told explicitly "call list_active_outages with no filters", and on a third try produced gibberish in Thai script — tokens lost to the 30-50 tool catalog.

The handwritten catalog is ~10-15 tools, narrow and curated, with names that don't shadow each other:

- `search_servers`, `list_servers`, `get_server`
- `list_active_outages`, `list_outages`, `get_outage`
- `list_agent_resources_for_server`
- `list_fabric_connections`, `list_templates`, `list_server_groups`
- `acknowledge_outage` (readwrite tier)
- Hand-port composite/bulk tools

The Ask AI tool tier setting still applies (readonly hides writes; readwrite includes them; "all" is functionally equivalent to readwrite for local providers since codegen is excluded), but the catalog never grows to the codegen surface.

**This means cloud Anthropic still has access to 260+ tools when the operator picks Anthropic as the provider** — the filter is provider-scoped, not global.

### When the local model still misbehaves

If even the curated handwritten catalog isn't enough:

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
