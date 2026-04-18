# Ask Claude in-plugin chat — prototype (FMN-53)

A narrow-slice prototype that embeds a Claude chat surface directly in the
extension popup's launcher, driven by a user-supplied Anthropic API key and
a curated subset of FortiMonitor v2 API tools. The goal is to evaluate
whether an in-plugin conversational UI delivers enough value to justify
broader investment (more tools, polish, live-test) versus leaving
conversational workflows to the standalone
[`fortimonitor-mcp-server`](https://github.com/gjenkins20/unofficial-fortimonitor-mcp-server).

Companion ticket: **FMN-53** (branch `feature/fmn-53-ask-claude-prototype`).

---

## Why a prototype (vs. full port)

The FortiMonitor MCP server exposes 241 tools across 33 modules. Porting all
of them into the extension is a multi-week effort with an unknown payoff —
much of that surface area (compound services, dashboards, reference data,
reporting, SNMP discovery) is only rarely touched, and the knowledge layer
(LanceDB + PDF embeddings) cannot be carried over at all without a hosted
component.

Rather than commit to that investment blind, we ship a minimal slice —
roughly what you'd reach for during an incident triage session — and see
whether users want more breadth, different breadth, or whether the existing
deterministic tools already cover the ground they need.

## Scope

**In:** conversational chat surface, tool-use loop, prompt caching on tool
definitions, SSE streaming, ~10-12 read-only FortiMonitor tools plus a
single gated write (`acknowledge_outage`).

**Out:** knowledge layer (RAG over Panopta docs), the other ~230 MCP tools,
bulk write workflows, multi-session history, Chrome Web Store distribution,
any cost guardrails beyond a warning.

## Architecture

```
 Popup (launcher + settings)
   └── Ask Claude (src/ui/ask-claude/)
         ▲                              ▲
         │ chrome.runtime.sendMessage   │ '__event__' broadcasts
         ▼                              │
 Service worker (src/background/service-worker.js)
   └── claude-chat-handlers.js
         ├── Messages API (api.anthropic.com) — streaming SSE
         └── PanoptaClient (lib/panopta-client.js) — FortiMonitor v2 API
```

- **Auth.** Two API keys in `chrome.storage.local`:
  - `panopta.apiKey` — existing FortiMonitor v2 RW key.
  - `claude.apiKey` — new, Anthropic key.
  Stored identically to the existing key. No secret rotation, no vault —
  parity with the existing tools.
- **Tool loop.** `lib/claude-client.js` runs a bounded loop: send messages
  → parse SSE → if `stop_reason: tool_use`, execute tool blocks locally
  against `PanoptaClient`, append `tool_result`, loop. Cap at 8 iterations
  to prevent runaways.
- **Prompt caching.** The last tool definition carries
  `cache_control: { type: 'ephemeral' }`, so the whole tools block (~10 KB
  of schema) is reused across turns within the 5-min TTL. Without this,
  every user turn re-sends the full catalog and racks up cost quickly.
- **Streaming.** Native `fetch` + `ReadableStream`; SSE parsed in
  `lib/claude-client.js::parseSSE`. No SDK dependency — keeps the bundle
  clean and dodges the `dangerouslyAllowBrowser` flag plumbing.
- **Messaging.** The chat UI listens on `chrome.runtime.onMessage` for the
  standard `__event__` broadcasts that the other tools already emit. UI
  renders tool calls inline as collapsible cards so the user sees *what*
  Claude queried to answer them.

## Tool subset

| Tool | v2 endpoint | Kind |
|------|-------------|------|
| `search_servers` | `GET /server?name=…` | read |
| `list_servers` | `GET /server` | read |
| `get_server` | `GET /server/{id}` | read |
| `list_active_outages` | `GET /outage/active` | read |
| `list_outages` | `GET /outage` | read |
| `get_outage` | `GET /outage/{id}` | read |
| `list_agent_resources_for_server` | `GET /server/{id}/agent_resource` | read |
| `list_fabric_connections` | `GET /fabric_connection` | read |
| `list_templates` | `GET /server_template` | read |
| `list_server_groups` | `GET /server_group` | read |
| `acknowledge_outage` | `POST /outage/{id}/acknowledge` | write (gated) |

Tool results are post-processed server-side (`buildToolHandlers` in
`claude-tools.js`) to strip fields Claude doesn't need (internal URLs,
pagination scaffolding) — this keeps the tool result payload small,
which materially reduces the input-token count of subsequent turns.

## Rejected / deferred choices

- **Anthropic TypeScript SDK.** Smaller surface without it. Re-evaluate
  if the prototype graduates — retries and streaming primitives are nice
  to have but not necessary for a ~200-LOC client.
- **Persisted conversation history.** Prototype keeps state in memory
  only — close the tab and the conversation is gone. Persisting is
  cheap to add later if the tool earns it.
- **Per-user cost guardrails.** Out of scope — surface a warning in the
  settings panel and call it done for the prototype. If we graduate to
  shipped, `chrome.storage` counters + a soft daily cap is the obvious
  next step.
- **Knowledge layer / RAG.** Confirmed out of scope with the product
  owner. Drop entirely for the prototype. If wanted later, host
  embeddings in the FM Knowledge Worker project (FMK) and call it from
  the extension as a remote lookup tool.

## Expand / kill — what we're watching for

Ship the prototype to a handful of test accounts and answer:

1. **Coverage.** Which questions hit the 10-12 tool ceiling? If users
   consistently need a tool outside the subset, that's a signal the
   subset needs to grow (and which direction).
2. **Latency and cost.** How many turns does a typical "what's broken
   right now?" question take? Is cache-hit rate on the tools block
   close to 100% as expected?
3. **Failure modes.** Does Claude hallucinate server ids or outage ids
   when the tool surface is too narrow? Does it try to call unsupported
   tools?
4. **Vs. existing deterministic tools.** Do users reach for this
   *instead of* the bulk tools (good — conversational flow wins) or
   *in addition to* them (good — complementary) or not at all (kill
   signal)?

If we expand: carve follow-up FMN tickets per tool family (e.g. "add
maintenance window tools", "add SNMP resource tools") rather than porting
everything at once.

If we kill: rip out the feature cleanly — the surface is deliberately
contained (`src/ui/ask-claude/`, `src/background/claude-chat-handlers.js`,
`src/lib/claude-*.js`, manifest host permission, one popup card, one
settings section) so removal is a small PR.

## Files introduced

- `extension/src/lib/claude-client.js` — Anthropic Messages API + tool loop.
- `extension/src/lib/claude-tools.js` — tool manifest + JS handlers.
- `extension/src/background/claude-chat-handlers.js` — service-worker wiring.
- `extension/src/ui/ask-claude/{app.html,app.js,app.css}` — chat UI.

## Files modified additively

- `extension/manifest.json` — added `https://api.anthropic.com/*` host
  permission; version → `0.7.0`.
- `extension/src/background/service-worker.js` — registered the chat
  handlers alongside the other tools' handlers.
- `extension/src/lib/panopta-client.js` — added read helpers
  (`listServers`, `getServer`, `listOutages`, `getOutage`,
  `listAgentResourcesForServer`, `listFabricConnections`,
  `acknowledgeOutage`).
- `extension/src/popup/popup.html` + `popup.js` — added Ask Claude
  launcher card, Claude API key settings section, tool-guard extension
  for `data-claude-key-required`.

No existing files were trimmed — shared registries (service worker,
popup launcher, panopta client) were edited additively per project
memory `additive_edits_to_shared_registries.md`.
