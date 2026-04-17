# FortiMonitor WAN Cleanup Extension

Chrome Manifest V3 extension that batch-removes operationally-down WAN interfaces from FortiMonitor port scope. Uses your existing FortiCloud browser session — no API keys, no separate credentials.

Scope is deliberately narrow: identify which interfaces on each device are WAN (the operator decides), confirm the cleanup in an audit gate, execute against many devices in the background.

## Install (developer mode)

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` directory inside this repo
5. Log in to FortiCloud in any tab — the extension rides whatever session you already have

The toolbar icon opens the cleanup app in a new tab.

## Run tests

```
cd extension
npm test
```

Uses Node's built-in `node:test` runner — no `npm install` required.

## Status

This is a phased scaffold. Current phase completion:

- [x] **Phase 1** — manifest, service-worker stub, empty app page, README, manifest tests
- [x] **Phase 2** — core libraries (`fortimonitor-client`, `fingerprint`, `queue`) + unit tests
- [x] **Phase 3** — orchestration (`concurrency`, `retry`, `scanner`, `executor`, `message-handlers`) + wired service worker
- [ ] **Phase 4** — UI port (the five operator screens from `docs/mockups/`)
- [ ] **Phase 5** — end-to-end testing against a live FortiGate device

See `docs/mockups/flow-prototype.html` for the operator walk-through, `docs/api-discovery/port-scope.md` for the API contract this plugin targets, and Plane FMN-39 for the implementation ticket.

## Scope guardrails

- Frontend-only. No FortiMonitor v2 public API, no API keys.
- WAN interfaces only. Non-WAN ports are never touched.
- Dry-run is the default for every batch. Real writes require a typed confirmation phrase.
- `fortilink` is protected by name.

## About the Developer

Built by **Gregori Jenkins** — originally from Chicago, a humble student of Computer Science, and a proud cat dad.

[Connect on LinkedIn](https://www.linkedin.com/in/gregorijenkins)
