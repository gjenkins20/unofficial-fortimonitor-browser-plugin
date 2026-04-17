# Unofficial FortiMonitor Toolkit

A Chrome Manifest V3 browser extension that bundles session-authenticated workflow tools for [FortiMonitor](https://www.fortinet.com/products/fortimonitor) (FortiCloud). The toolkit piggybacks on whatever FortiCloud session your browser already holds — no API keys, no separate credentials, nothing written outside the browser.

**This project is not affiliated with, endorsed by, or associated with Fortinet.** It's an unofficial operator tool that automates batch tasks the FortiMonitor web UI exposes one-at-a-time.

## Why this exists

FortiMonitor's v2 API does not expose per-port scope reconfiguration — that control only lives inside internal UI endpoints that require session-cookie auth. Running the same batch operation against 80+ devices through the web UI is not a reasonable ask of a human. This extension drives those internal endpoints from the operator's own authenticated session.

## Tools

| Tool | Status | Action |
|---|---|---|
| **Remove from Port Scope (Fabric)** | Shipped (v0.1) | Batch-remove operationally-down WAN interfaces from monitored port scope on Fabric-connected FortiGate instances. Destructive — deletes agent resources and metric history per removed port. |
| **Add to Port Scope (Fabric)** | Shipped (v0.2) | Inverse of Remove — batch-add currently-unmonitored interfaces to port scope. Non-destructive. |

Click the extension's toolbar icon to open the launcher and pick a tool. Each tool opens its own full-tab UI with a five-step Load → Review → Queue → Execute → Results flow.

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
    ui/             — tool UI shell + per-step modules
  tests/            — Node test runner unit tests (117 tests)

docs/
  api-discovery/    — captured FortiMonitor internal API contracts
  mockups/          — static HTML mockups (FMN-38 + FMN-40)
  live-e2e-runbook.md — Phase 5 operator walkthrough
```

## Scope guardrails

- **Frontend-only.** No FortiMonitor v2 public API, no API keys, no credentials beyond the browser session.
- **Dry-run is the default** for every batch. Destructive tools require a typed confirmation phrase before live writes.
- **`fortilink`** (fabric link) is visually flagged across every tool — it's protected by name.
- **Devices must be Fabric-connected FortiGate instances.** That's the scope the toolkit name advertises and the UI assumes.

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
