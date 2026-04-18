# Unofficial FortiMonitor Toolkit

A Chrome Manifest V3 browser extension that bundles batch operator tools for [FortiMonitor](https://www.fortinet.com/products/fortimonitor) (FortiCloud). Each tool picks the auth surface that matches the underlying capability: tools whose capability lives only in the FortiCloud web UI ride your existing browser session; tools whose capability is exposed cleanly in the v2 public API use a user-supplied RW API key.

**This project is not affiliated with, endorsed by, or associated with Fortinet.** It's an unofficial operator tool that automates batch tasks the FortiMonitor web UI exposes one-at-a-time.

## Why this exists

Some FortiMonitor batch operations live only in the FortiCloud UI (per-port scope reconfiguration is the canonical example), and some are exposed cleanly in the v2 API (e.g., bulk fabric-connection creation) but the public CLIs require operators to paste fully-resolved resource URLs per device. Running either workflow against 80+ devices manually is not a reasonable ask of a human. This extension folds both classes of operation into a single launcher with a consistent Load → Review → Execute UX.

## Tools

| Tool | Auth | Status | Action |
|---|---|---|---|
| **Remove from Port Scope (Fabric)** | FortiCloud session | Shipped (v0.1) | Batch-remove operationally-down WAN interfaces from monitored port scope on Fabric-connected FortiGate instances. Destructive — deletes agent resources and metric history per removed port. |
| **Add to Port Scope (Fabric)** | FortiCloud session | Shipped (v0.2) | Inverse of Remove — batch-add currently-unmonitored interfaces to port scope. Non-destructive. |
| **Add Fabric Connection (API)** | FortiMonitor v2 API key | Beta (v0.3) | Bulk-create OnSight CSF tunnel connections for FortiGate devices via `POST /v2/fabric_connection`. Resource pickers (OnSight, server group, optional appliance group) populate from the API. Requires an RW API key — paste once in popup → ⚙ Settings. **Marked Beta pending live-environment verification.** |
| **Manage Server Attributes (Bulk)** | FortiMonitor v2 API key | Beta (v0.5) | Bulk-set or remove attribute key/value pairs across many servers via `POST`/`DELETE /v2/server/{id}/server_attribute`. Paste a list of server names or IDs, pick an attribute type, preview per-row plan (add / replace / skip / error), then execute. Uses the same RW API key as Add Fabric Connection. **Marked Beta pending live-environment verification.** |
| **Manage Server Templates (Bulk)** | FortiMonitor v2 API key | Beta (v0.6) | Bulk-attach or detach monitoring templates across many servers via `POST`/`DELETE /v2/server/{id}/template`. Attach mode is non-destructive. Detach mode offers two strategies: `dissociate` (keep metrics the template seeded) and `delete` (wipe metrics and attributes the template seeded — **destructive, no undo**). Destructive detach and large batches (>10 servers) require a typed-confirmation phrase. Uses the same RW API key as Add Fabric Connection. **Marked Beta pending live-environment verification.** |
| **Ask Claude** | FortiMonitor v2 API key + Anthropic API key | Beta · Prototype (v0.7) · hidden by default | In-plugin Claude chat with tool use against a curated ~10-12 read-only FortiMonitor v2 endpoints (servers, outages, agent resources, fabric connections, templates, server groups) plus a single gated write (`acknowledge_outage`). Uses *your* Anthropic API key — cost exposure is direct, no rate limit. Prompt-caches the tool definitions. **Hidden by default** — enable in popup → ⚙ Settings → Experimental tools → *Show Ask Claude (prototype)*. See [`docs/mcp-chat-prototype.md`](docs/mcp-chat-prototype.md) for scope, tool subset, and expand/kill criteria. |

Click the extension's toolbar icon to open the launcher and pick a tool. Each tool opens its own full-tab UI with a Load → Review → Execute → Results flow (port-scope tools add a Queue step in the middle).

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
    popup/          — toolbar popup launcher
    background/     — service worker, tool-specific orchestration
    lib/            — shared infrastructure (FortiMonitor client,
                      queue, retry, concurrency, fingerprint,
                      DOM helpers, messaging)
    ui/             — tool UI shells + per-step modules
                      ui/app.html    (port-scope tools)
                      ui/fabric-connection/app.html (Add Fabric Connection)
                      ui/attribute-management/app.html (Manage Server Attributes)
                      ui/template-management/app.html (Manage Server Templates)
                      ui/ask-claude/app.html (Ask Claude — prototype)
  tests/            — Node test runner unit tests (165 tests)

docs/
  api-discovery/    — captured FortiMonitor internal API contracts
  mockups/          — static HTML mockups (FMN-38 + FMN-40)
  live-e2e-runbook.md — Phase 5 operator walkthrough
```

## Scope guardrails

- **Per-tool auth choice.** Tools whose capability is UI-only (port-scope) ride the FortiCloud browser session. Tools whose capability has a clean v2 endpoint (fabric_connection) use a user-supplied RW API key. Neither auth model leaks across tools.
- **Dry-run is the default** for every batch. Write-capable tools require a typed confirmation phrase before live writes.
- **`fortilink`** (fabric link) is visually flagged across every port-scope tool — it's protected by name.
- **Port-scope tools assume Fabric-connected FortiGate instances.** Add Fabric Connection itself onboards FortiGates that aren't yet under a fabric, so it has no such constraint.

## Development

```bash
cd extension
npm test    # runs the full unit-test suite via Node's built-in test runner
```

No `npm install` required — the only `devDependencies` the tests use ship with Node.

## Contributing

This is currently a personal project. Issues and suggestions are welcome via GitHub Issues.

## About the Developer

Built by **Gregori Jenkins** — originally from Chicago, a humble student of Computer Science, and a proud cat dad.

[Connect on LinkedIn](https://www.linkedin.com/in/gregorijenkins)
