# Unofficial FortiMonitor Toolkit

Chrome Manifest V3 extension — a suite of operator tools for FortiMonitor. Most tools ride your existing FortiMonitor browser session; tools whose capability lives in the v2 public API (e.g., Add Fabric Connection) use a user-supplied RW API key.

Clicking the toolbar icon opens a launcher popup; pick a tool from the list and it opens in a full browser tab. Settings (⚙ in the popup header) holds the v2 API key for tools that need one.

## Tools

| Tool | Auth | Status | Notes |
|---|---|---|---|
| Remove from Port Scope (Fabric) | FortiMonitor session | ✅ Shipped (v0.1) | Batch-remove operationally-down WAN interfaces from monitored port scope on Fabric-connected FortiGate instances. Destructive — destroys agent resources and metric history per port removed. |
| Add to Port Scope (Fabric) | FortiMonitor session | ✅ Shipped (v0.2) | Inverse of Remove. Batch-add currently-unmonitored interfaces to port scope on Fabric-connected FortiGate instances. Non-destructive. |
| Add Fabric Connection (API) | FortiMonitor v2 API key | 🧪 Beta (v0.3) | Bulk-create OnSight CSF tunnel connections for FortiGate devices via `POST /v2/fabric_connection`. Requires a Read/Write API key (paste once in popup → ⚙ Settings). **Beta until verified in a live FortiMonitor environment.** |
| Manage Server Attributes (Bulk) | FortiMonitor v2 API key | 🧪 Beta (v0.5) | Bulk-set or remove attribute key/value pairs across many servers via `POST`/`DELETE /v2/server/{id}/server_attribute`. Paste a list of server names or IDs, pick an attribute type, preview per-row plan (add / replace / skip / error), then execute. Uses the same RW API key as Add Fabric Connection. **Beta until verified in a live FortiMonitor environment.** |
| Manage Server Templates (Bulk) | FortiMonitor v2 API key | 🧪 Beta (v0.6) | Bulk-attach or detach monitoring templates across many servers via `POST`/`DELETE /v2/server/{id}/template`. Detach supports `dissociate` (safe) and `delete` (destructive — wipes metric history); destructive detach and large batches require a typed confirmation. Uses the same RW API key as Add Fabric Connection. **Beta until verified in a live FortiMonitor environment.** |
| Ask Claude | FortiMonitor v2 API key + Anthropic API key | 🧪 Beta · Prototype (v0.7) · hidden by default | In-plugin Claude chat with tool use against ~10-12 read-only FortiMonitor v2 endpoints plus one gated write (`acknowledge_outage`). Streams via SSE; caches tool definitions for cost. Uses *your* Anthropic API key — direct cost exposure, no rate limit. **Hidden by default** — enable via popup → ⚙ Settings → Experimental tools → *Show Ask Claude (prototype)*. See [../docs/mcp-chat-prototype.md](../docs/mcp-chat-prototype.md) for scope and expand/kill criteria. |

## Install (developer mode)

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` directory inside this repo
5. Log in to FortiMonitor in any tab — the extension rides whatever session you already have
6. Click the toolbar icon to open the launcher

## Run tests

```
cd extension
npm test
```

Uses Node's built-in `node:test` runner — no `npm install` required.

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
    popup/          — toolbar popup launcher (Phase B)
    background/     — service worker, tool-specific orchestration
    lib/            — shared infrastructure (client, queue, retry,
                      concurrency, fingerprint, dom helpers, messaging)
    ui/             — tool UI shell + per-step modules
  tests/            — Node test runner unit tests
```

Tickets: FMN-35 (original WAN-cleanup epic, closed), FMN-39 (Remove tool implementation, closed), FMN-40 (launcher + rebrand + Add tool, in progress).

## About the Developer

Built by **Gregori Jenkins** — originally from Chicago, a humble student of Computer Science, and a proud cat dad.

[Connect on LinkedIn](https://www.linkedin.com/in/gregorijenkins)
