# Mockups

Static HTML mockups for the FortiMonitor Port Scope Cleanup browser plugin (FMN-35 / FMN-38).

## Reference scenario

Based on a real production FortiGate screenshot provided 2026-04-16, showing 16 interfaces with a mix of:

- Named aliases: `DATA`, `GUEST`, `MGMT`, `VoIP`, `(Comcast Business)`, `wan2`
- Interface codes: `port1`–`port6`
- Letters: `a`, `b`
- Special types: `fortilink` (fabric link), `modem`

The reference device shows populated `admin_status` and `oper_status` values (`"up"` / `"down"`), unlike the VM test devices (FGVM01TM24006844/45/46) which return `"Unknown"`.

## Design assumptions locked in

1. **Data source:** `GET /onboarding/getDevicePorts?server_id={id}` (session-cookie auth, session-authenticated internal UI endpoint — not the public v2 API).
2. **Status values:** lowercase `"up"` / `"down"` on production devices; `"Unknown"` on devices without interface telemetry. Compare case-insensitively.
3. **Selection UX model:** user-driven — the plugin reports all interfaces with status, the user picks which to deselect. No reliable programmatic way to identify "WAN" interfaces across custom naming schemes.
4. **Pre-selection:** none by default. Optional "Quick select" convenience actions (e.g., "select all oper=down") that the user can trigger explicitly. `fortilink` should never be pre-selected even under bulk rules — it's the fabric link.
5. **Dry-run is default.** User explicitly opts out to write.
6. **Destructive warning is prominent.** Deselecting a port deletes its agent_resources and metric history (per FMN-34).

## Files

| File | Step | Purpose |
|---|---|---|
| `flow-prototype.html` | — | Clickable walk-through that loads each step in an iframe. Open this first. |
| `batch-start.html` | 1 | CSV upload + validation; kicks off the batch |
| `interface-report.html` | 2 | Per-group review; operator marks WAN rows; one prompt per fingerprint |
| `queue-overview.html` | 3 | Audit all staged changes; dry-run + typed confirmation gate; verbose-mode toggle |
| `execution-progress.html` | 4 | Live per-device status, retry failed, concurrency-capped |
| `results.html` | — | Post-execution report, downloadable CSV/JSON, retry-all-failures |
| `preview-app.html` | — | Loads the real Phase 4 step modules with chrome APIs stubbed — routable via `?step=start|review|queue|execute-dryrun|execute-live|results-partial|results-success`. Must be served over HTTP (`python3 -m http.server` at repo root) because Chrome blocks ES module imports across `file://`. |
| `launcher-popup.html` | — | FMN-40 launcher mockup. Chrome toolbar popup (360px) showing the tool list, session-status strip, and search filter. Shows three variants: default / session-missing / search-active. |
| `tool-add-port-scope_load.html` | 1 | FMN-40 Add tool — CSV upload. Structurally identical to the Remove tool's Step 1; only the title-bar name changes. |
| `tool-add-port-scope_review.html` | 2 | FMN-40 Add tool — group review. New "In Scope" column; default filter hides in-scope ports; green accent; "ADD" row tag; informational banner replaces destructive banner. |
| `tool-add-port-scope_queue.html` | 3 | FMN-40 Add tool — queue audit. Green "Ready to execute" panel replaces the destructive-confirmation gate; no typed-confirmation input (non-destructive); dry-run still defaults ON. |
| `tool-add-port-scope_execute.html` | 4 | FMN-40 Add tool — execution progress. "Will add" / "Added" action labels; "Ports added" metric in green; everything else matches Remove tool's execute screen. |
| `tool-add-port-scope_results.html` | — | FMN-40 Add tool — results/report. "Ports added" metric; non-irreversible audit copy; "Retry all failures" is a secondary (not danger-red) button. |

## Scope boundary (reaffirmed)

This plugin is frontend-only. No v2 public API calls, no API-key auth, no credentials beyond the FortiMonitor browser session. See the project memory file `no_fortimonitor_api.md` for the guardrail rationale.
