# Unofficial FortiMonitor Toolkit

Chrome Manifest V3 extension - a suite of operator tools for FortiMonitor. Most tools ride your existing FortiMonitor browser session; tools whose capability lives in the v2 public API (e.g., Add Fabric Connection) use a user-supplied RW API key.

Clicking the toolbar icon opens a launcher popup; pick a tool from the list and it opens in a full browser tab. Settings (⚙ in the popup header) holds the v2 API key for tools that need one.

## Tools

| Tool | Auth | Status | Notes |
|---|---|---|---|
| Bulk Action Composer | FortiMonitor v2 API key (most actions) or FortiMonitor session (port-scope actions) | ✅ Shipped (v1.0) | The flagship loop. Load a list of instances (paste, omni-search, sender handoff, or CSV), pick an action, preview the per-row plan, then commit. Nine actions visible by default (Add Tag, Remove Tag, Apply Template, Apply Stock Fabric Templates, Profile + Create Templates, Add to Port Scope, Remove from Port Scope, Auto-tag by name pattern, Auto-set attribute by name pattern); three more (Set Parent Group, Set Agent Resource Status, Schedule Maintenance Window) are hidden behind popup → ⚙ Settings → *Show FortiMonitor native bulk actions*. |
| Remove from Port Scope (Fabric) | FortiMonitor session | ✅ Shipped (v0.1) | Batch-remove operationally-down WAN interfaces from monitored port scope on Fabric-connected FortiGate instances. Destructive - destroys agent resources and metric history per port removed. Bulk Action Composer's *Remove from Port Scope* action covers the general by-name shape; this standalone tool keeps its WAN-interface discovery flow. |
| Add to Port Scope (Fabric) | FortiMonitor session | ✅ Shipped (v0.2) | Inverse of Remove. Batch-add currently-unmonitored interfaces to port scope on Fabric-connected FortiGate instances. Non-destructive. Bulk Action Composer's *Add to Port Scope* action covers the general by-name shape; this standalone tool keeps its interface-discovery flow. |
| Add Fabric Connection (API) | FortiMonitor v2 API key | ✅ Shipped (v1.0) | Bulk-create OnSight CSF tunnel connections for FortiGate devices via `POST /v2/fabric_connection`. Requires a Read/Write API key (paste once in popup → ⚙ Settings). |
| Manage Server Attributes (Bulk) | FortiMonitor v2 API key | ✅ Shipped (v0.5) | Bulk-set or remove attribute key/value pairs across many servers via `POST`/`DELETE /v2/server/{id}/server_attribute`. Paste a list of server names or IDs, pick an attribute type, preview per-row plan (add / replace / skip / error), then execute. Uses the same RW API key as Add Fabric Connection. |
| Manage Server Templates (Bulk) | FortiMonitor v2 API key | ✅ Shipped (v1.0) | Bulk-attach or detach monitoring templates across many servers via `POST`/`DELETE /v2/server/{id}/template`. Detach supports `dissociate` (safe) and `delete` (destructive - wipes metric history); destructive detach and large batches require a typed confirmation. Uses the same RW API key as Add Fabric Connection. |
| Ask AI | FortiMonitor v2 API key + AI provider credentials | ✅ Shipped (v1.0) | In-plugin chat with tool use against a curated set of read-only FortiMonitor v2 endpoints plus one gated write (`acknowledge_outage`). Streams via SSE; prompt-caches tool definitions on Anthropic. Provider is operator's choice in Settings: Anthropic (cloud, your API key, direct cost exposure), Ollama (local, OpenAI-compat, no per-turn cost), or LM Studio (local, OpenAI-compat). Shown by default; toggle off in popup → ⚙ Settings → Experimental tools to hide. **Local providers must use a tool-capable model** (Qwen 2.5+, Llama 3.1+, Mistral Nemo, Command R+, Qwen 3); Gemma family and Llama 2 will not call tools. See [../docs/mcp-chat-prototype.md](../docs/mcp-chat-prototype.md) for scope and [../docs/ask-ai-local-providers.md](../docs/ask-ai-local-providers.md) for local-provider setup. |
| Search Servers | FortiMonitor v2 API key | ✅ Shipped (v1.0) · hidden by default | Pages the full `/v2/server` list and filters client-side by a single attribute (built-in like Model / OS, or any customer-defined type). Exports matches as CSV. Read-only. Enable via popup → ⚙ Settings → Experimental tools → *Show Search Servers*. |

## Install (developer mode)

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` directory inside this repo
5. Log in to FortiMonitor in any tab - the extension rides whatever session you already have
6. Click the toolbar icon to open the launcher

## Run tests

```
cd extension
npm test
```

Uses Node's built-in `node:test` runner - no `npm install` required.

## Scope guardrails

- Per-tool auth choice is intentional. Tools whose capability lives only in the FortiMonitor UI (port-scope) ride the browser session. Tools whose capability is exposed cleanly in the v2 API (fabric_connection) use a user-supplied API key.
- Each tool declares its own action scope (e.g., Remove targets WAN interfaces; Add Fabric Connection targets new device onboarding).
- Dry-run is the default for every batch.
- Destructive and write-capable tools require a typed confirmation phrase before live writes.
- `fortilink` is visually flagged as the fabric link across every port-scope tool.

## Architecture

```
extension/
  manifest.json
  src/
    popup/          - toolbar popup launcher
    background/     - service worker, tool-specific orchestration
    lib/            - shared infrastructure (client, queue, retry,
                      concurrency, fingerprint, dom helpers, messaging)
    ui/             - tool UI shell + per-step modules
  tests/            - Node test runner unit tests
```


## About the Developer

Built by **Gregori Jenkins** - originally from Chicago, a humble student of Computer Science, and a proud cat dad.

[Connect on LinkedIn](https://www.linkedin.com/in/gregorijenkins)
