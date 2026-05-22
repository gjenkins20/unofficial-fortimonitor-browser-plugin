# Changelog

All notable changes to the Unofficial FortiMonitor Toolkit are tracked here.
Each release section maps to a `v<version>` git tag on `github/main` and to
the `version` field in `extension/manifest.json` at that tag.

Versioning follows semver with this convention:

| Bump | When |
|------|------|
| **patch** (`x.y.Z`) | Bug fix, copy change, doc-only, internal refactor with no operator-visible change |
| **minor** (`x.Y.0`) | New tool, new augmentation, new settings, new visible feature |
| **major** (`X.0.0`) | Changes that require re-Load Unpacked, new permissions, or otherwise alter install steps |

The "Unreleased" section accumulates work in flight; at merge time it is
renamed to the new version section and a fresh "Unreleased" header takes its
place.

## Unreleased

- FMN-240: Introduction to FortiMonitor tour - sidebar-add / sidebar-collapse step cards no longer render below the viewport. `positionCard` in `step-renderer.js` now clamps the card so its bottom edge stays inside the viewport when the anchor is near the bottom (previously the card's body + Next button were clipped off-screen). Tour also promoted out of Beta: the `(Beta)` suffix is removed from the Settings label and the popup tile's badge, `isIntroTourEnabled()` defaults to true (FMN-167's default-off was the stub-era posture; FMN-240 flips it now that the tour is operator-verified), and explicit-false in `chrome.storage.local` still suppresses the tile. **One-time migration** clears any Beta-era explicit-`false` on first read after upgrade so operators who toggled the tour off during Beta (or who landed in explicit-false via the on→off toggle sequence) get the un-Beta'd default-on without needing to flip the Settings toggle themselves; a `fm:introTourFmn240Migrated` marker prevents the migration from ever re-clearing a post-FMN-240 explicit opt-out.

## v1.8.1 - 2026-05-21

- FMN-238: `FortimonitorClient.deleteServerOrTemplate(id)` ships. Wraps the session-auth `POST /config/deleteServer` endpoint with `server_id={id}` body (no XSRF). Endpoint captured live via operator-paired UI capture during FMN-228 cleanup; same endpoint handles both servers and templates because they share the s-{id} namespace. v2 has no DELETE for `/server_template` (405); this is the only programmatic path. Unblocks FMN-237 (Toolkit rollback). Full wire details + cross-tenant caveats in `docs/api-discovery/templates-delete.md`.

## v1.8.0 - 2026-05-21

Bulk Action Composer expansion, FMN-228 MPW fix, info-bubble + tour-framework polish.

- FMN-210: Preview-step pre-flight for current template attachments per device. Bulk Composer's Preview now renders the actual current templates in the Prev column (via a new `bulk-composer:list-template-names-batch` SW handler) instead of "(templates unknown)". Cached on `store.targets[i].template_names` so re-entry doesn't refetch. Summary count + Apply button label re-derive when the post-preflight willChange count shifts.
- FMN-162: Bulk Add to / Remove from Port Scope as new Bulk Action Composer actions. Session-auth writes via `POST /config/save_port_selection` (mirrors FMN-34/36). Configure step pre-fetches port lists across the picked fleet and renders a chip row of port names with frequency counts; chips toggle in/out of the operator's selection.
- FMN-225: Bulk auto-tag by name regex. Operator authors `{regex, tagTemplate}`; tag template references regex capture groups via `$1..$N`, `$&` (full match), `$$` (literal `$`). Live preview pane highlights the matched substring in each instance name and shows the resulting tag. Skips no-match rows + already-tagged rows. FMN-225 QA follow-up landed in the same batch: `device_type` PUT-rejection guard in `sanitizeServerBodyForPut()` (EC2-managed instances return `device_type="cloud_server"` on GET but PUT only accepts `server`/`network_device`); preview renders matches as soon as the regex is valid, before the tag template is filled.
- FMN-226: Bulk auto-set instance attributes by name regex. Sibling of FMN-225; writes to `server_attribute` rows. Customer-defined attribute types only (built-in `Model`/`OS` attributes live inline on `/v2/server` and never appear in the type catalog). Existing-different-value rows reported as conflicts and skipped (v1 doesn't overwrite).
- FMN-228: Optional MPW-authoring step in Profile + Create Templates. Each per-cluster template can be paired with a monitoring-policy workflow whose predicate matches the cluster's `(make, model)` and whose action attaches the new template; FortiMonitor's native auto-apply runs the workflow on future onboards. Reframed from FMN-202 (cancelled) after the operator's 2026-05-20 confirmation that MPWs auto-apply natively. FMN-228 QA fix landed alongside: `pick_multiple` for `device_type` clauses (was sending `pick_one`, which FortiMonitor's UI doesn't expose for that datatype); `match_value` is a JSON array for `pick_multiple`, not a string; the attribute clause now pulls the device's live `fortigate.model` value (e.g. `FGVMA6`) via a sample-device `listServerAttributes` fetch instead of using the cluster's `model_number` field (which is a different namespace).
- FMN-189: Info-bubble registry consolidation. `augment.js` no longer carries a 47-line inline copy of the content-surface entries; it loads `src/lib/info-bubble-registry.js` at runtime via `chrome.runtime.getURL` + dynamic `import()` (the same pattern intro-tour-bridge.js uses). Manifest grants web-accessible-resource on the module to FortiMonitor origins. Adding a new bubble entry now requires editing one file.
- FMN-188: Snapshot &amp; Diff info bubble anchors on the FMN-86 ribbon. `pointer-events: none` lifted on `.fmn-pa-card-ribbon` so the corner can receive hover; the existing rotated "FM Toolkit" strip is the visual affordance. Removed the `<h3>`-anchored icon workaround.
- FMN-190: Noise-analysis info bubble wired in the Tenant Observations viewer. `mountInfoBubbles(pane, { surface: 'popup' })` fires after every tab activation so the dormant registry entry finally renders.
- FMN-170: Set Parent Group bulk action. `PUT /v2/server/{id}` with `sanitizeServerBodyForPut()`. Configure step shows an alphabetically-sorted group dropdown + pre-fetches each picked instance's current parent so Preview's Prev column is accurate.
- FMN-171: Set Agent Resource Status bulk action. `PUT /v2/server/{id}/agent_resource/{id}` with a case-insensitive substring filter against `name | plugin_textkey | resource_textkey`. Empty filter rejected (foot-gun prevention). Per-resource failures surface in `failures[]` without aborting the run. Hidden by default behind `fm:showFortimonitorNativeBulkActions`.
- FMN-172: Schedule Maintenance Window bulk action. `POST /v2/maintenance_schedule` with shared-state memoization so one MW per run covers every selected instance (not one MW per target). Hidden by default behind `fm:showFortimonitorNativeBulkActions`.
- FMN-229: Tour framework extension for off-FortiMonitor checklist steps. `step_type: 'anchor' | 'checklist'` (backward-compat default `anchor`); new `'all-checked'` advance mode; per-step `checklist[]` with per-item `id + label + help`; `storageTier: 'session' | 'local'` opt on `runTour` for multi-day persistence. Existing intro-tour steps validate + render unchanged.
- FMN-168 (planning): OnSight Deployment Guide design doc at `docs/planning/onsight-deployment-tour-plan.md` + standalone visual harness at `docs/harnesses/fmn-168-onsight-checklist-demo.html`. Reuses the FMN-229 framework. Four follow-up tickets filed for the framework extension (FMN-229), content authoring (FMN-230), popup trigger (FMN-231), and live-validation hooks (FMN-232).
- FMN-227 (investigation): tenant configuration export/import feasibility catalog at `docs/planning/tenant-config-export-import-investigation.md`. 14 configuration classes catalogued with read/write paths, identity-rewrite requirements for replicate mode, restore-mode semantics, dependency order, and per-class gaps. Eight follow-up sub-tickets recommended.
- FMN-170/171/172 QA verdict (2026-05-21): hidden from the Bulk Action Composer's action picker by default - they duplicate FortiMonitor's own one-off UI without adding bulk-specific value. New `fm:showFortimonitorNativeBulkActions` Settings flag (default false) controls visibility; flip it on to expose them.
- FMN-228 E2E QA fix (2026-05-21): `PanoptaClient.createServerGroup()` now reads the `Location` header instead of expecting a JSON body. POST `/v2/server_group` returns 201 with an empty body; the previous "Malformed" guard tripped on every live run. Same family of bug as the FMN-206 PUT-stricter-than-GET findings - the live contract diverged from what the SDK pattern assumed and unit-test mocks masked it.

## v1.7.0 - 2026-05-14

- FMN-218: **Tenant Observations** (formerly "Best-Practice Assessment").
  Two changes shipped together. (1) De-prescribe: every analyzer's
  per-row `recommendation:` field is now a neutral observation
  (factual restatement of counts, ratios, gaps); the synthesized
  "Recommendations" tab is removed (its content duplicated the analyzer
  findings as imperatives); viewer column header "Recommendation" is now
  "Observation"; viewer is 10 tabs (was 11). (2) Rename: tool name +
  every directory + every file + every identifier + every storage key
  carried over from "Best-Practice Assessment" / "BPA" is renamed to
  "Tenant Observations" / `observations-*` / `tenant-observations-*`.
  Apply Best-Practice Fabric Templates bulk action renamed to **Apply
  Stock Fabric Templates**. Storage keys (`fm:bpaAuditEnabled`,
  `fm:bpaSnapshots`) are migrated with read-fallback + first-write
  cleanup, so operators who hid the tile pre-rename keep it hidden and
  existing snapshots survive. Two `LEGACY_*` constants in
  `settings.js` + `observations-snapshots.js` remain in place to drive
  the migration; they can be retired once operators have rolled forward.


  sections (Top Noisy Instances + Top Noisy Metrics + Recommendations).
  Replaces the prior FMN-156 v1 attempt at a standalone 12th tab, which
  duplicated the existing Noisy Metrics section operator QA found.
  Analyzer (`extension/src/lib/observation-analyzers/noise.js`) is a pure
  function over the inventory's existing outage list - no new v2 API
  traffic. Outage count, total duration, MTTR, flap rate per 24h, and
  per-row recommendation (raise warning threshold to P95, widen dwell
  time, suppress for maintenance windows) shown for the noisiest
  instances. Operator-visible by default once a Tenant Observations scan completes; no
  separate flag.
- FMN-154 (phase 1, behind flag): Deployment Snapshot &amp; Diff. New
  toolkit card on FortiMonitor's Canned Reports page
  (`/report/ListReports`), styled to match native `.pa-card` tiles and
  tagged with the FMN-86 attribution ribbon. "Take Snapshot" runs a Tenant Observations
  scan and persists a condensed result to `chrome.storage.local`
  (two-slot model: current + previous). "Open diff" launches a viewer
  that shows added / removed / modified servers between the two
  snapshots with field-level prev → next changes. The card includes a
  pre-click ETA (last run's duration as a gauge, or a 30s default for
  the first scan), a real progress bar driven by the Tenant Observations fetcher's
  endpoint-done events during the run, and an inline "safe to leave the
  page" reassurance. **Off by default** behind the new
  `fm:snapshotDiffEnabled` flag (FMN-129 per-tool gating pattern);
  toggle it on under popup &rarr; Settings &rarr; "Deployment Snapshot
  &amp; Diff (Beta)". Phase 2 (separate ticket) will add N-rotation,
  multi-tab diffs, and export.

## v1.2.0 - 2026-05-11

- FMN-160: FM TK Search now matches instances by their numeric ID. Paste an
  ID like `43859419` into the search bar and the matching instance appears
  with the `id` badge and an `#43859419` snippet. Exact-ID is the strongest
  signal (ranks just under name-exact); prefix matches also surface.

## v1.1.0 - 2026-05-11

- FMN-153: IP Address and DNS Name columns on `/report/ListServers` now
  walk the full `pageData.instance.fqdns[]` array and classify each entry
  by value (IPv4 / IPv6 / hostname), instead of reading only the scalar
  `pageData.instance.fqdn`. Surfaces real addresses that the prior code
  missed (e.g., instances whose primary fqdn is a label like "server"
  while a secondary entry carries the real IP).
- FMN-153: Universal search bar now classifies `fqdn + additional_fqdns`
  on ingest and tags results with `field: 'ip'` or `field: 'dns'`
  accurately, so the result snippet reads from the right list.

## v1.0.1 - 2026-05-11

- FMN-157: Popup version display now reads from `chrome.runtime.getManifest().version`
  instead of a hardcoded string, closing the drift seen between popup `v0.7.0`
  and manifest `1.0.0`.
- FMN-157: This `CHANGELOG.md` seeded.
- FMN-157: `v1.0.0` git tag created retroactively on `github/main` so future
  releases have a canonical predecessor reference.
- FMN-157: Persistent Dev Launcher generalized from
  `tools/dev/fmn-151-browser.mjs` to `tools/dev/launcher.mjs` (target URL via
  flag). Internal tooling; no operator-visible change.

## v1.0.0 - 2026-04-30

Inflection point. FMN-125 removed Beta flags from the shipping tool set,
marking the first non-prerelease version of the toolkit. Predecessor history
is not reconstructed in this file; see `git log` for the commits that landed
between project start (FMN-39 scaffolding) and this version.
