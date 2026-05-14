# Tenant Observations per-section delivery — design

FMN-145 planning ticket (2026-05-04). Companion to FMN-133 (the Tenant Observations wizard) and FMN-135 (frontend session-auth fetcher).

Operator request: customers frequently want a single section (User Activity, Incident Summary, Templates) for an engagement and shouldn't have to wait for the full 11-tab crawl. We need a way to ask for one section, get just that one delivered, and keep the existing full-report flow intact for the all-of-it case.

This doc covers: which sections can be delivered standalone, what data each section actually depends on, the wizard UX, the result-staging shape, and what gets cut.

---

## 1. Section taxonomy

The 11 tabs split cleanly into two classes:

**Analyzer-scoped tabs.** Each is fed by exactly one analyzer plus a small, well-defined set of inventory keys. These are independently deliverable.

| Tab | Analyzer | Standalone-deliverable? |
|-----|----------|-------------------------|
| Incident Summary | `analyzeIncidents` | Yes |
| Incidents | `analyzeIncidents` | Yes (same data) |
| User Activity | `analyzeUsers` | Yes |
| Instance Analysis | `analyzeInstances` | Yes (deep-mode only) |
| Template Recommendations | `analyzeTemplates` | Yes |
| Monitoring Policy | `analyzeMonitoringPolicy` | Yes |

**Cross-cutting tabs.** Each touches 8-15 inventory keys spanning every fetcher domain. Cannot be delivered without the full crawl.

| Tab | Source | Standalone-deliverable? |
|-----|--------|-------------------------|
| Executive Summary | `buildExecutiveSummary` (synthesis) | No — needs servers + outages + users + groups + fabric + maintenance + ... |
| Feature Utilization | `buildFeatureUtilization` | No — needs every counted feature |
| Recommendations | `buildRecommendations` | No — touches contact_groups + compound + dem + snmp + status_pages + cloud + rotating + servers + outages + group_details + ... |
| Recommended Labs | `buildLabs` | No — same shape as Feature Utilization |
| Raw Counts | `buildRawCounts` | No — by definition needs all counts |

Implication: per-section delivery applies to the analyzer-scoped subset. The cross-cutting tabs only ship as part of a full-report run.

---

## 2. Section-to-data dependency map

Where a section is standalone-deliverable, the table lists exactly the v2 endpoints + frontend endpoints that feed its analyzer. Anything not listed is not needed for a single-section run.

### Incident Summary / Incidents

- v2: `/outage` (paged), `/outage_statistics?days=7|30|60`, `/outage/{id}/log` per active outage
- frontend: none
- analyzer: `analyzeIncidents`
- inventory keys consumed: `outages`, `outage_logs`, `outage_stats_7d`, `outage_stats_30d`, `outage_stats_60d`, `outages_recent`

Notes: `outages_recent` is currently a redundant re-page; can be elided in single-section mode.

### User Activity

- v2: `/user` (paged), `/contact` (only for join lookups; users embed `contact_info[].url`)
- frontend (always-on): `/users/users/get_edit_user_data?contact_id={id}` per user
- analyzer: `analyzeUsers`
- inventory keys consumed: `users`, `frontend_user_data`

Notes: `analyzeUsers` reads `users` and `frontend_user_data` only. Does not need `contacts` array directly. `contact_id` resolution is done from each user's embedded `contact_info[].url`.

### Instance Analysis

- v2: `/server` (paged), `/agent_resource_type` (cached), per-server `/server_resource` paginate, per-resource `/server_resource/{id}` detail
- frontend: none
- analyzer: `analyzeInstances`
- inventory keys consumed: `servers`, `server_resources`, `server_resource_details`, `agent_resource_types`

Notes: this is the most expensive section. Today it requires deep-mode (`/server_resource` per server + per-resource detail). Without deep-mode the analyzer returns `available: false`. A standalone Instance Analysis run implicitly enables deep-mode and inherits the existing `maxServers` cap.

### Template Recommendations

- v2: `/server_template` (paged), per-template `/server_template/{id}` detail, `/server_group/{id}` detail (for the "Default Monitoring Templates" group lookup that partitions stock vs custom)
- frontend (always-on): `/report/get_monitoring_config_data?server_id={tid}` per template
- analyzer: `analyzeTemplates`
- inventory keys consumed: `server_templates`, `server_template_details`, `server_group_details`, `template_monitoring_configs`

Notes: needs `server_group_details` for the stock-template partition (per CLAUDE.md). The full `/server_group` list is only needed to discover the "Default Monitoring Templates" group id — could be replaced by a name search to avoid paging the full list.

### Monitoring Policy

- v2: `/server` (paged), `/server_group` (paged) + per-group detail, `/server_template` (paged)
- frontend: none
- analyzer: `analyzeMonitoringPolicy`
- inventory keys consumed: `servers`, `server_groups`, `server_group_details`, `server_templates`

Notes: shares `server_group_details` with Template Recommendations and `servers` with Instance Analysis. Running both Monitoring Policy and Templates in one selection should not double-fetch.

---

## 3. Cross-section couplings

Three couplings worth surfacing because they affect both correctness and de-duplication:

1. **`server_group_details`** is consumed by `analyzeTemplates` (stock-template partition) and `analyzeMonitoringPolicy` (group → template mapping). Single-section runs need to fetch it once and share.
2. **`servers`** is consumed by Instance Analysis, Monitoring Policy, and almost every cross-cutting tab. For analyzer-scoped single-section runs that don't need it (User Activity, Incidents), skip it.
3. **`server_templates`** is consumed by both Templates and Monitoring Policy. Same caching consideration.

There are no analyzer-to-analyzer dependencies. The analyzers are pure functions over the inventory; any analyzer can run on a partial inventory as long as its required keys are populated.

---

## 4. Wizard UX

Two viable shapes. Recommendation: **B**, because it keeps the common case cheap and reads as "select one or more" rather than "opt out of everything you don't want."

### A. Per-section toggles, default-all-on

Every section toggle starts checked; operator unchecks the ones they don't want. Defaults preserve the current full-report behavior.

Pros: zero-click full report; the "deselect a few" path is fast.
Cons: when a customer asks for *just* the User Activity section, the operator has to uncheck five other things. The fast-path is still the slow-path.

### B. Default-all-on with a "single section" shortcut row

Configure step shows the existing controls (deep-mode toggle, max-servers) plus a row of section pills:

```
Sections: [All]  [Incidents]  [User Activity]  [Instances]  [Templates]  [Monitoring Policy]
```

Clicking `[All]` runs the full report (current behavior, default selection). Clicking any other pill runs that section only. Multi-select via shift-click for the "two of these" case.

Pros: most customer-engagement flows are "I just need X" — one click. The all-of-it flow is also one click and stays the default.
Cons: the multi-select case is slightly less discoverable than checkboxes. Acceptable: the multi-select case is rare.

### Cross-cutting tabs in single-section mode

When the operator picks a single analyzer-scoped section, the viewer should render only that section's tab (plus Raw Counts, since it's cheap synthesis from whatever inventory was collected). Other tabs hide rather than render empty. The PDF and ZIP exports include only what was rendered.

Rationale: rendering an empty Recommendations tab when the operator asked for User Activity is noise.

---

## 5. Result staging shape

Today, `tenant-observations-handlers.js` stages the entire `{ inventory, analysis }` blob in `chrome.storage.session` under `observations.lastRun`. The viewer reads it back as one chunk via `observations:get-run-result`.

For per-section runs, two changes:

1. The result blob is the same shape; only the populated keys change. `analysis.users` is present for a User Activity run; `analysis.incidents` is absent, not empty. The viewer's existing `analysis?.users?.details ?? []` pattern degrades to "no rows" — that's the right default for cross-cutting tabs that touched no data.

2. Add a `result.sections` array describing what was actually run:
   ```json
   { "sections": ["user-activity"], "deep": false, "max_servers": 0 }
   ```
   The viewer uses this to decide which tab buttons to render. Cross-cutting tabs are filtered out unless `sections` is `["all"]`.

No transport change. No new storage key. Same handle/staging dance as today.

---

## 6. Cancel semantics

Decision: **out of scope for this iteration.**

The "I started a full run, I only want the User Activity section right now, give me what's done and skip the rest" flow is real but it's a different problem (mid-run section delivery) from "I asked for one section, run only that" (pre-flight selection). Solving the second is straightforward; the first needs partial-result staging that survives an abort, which the ticket explicitly calls out as out-of-scope.

When the operator cancels a single-section run mid-flight, behavior matches today's full-run cancel: nothing is staged, viewer goes back to the start step. They re-trigger the section.

---

## 7. Implementation roadmap

Six follow-up tickets, sized to land independently. Each picks up where this planning ticket leaves off; none has a hard dependency on another beyond the section selector existing.

1. **Wizard section selector.** Add the pill row to the configure step; persist the selection on `store.sections`. Default to `["all"]`. Drives `payload.sections` in the `observations:run-audit` message.
2. **Selective fetcher.** `BpaFetcher.collectInventory({ sections })` takes the section selection and skips inventory keys that no requested section consumes (per the dep map in §2). Default behavior (`sections === ["all"]` or absent) unchanged.
3. **Selective frontend fetcher.** Same shape for `BpaFrontendFetcher`: only walk `get_edit_user_data` if User Activity is requested; only walk `get_monitoring_config_data` if Templates is requested.
4. **Selective analyzer dispatch.** `runAllAnalyzers` accepts a `sections` filter and runs only the requested analyzers. Skipped analyzers' result keys are absent (not empty) — important for the viewer's tab-filtering logic.
5. **Viewer tab filter.** When `result.sections` does not include `"all"`, hide cross-cutting tab buttons and any analyzer-scoped tab whose section wasn't requested. Raw Counts surfaces what was actually fetched.
6. **End-to-end test fixtures.** Synthetic harness fixtures for two single-section runs (User Activity-only, Incidents-only) and a multi-select run (Templates + Monitoring Policy). Cover the no-double-fetch coupling on `server_group_details` and `server_templates`.

Each follow-up ticket should be filed when the previous one is in QA, not all up front. Six tickets up front would invite premature optimization on couplings we haven't observed yet.

---

## What this design does not change

- v2 API client and origin resolver: untouched.
- Analyzer interfaces: still pure functions over inventory; no IO injection.
- CSV / ZIP / PDF export shape: same `TABS` model, same `csvCellValue`. Empty tabs render with their `emptyText` hint or are filtered by §5.
- Storage transport: same `observations.lastRun` key, same handle dance.

The whole change is scoping (which endpoints to skip) and surfacing (which tabs to render). No new infrastructure.
