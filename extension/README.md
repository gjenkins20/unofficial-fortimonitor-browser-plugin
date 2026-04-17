# Unofficial FortiMonitor Toolkit

Chrome Manifest V3 extension — a suite of session-authenticated tools for FortiCloud. Rides your existing FortiCloud browser session; no API keys, no separate credentials.

Clicking the toolbar icon opens a launcher popup; pick a tool from the list and it opens in a full browser tab.

## Tools

| Tool | Status | Notes |
|---|---|---|
| Remove from Port Scope (Fabric) | ✅ Shipped (v0.1) | Batch-remove operationally-down WAN interfaces from monitored port scope on Fabric-connected FortiGate instances. Destructive — destroys agent resources and metric history per port removed. |
| Add to Port Scope (Fabric) | 🚧 In development (FMN-40) | Inverse of Remove. Batch-add currently-unmonitored interfaces to port scope on Fabric-connected FortiGate instances. Non-destructive. |

## Install (developer mode)

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` directory inside this repo
5. Log in to FortiCloud in any tab — the extension rides whatever session you already have
6. Click the toolbar icon to open the launcher

## Run tests

```
cd extension
npm test
```

Uses Node's built-in `node:test` runner — no `npm install` required.

## Scope guardrails

- Frontend-only. No FortiMonitor v2 public API, no API keys.
- Each tool declares its own action scope (e.g., Remove targets WAN interfaces; Add targets out-of-scope ports).
- Dry-run is the default for every batch.
- Destructive tools require a typed confirmation phrase before writes.
- `fortilink` is visually flagged as the fabric link across every tool.

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
