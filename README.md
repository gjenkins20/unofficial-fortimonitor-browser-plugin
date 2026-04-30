# Unofficial FortiMonitor Toolkit

A Chrome Manifest V3 browser extension that bundles batch operator tools for [FortiMonitor](https://www.fortinet.com/products/fortimonitor). Each tool picks the auth surface that matches the underlying capability: tools whose capability lives only in the FortiMonitor web UI ride your existing browser session; tools whose capability is exposed cleanly in the v2 public API use a user-supplied RW API key.

**This project is not affiliated with, endorsed by, or associated with Fortinet.** It's an unofficial operator tool that automates batch tasks the FortiMonitor web UI exposes one-at-a-time.

## Why this exists

Some FortiMonitor batch operations live only in the FortiMonitor web UI (per-port scope reconfiguration is the canonical example), and some are exposed cleanly in the v2 API (e.g., bulk fabric-connection creation) but the public CLIs require operators to paste fully-resolved resource URLs per device. Running either workflow against 80+ devices manually is not a reasonable ask of a human. This extension folds both classes of operation into a single launcher with a consistent Load → Review → Execute UX.

## Tools

| Tool | Auth | Status | Action |
|---|---|---|---|
| **Remove from Port Scope (Fabric)** | FortiMonitor session | Shipped (v0.1) | Batch-remove operationally-down WAN interfaces from monitored port scope on Fabric-connected FortiGate instances. Destructive - deletes agent resources and metric history per removed port. |
| **Add to Port Scope (Fabric)** | FortiMonitor session | Shipped (v0.2) | Inverse of Remove - batch-add currently-unmonitored interfaces to port scope. Non-destructive. |
| **Add Fabric Connection (API)** | FortiMonitor v2 API key | Shipped (v1.0) | Bulk-create OnSight CSF tunnel connections for FortiGate devices via `POST /v2/fabric_connection`. Resource pickers (OnSight, server group, optional appliance group) populate from the API. Requires an RW API key - paste once in popup → ⚙ Settings. |
| **Manage Server Attributes (Bulk)** | FortiMonitor v2 API key | Shipped (v0.5) | Bulk-set or remove attribute key/value pairs across many servers via `POST`/`DELETE /v2/server/{id}/server_attribute`. Paste a list of server names or IDs, pick an attribute type, preview per-row plan (add / replace / skip / error), then execute. Uses the same RW API key as Add Fabric Connection. |
| **Server ID Lookup** | FortiMonitor v2 API key | Shipped (v0.7) | Resolve a list of server names (or instance URLs, or numeric IDs) to canonical FortiMonitor server IDs. Exports CSV. Read-only. Acts as a **sender** for the cross-tool *Send selection to* handoff. Uses the same RW API key as Add Fabric Connection. |
| **Manage Server Templates (Bulk)** | FortiMonitor v2 API key | Shipped (v1.0) | Bulk-attach or detach monitoring templates across many servers via `POST`/`DELETE /v2/server/{id}/template`. Attach mode is non-destructive. Detach mode offers two strategies: `dissociate` (keep metrics the template seeded) and `delete` (wipe metrics and attributes the template seeded - **destructive, no undo**). Destructive detach and large batches (>10 servers) require a typed-confirmation phrase. Acts as a **receiver** for the cross-tool *Send selection to* handoff. Uses the same RW API key as Add Fabric Connection. |
| **Ask AI** | FortiMonitor v2 API key + AI provider credentials | Shipped (v1.0) | In-plugin chat with tool use against a curated set of read-only FortiMonitor v2 endpoints (servers, outages, agent resources, fabric connections, templates, server groups) plus a single gated write (`acknowledge_outage`). Provider is operator's choice in popup → ⚙ Settings: **Anthropic** (cloud, your API key, full 276-tool codegen catalog, prompt-caches tool definitions), **Ollama** (local, native `/api/chat`, no per-turn cost), or **LM Studio** (local, OpenAI-compat). Local providers must use a tool-capable model (Qwen 2.5+, Llama 3.1+, Mistral Nemo, Command R+, Qwen 3); Gemma and Llama 2 will not call tools. Shown by default; toggle off in popup → ⚙ Settings → Experimental tools to hide the tile. See [`docs/mcp-chat-prototype.md`](docs/mcp-chat-prototype.md) for scope and [`docs/ask-ai-local-providers.md`](docs/ask-ai-local-providers.md) for local-provider setup. |
| **Find Servers** | FortiMonitor v2 API key | Shipped (v1.0) · hidden by default | Pages the full `/v2/server` list and filters client-side by identifiers, attribute (built-in like Model / OS, or any customer-defined type), name, FQDN, tag, status, device type, active-outage state, or applied template. Pick the columns you want and export matches as CSV. Read-only. Acts as a **sender** for the cross-tool *Send selection to* handoff. Enable in popup → ⚙ Settings → Experimental tools → *Show Search Servers*. |

Click the extension's toolbar icon to open the launcher and pick a tool. Each tool opens its own full-tab UI with a Load → Review → Execute → Results flow (port-scope tools add a Queue step in the middle).

### Cross-tool handoff

Sender tools (Find Servers, Server ID Lookup) include row checkboxes plus a **Send selection to ▾** dropdown in their results bar. Picking a receiver writes the selection to `chrome.storage.session` (5-minute TTL), opens the receiver in a new tab, and the receiver consumes the blob on mount to prefill its entries. Receivers today: Manage Server Templates and Manage Server Attributes. Single-shot consume; back-button revisits do not duplicate prefills.

### Page-side augmentations (FortiMonitor web UI)

Separate from the launcher popup, the extension also injects UI directly into FortiMonitor pages the operator already has open:

- **`/report/ListServers`** ("All Instances"): adds **IP Address**, **DNS Name**, **Type**, **Model**, **Model #**, and **OS** sub-columns inside the existing Instance cell. Operators can reorder and hide/show sub-columns via a popup setting; preferences persist in `chrome.storage.local`.
- **Side nav (any FortiMonitor page)**: optional **FM Toolkit** entry that opens the launcher in an in-page overlay instead of the toolbar popup. Off by default; opt in via popup → ⚙ Settings → *FortiMonitor sidebar entry*.
- **Template Monitoring Config drawer**: skips the full-page reload after a metric edit by patching the open Vue drawer in place.

## Install (developer mode)

1. Clone this repository.
2. Open `chrome://extensions/`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select the `extension/` directory.
5. Log into [fortimonitor.forticloud.com](https://fortimonitor.forticloud.com) in any tab. The extension rides whatever session you already have.
6. Click the extension's toolbar icon to open the launcher.

See [`extension/README.md`](extension/README.md) for detailed install, tool, and testing notes.

## Architecture

```
extension/
  manifest.json
  src/
    popup/          - toolbar popup launcher
    background/     - service worker, tool-specific orchestration
    lib/            - shared infrastructure (FortiMonitor client,
                      queue, retry, concurrency, fingerprint,
                      DOM helpers, messaging)
    content/        - page-side augmentations (FM Toolkit sidebar
                      entry, ListServers sub-columns, Template
                      Monitoring Config drawer patch)
    ui/             - tool UI shells + per-step modules
                      ui/app.html    (port-scope tools)
                      ui/fabric-connection/app.html (Add Fabric Connection)
                      ui/attribute-management/app.html (Manage Server Attributes)
                      ui/template-management/app.html (Manage Server Templates)
                      ui/server-lookup/app.html (Server ID Lookup)
                      ui/ask-claude/app.html (Ask AI)
                      ui/server-search/app.html (Find Servers)
  tests/            - Node test runner unit tests

docs/
  api-discovery/    - captured FortiMonitor internal API contracts
  mockups/          - static HTML mockups for tool flows + augmentations
  harnesses/        - synthetic HTML fixtures used during dev verification
  live-e2e-runbook.md       - operator walkthrough for live API tests
  playwright-e2e-runbook.md - Playwright e2e suite walkthrough
```

## Scope guardrails

- **Per-tool auth choice.** Tools whose capability is UI-only (port-scope) ride the FortiMonitor browser session. Tools whose capability has a clean v2 endpoint (fabric_connection) use a user-supplied RW API key. Neither auth model leaks across tools.
- **Dry-run is the default** for every batch. Write-capable tools require a typed confirmation phrase before live writes.
- **`fortilink`** (fabric link) is visually flagged across every port-scope tool - it's protected by name.
- **Port-scope tools assume Fabric-connected FortiGate instances.** Add Fabric Connection itself onboards FortiGates that aren't yet under a fabric, so it has no such constraint.

## Development

```bash
cd extension
npm test    # runs the full unit-test suite via Node's built-in test runner
```

No `npm install` required - the only `devDependencies` the tests use ship with Node.

## Contributing

This is currently a personal project. Issues and suggestions are welcome via GitHub Issues.

## About the Developer

Built by **Gregori Jenkins** - originally from Chicago, a humble student of Computer Science, and a proud cat dad.

[Connect on LinkedIn](https://www.linkedin.com/in/gregorijenkins)
