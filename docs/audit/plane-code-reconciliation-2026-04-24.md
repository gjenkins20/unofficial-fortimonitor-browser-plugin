# Plane ↔ Codebase Reconciliation — 2026-04-24

Audit of every "Done" plugin ticket in the Plane FortiMonitor project (FMN), checked against `main` at `5ac7fb9`. Schema-discovery tickets (FMN-1 through FMN-33) live in a different repo and are out of scope.

## Summary

| Bucket | Count |
|---|---|
| ✅ Verified intact on main | 31 |
| ⚠️ Done in Plane, no code expected (investigation / external) | 1 |
| 🔻 Work exists but is orphaned off main | 0 (FMN-72/73/75 are Backlog, not Done — see Recovery section) |
| 🔻 Done in Plane, code missing on main | 0 |

**No Plane Done ticket has missing code on main.** The user-perceived loss was on three Backlog tickets (FMN-72, FMN-73, FMN-75) whose work was committed to feature branches that got deleted by a `git reset --hard github/main` on 2026-04-23 09:33:25. Those commits are now restored to local branches `feature/fmn-72-73-column-reorder` (commit `49aed1e`) and `feature/fmn-75-instance-type-column` (commit `6383f5c`) and ready to drive through PR.

## Plugin Done tickets

| Ticket | Plane state | Primary commit(s) | Deliverable | Verified |
|---|---|---|---|---|
| FMN-34 | Done | (investigation, no code) | Confirmed v2 API can't do per-port scope; established session-auth approach | ✅ Captured in CLAUDE.md "Key Technical Findings" |
| FMN-35 | Done | `ae65afc`, `9e9ce09`, `fa65b06` | Initial Chrome extension scaffold + core libs | ✅ `extension/` exists; service-worker.js, message-handlers.js present |
| FMN-36 | Done | (docs commits) | Port-scope API contract captured | ✅ `docs/api-discovery/port-scope.md` + `port-scope-snippet.js` present |
| FMN-37 | Done | (docs/code) | Port operational status data source | ✅ `getDevicePorts` consumed in scanner; port status used in queue UI |
| FMN-38 | Done | `3e5c74e`, `88f7912`, `0f05ef2` | UX mockups for port-scope cleanup + launcher | ✅ `docs/mockups/` has all five screens + launcher mockup |
| FMN-39 | Done | `ae65afc`…`c1e32fc` (Phases 1-5b) | MV3 extension implementation | ✅ Manifest V3, service-worker.js, popup.html, app.html all in place |
| FMN-40 | Done | `0a23fc1`, `2f94c40`, `e32f8a3`, `3acde1b` | Multi-tool launcher + suite rebrand + Add-to-Port-Scope tool | ✅ Launcher popup carries port-scope `add` + `remove` cards; "(Fabric)" suffix present (popup.html:41,57) |
| FMN-41 | Done | `3c55166` | Author attribution; first GitHub push | ✅ README has author attribution; repo on github |
| FMN-44 | Done | `7e8dbe1` | Drop +/− icons and Removes/Adds badges from popup | ✅ popup.html has no `+`/`−` glyphs in card markup |
| FMN-45 | Done | `c1f6dfe`, `a4f40cf`, `96237c0` | Add Fabric Connection (Bulk) v2 API tool | ✅ `extension/src/ui/fabric-connection/`, `fabric-connection-handlers.js`; "[Beta]" tag in popup.html:75 |
| FMN-47 | Done | `c06f39d` | Tenant auth + developer mode + 0.4.0 bump | ✅ `lib/settings.js` exposes `fm:devMode`; popup ⚙ Settings panel renders dev-mode toggle |
| FMN-48 | Done | `ef7ba9c` | Manage Server Attributes (Bulk) v2 API | ✅ `extension/src/ui/attribute-management/`, `attribute-handlers.js`; popup.html:135 |
| FMN-49 | Done | `8d4d28d`, `48cdc29`, `db5541e` | Manage Server Templates (Bulk) v2 API | ✅ `extension/src/ui/template-management/`, `template-handlers.js`; popup.html:178 |
| FMN-50 | Done | `7b8d137`, `bc11854` | Server Name → ID Lookup tool | ✅ `extension/src/ui/server-lookup/`, `server-lookup-handlers.js`; popup.html:95 |
| FMN-53 | Done | `3e9f5ae`, `6020bbd`, `0a4c1ce` | Ask Claude prototype gated by experimental toggle | ✅ `extension/src/ui/ask-claude/`, `claude-chat-handlers.js`; `fm:askClaudeEnabled` toggle in lib/settings.js |
| FMN-54 | Done | `55d56fe` | Port-scope queue edit-link routes to last group bug fix | ✅ Queue/edit routing logic present; bug-fix commit landed on main |
| FMN-55 | Done | `11c238b` | Show server names in port-scope flows | ✅ Name resolution wired through scan + queue; CSV columns include server name |
| FMN-56 | Done | `cd98954` | Signal review groups can be edited later in step 3 | ✅ Step-2 review UI carries the "editable later" affordance |
| FMN-58 | Done | `ac4f7c3` | Port-scope step 1 progress indicator | ✅ `scan:progress` event emitted from message-handlers.js:27; UI consumes it |
| FMN-59 | Done | `7508b4e` | FortiCloud → FortiMonitor terminology rename | ✅ Repo-wide rename present; popup.html and docs use "FortiMonitor" |
| FMN-60 | Done | `ac4f7c3` (combined with FMN-58) | Step-2 review groups: downloadable audit CSV | ✅ CSV download wired in step-2 review UI |
| FMN-61 | Done | `d0da9ea` | Auto-resolve device names during scan | ✅ Scan parallelizes name resolution (message-handlers.js:27 dual fetch) |
| FMN-62 | Done | `640a279` | Capture session-auth endpoint returning server metadata | ✅ `docs/api-discovery/server-metadata.md` + `server-metadata-snippet.js` present |
| FMN-63 | Done | `38613c0` | Queue CSV shows kept port names instead of indices | ✅ CSV builder uses port names |
| FMN-64 | Done | `eb2bf1c`, `0ec9b91` | Step-2 audit CSV: summary + per-group detail; split proposed_action vs operator_decision | ✅ Audit CSV format updated |
| FMN-65 | Done | `9613e4d`, `e6d61da`, `c48cdf5` | Search Servers tool — free-text → attribute filter; built-in attribute discovery | ✅ `extension/src/ui/server-search/`, `server-search-handlers.js`; popup.html:113 (gated by `fm:serverSearchEnabled`, default OFF) |
| FMN-66 | Done | `96b74d2` | Ask Claude graduate from prototype + polish | ✅ `fm:askClaudeEnabled` defaults to ON in lib/settings.js (was OFF in FMN-53) |
| FMN-67 | Done | `cc2e273` | Remove tool-icon boxes from popup tool list | ✅ popup.html cards no longer wrap icons in boxes |
| FMN-69 | Done | `c4a6219`, `bf38689` | WebGUI augmentation framework + FM Toolkit sidebar launcher | ✅ `extension/src/content/augment.js` (~500 lines); `toolkit-launcher` augmentation; manifest content_scripts entry; web_accessible_resources entry for popup.html |
| FMN-71 | Done | `269c38a` | IP Address + DNS Name sub-columns on Instances list | ✅ `instances-ip-dns-columns` augmentation in augment.js; `/report/get_idp_data` consumed; sub-column grid pattern (no sibling cells) per CLAUDE.md DataTables rule |
| FMN-77 | Done | (no code commit) | Investigation: FMN-71 IP/DNS regression report against FMN-72 feature branch | ⚠️ Investigation output lives in Plane only. Now references a deleted branch — needs follow-up comment after FMN-72/73 PR lands |

## Backlog tickets with orphaned-but-recovered work

These are **not Done in Plane**. The work product was committed locally and lost when the feature branches were deleted. Commits are restored to recreated branches as of 2026-04-24:

| Ticket | Plane state | Dangling commit | Recovered to | Lines | Files |
|---|---|---|---|---|---|
| FMN-72 + FMN-73 | Backlog | `11a2089` (code) + `49aed1e` (mockups + harnesses) | `feature/fmn-72-73-column-reorder` | 972 + 1286 | `extension/src/lib/column-order.js` (new), `extension/tests/column-order.test.js` (new, 242 tests), `augment.js` (+324), `popup.{html,js,css}` (+295), `docs/harnesses/instances-list.html` (new), `docs/harnesses/popup-settings.html` (new), `docs/mockups/column-settings_interactive.html` (new) |
| FMN-75 | Backlog | `6383f5c` | `feature/fmn-75-instance-type-column` | 278 | `augment.js` (+47), `column-order.js` (+1), `column-order.test.js` (+14, total 370 tests), `docs/harnesses/instances-type-column.html` (new) |

## Backlog tickets that are post-recovery follow-ups

These were created during the FMN-71/72 work cycle and remain Backlog independent of the recovery:

- **FMN-73** — User-hideable columns in WebGUI augmentation (delivered as part of FMN-72 commit; treat as same work unit)
- **FMN-74** — Cancelled (replace tables with third-party library investigation)
- **FMN-76** — Backlog (Model + OS columns on /report/ListServers)
- **FMN-70** — Backlog (full WebGUI takeover, distinct from augmentation)

## Cancelled tickets (no code expected)

FMN-43, FMN-52, FMN-57, FMN-68, FMN-74 — investigated and decided against. No code expected on main; verified none present.

## Root-cause notes (Phase 3 of plan)

`git reflog` shows the destructive sequence at 2026-04-23 09:33:25 PDT was `git checkout main` immediately followed by `git reset --hard github/main` (or `git pull --hard`). The branches `feature/fmn-72-column-reorder-show-hide` and `feature/fmn-75-instance-type-column` are no longer in `git branch -a`, indicating they were deleted in the same cleanup pass. Whether the operator or a Claude session initiated this is not recorded in reflog.

The recovered branches `feature/fmn-72-73-column-reorder` and `feature/fmn-75-instance-type-column` now hold the dangling commits and are no longer subject to garbage collection.
