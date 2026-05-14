# Network Quality (VoIP-adjacent) Report — design proposal

FMN-166 planning document. Companion to `docs/api-discovery/voip.md`.

This document proposes a toolkit feature to surface FortiMonitor's
**Network Quality** plugin (`resource.icmp`) as a per-site rollup report.
The discovery doc establishes that FortiMonitor has no real VoIP / SIP /
RTP data — only synthetic MOS plus latency / jitter / packet-loss derived
from ICMP probes. The report should be framed honestly around that, not
around "VoIP".

## 1. Naming

The ticket title says "VoIP reports", but VoIP is not what FortiMonitor
exposes. The proposed name for the operator-facing surface is
**Network Quality Report** (matching the FortiMonitor category name
`Network Quality` / `network.quality`). The toolkit tile copy can say
"Network Quality (ICMP-derived MOS, latency, jitter, packet loss). FortiMonitor
does not measure SIP / RTP directly." once on the tile and once at the
top of the report.

If the operator strongly wants the word "VoIP" in the entry point, the
fallback name is **VoIP Quality (ICMP-derived) Report** — explicit-and-honest.

## 2. Questions the report must answer

The four questions in the ticket body are good. Lightly refined:

| Question                                                                                  | Answerable from this tenant? | Notes |
|-------------------------------------------------------------------------------------------|------------------------------|-------|
| Which instances had MOS < 4.0 in the last 24h?                                            | Yes (via `/v2/outage` description-match on `MOS from ...` outages) | Cheaper than time-series — uses existing outage records. |
| Which instances had jitter > 30ms?                                                        | Partial — only when a threshold-driven outage was raised | Otherwise needs a time-series fetch. |
| Top N instances by RTP packet loss in the last 7d                                          | Reword as "ICMP packet loss". Yes — same outage-description path. |
| Instances with at least one SIP-registration failure in the last 24h                      | **No.** There is no SIP data on the platform. | This question drops out of the report. |

A fifth question is worth adding because it's free from the existing data:

5. **Which instances have Network Quality monitoring configured, and which
   are missing MOS?** Inventory question; resolves immediately from
   `agent_resource_type` joined to `agent_resource`. Useful as a "set up
   the rest of these to get a complete picture" prompt.

A sixth, lower-priority:

6. **Which Network Quality outages are still active right now?** Inventory
   join against `/v2/outage` filtered to non-`resolved` status + description
   matches one of the four NQ metric labels.

The report's primary view answers 1, 3, 5, and 6. Question 2 (raw jitter
threshold) requires a follow-up ticket to capture FortiMonitor's
session-auth metric-data endpoint.

## 3. Chosen surface

**Recommendation: Canned Reports card** (mirrors FMN-154 pattern).

Three options considered:

### Option A — New popup tool tile (rejected as primary)

Pros: full standalone wizard, no DOM augmentation of FortiMonitor's reports
page, CSV export trivially supported.

Cons: discoverability is poor for a feature that is conceptually
"a missing canned report". Operators look for canned reports on the
Reports page, not in a separate tool tray.

### Option B — Canned Reports card on `/report/ListReports` (recommended)

Pros: same surface FortiMonitor uses for its own 19 reports. Operators
who go looking for a Network Quality report look exactly here. FMN-154
already established the augmentation pattern (card injected into the
`<pa-card>` grid with FM Toolkit ribbon). The discovery confirmed
`/report/ListReports` is the canonical landing page. The card opens an
extension-served result page (same model as FMN-154's Tenant Observations viewer).

Cons: the augmentation is sensitive to FortiMonitor's Reports-page DOM
shifting (FMN-154 already has guards for this).

### Option C — Augment of an existing FortiMonitor page (rejected)

Considered: inject a "Network Quality" tab into the per-instance Instance
Detail Page. Too coupled to FortiMonitor's tab structure; the
existing Network Quality category in `monitoring_config` already covers the
per-instance case adequately. The toolkit's value-add is the
**cross-instance** rollup that FortiMonitor doesn't ship.

### Decision

**Option B.** The tile renders on `/report/ListReports` alongside the
existing 19 cards, styled `pa-card` with the FM Toolkit ribbon. Clicking it
opens an extension-served result page (`chrome-extension://.../src/ui/voip-report/`)
that renders the report.

The card subtitle reads: *"ICMP-derived. FortiMonitor does not measure SIP / RTP directly."*

## 4. Data model

### Inputs

| Source                                                          | Auth          | Notes                                                                       |
|-----------------------------------------------------------------|---------------|-----------------------------------------------------------------------------|
| `GET /v2/server?limit=200` (paged)                              | v2 API key    | Instance inventory. Same paging as tenant-observations fetcher.                            |
| `GET /v2/server/{id}/agent_resource?limit=200` per server       | v2 API key    | Per-instance NQ metric inventory. Filter to `resource_textkey` ∈ {icmp.latency, icmp.jitter, icmp.packet_loss, icmp.mos}. |
| `GET /v2/outage?limit=200` (paged) plus `?status=active` filter | v2 API key    | Recent + active NQ outages, joined on `description.startsWith('Latency/Jitter/Packet Loss/MOS from ')`. |
| `GET /v2/outage_statistics?days=7`                              | v2 API key    | Per-server outage counts in window. Used for "top 10 noisiest NQ sites" ranking. |
| `GET /v2/server_template/{id}` per unique template URL          | v2 API key    | Template name for the "configured by template X" grouping. Cache by template URL. |

All wrapper keys follow `<resource>_list` (project memory
`fortimonitor_v2_list_wrapper_keys.md`).

### Per-row computation

The report's primary table is **one row per (server, NQ metric)**. Schematic:

```
row = {
  server_id,
  server_name,
  fqdn,                                  // primary, from /v2/server.fqdn
  metric,                                // one of: Latency, Jitter, Packet Loss, MOS
  metric_textkey,                        // icmp.latency, etc.
  monitoring_location_name,              // resolved from /v2/server/{monloc_id}.name
  template_name,                         // resolved from /v2/server_template/{tid}.name
  frequency_seconds,                     // from agent_resource.frequency
  has_threshold,                         // bool: agent_resource.thresholds.length > 0
  recent_outage_count_7d,                // join on /v2/outage where description matches "{metric} from ..."
  recent_outage_count_24h,               // same, restricted to 24h
  has_active_outage,                     // bool, joined on /v2/outage with status != 'resolved'
  active_outage_severity,                // 'critical' / 'warning' / null
  active_outage_start_time               // RFC-2822 from outage
}
```

### Aggregations / pre-computed views

Above the row table, three summary panels:

1. **Coverage summary**: "X of Y instances configured for Network Quality.
   Z of those include MOS." Single line.
2. **Top N noisy instances (last 7d)**: top 10 by `recent_outage_count_7d`
   summed across the four NQ metrics for that instance. Bar list with
   per-metric breakdown on hover.
3. **Active Network Quality outages**: a small table of rows with
   `has_active_outage === true`, sorted by severity then start_time.

### Aggregation window

Default 7 days, with a 24h toggle. No time-series data is fetched (per
discovery, v2 has no time-series endpoint). The signal is outage-record
density and active-outage state. A second tab — **Raw inventory** —
shows the per-row table for operators who want to see the configuration,
not just the recent incidents.

### Caching / freshness

The report is computed on demand. No background scan. Same model as the
existing Tenant Observations viewer — operator clicks the card, sees a "fetching..."
state, gets the rendered report within ~5-15 seconds for a tenant with
64 servers. Concurrency cap = 3 (same as FMN-61's name resolution).

### Subset by site / group

Phase 1 surfaces all instances. Phase 2 (follow-up) layers in
omni-search-corpus-based instance filtering (FMN-152), so the operator
can scope to a specific site / customer / tag.

## 5. User-facing copy

### Card on /report/ListReports

- **Title**: Network Quality Report
- **Subtitle / lead**: ICMP-derived MOS, latency, jitter, packet loss across
  all monitored instances. FortiMonitor does not measure SIP / RTP directly.
- **CTA button**: Open Report
- **Ribbon**: FM Toolkit (same orange / blue ribbon as FMN-154 cards)

### Report-page header

```
NETWORK QUALITY REPORT
ICMP-derived. 18 of 64 instances configured for Network Quality (9 include MOS).
Window: Last 7 days  [24h] [7d] [30d]
```

### Empty / disabled-feature copy

If the tenant has zero NQ-configured instances:

> No instances on this tenant are configured for Network Quality monitoring.
> Add the Network Quality template to instances you want ICMP-derived
> MOS / latency / jitter / packet-loss tracking for.

If the tenant has NQ but no MOS-equipped instances:

> No instances on this tenant include the MOS metric. MOS is an optional
> add to the Network Quality plugin and is enabled per-template. Re-edit
> the relevant templates to include MOS if needed.

## 6. ASCII mockup

```
 +--------------------------------------------------------------------------------------+
 | FortiMonitor > Reports > Network Quality Report                                      |
 +--------------------------------------------------------------------------------------+
 |  ICMP-derived. FortiMonitor does not measure SIP / RTP directly.                     |
 |  18 of 64 instances configured for Network Quality (9 include MOS).                  |
 |                                                                                      |
 |  Window:   [ 24h ]  [*7d*]  [ 30d ]                                  [Export CSV]    |
 +--------------------------------------------------------------------------------------+
 |                                                                                      |
 |   ACTIVE NETWORK QUALITY OUTAGES                                                     |
 |  +--------+--------------------------+----------+----------+-------------------+     |
 |  | sev    | instance                 | metric   | started  | duration          |     |
 |  +--------+--------------------------+----------+----------+-------------------+     |
 |  | CRIT   | zoom.us (Login)          | MOS      | 2h 14m   | open              |     |
 |  | WARN   | mail.google.com          | Jitter   | 41m      | open              |     |
 |  +--------+--------------------------+----------+----------+-------------------+     |
 |                                                                                      |
 |   TOP NOISY INSTANCES, LAST 7 DAYS                                                   |
 |   #   instance                  metric breakdown                          count      |
 |   1   zoom.us (Login)           [MOS 8 ][PL 3 ][Lat 1 ]                   12         |
 |   2   marketplace.zoom.us       [MOS 4 ][PL 2 ]                            6         |
 |   3   events.zoom.us            [Lat 3 ][Jit 1 ]                           4         |
 |   ...                                                                                |
 |                                                                                      |
 |   PER-INSTANCE INVENTORY                                                             |
 |  +-----------------------+------------+------+------+------+------+-----------+      |
 |  | instance              | template   | Lat  | Jit  | PL   | MOS  | thresh?  |      |
 |  +-----------------------+------------+------+------+------+------+-----------+      |
 |  | developers.google.com | GW NQ Base | yes  | yes  | yes  |  -   | no       |      |
 |  | mail.google.com       | GW NQ Base | yes  | yes  | yes  |  -   | no       |      |
 |  | zoom.us               | Zoom NQ+   | yes  | yes  | yes  | yes  | no       |      |
 |  | ...                                                                       |      |
 |  +-----------------------+------------+------+------+------+------+-----------+      |
 |                                                                                      |
 +--------------------------------------------------------------------------------------+
```

A higher-fidelity HTML mockup lives at `docs/mockups/voip-report.html`.

## 7. Out of scope (this report)

- No time-series chart. The report shows outage-record density, not raw
  metric series, because v2 has no time-series endpoint.
- No real SIP / RTP capture. Adding those would require FortiMonitor itself
  to expose them or for the toolkit to layer in a wholly different data
  source (PCAP, vendor PBX APIs). Not happening.
- No "alert me when MOS < 4" — the toolkit doesn't run a backend. The
  operator would set that threshold inside FortiMonitor itself. The report
  can deep-link to the per-metric Edit Threshold modal
  (`/config/ChooseSimulatedThreshold?server_resource_id=<id>` or
  similar — captured in `voip.md`).

## 8. Follow-up tickets (filed 2026-05-12)

Each carries the `browser-plugin` label.

1. **FMN-181 — Network Quality Report: card + viewer scaffold**
   Inject the `pa-card` on `/report/ListReports` (mirrors FMN-154). Open
   an extension-served result page. Hook up the v2 fetcher for
   `server` + `agent_resource` + `outage` + `outage_statistics` +
   `server_template`. Empty/zero/error states. CSV export. No
   time-series wiring yet.

2. **FMN-182 — Network Quality Report: outage join + active-outage panel**
   Build the description-prefix join on `/v2/outage` for the four NQ
   metric labels (`'Latency from '`, `'Jitter from '`, `'Packet Loss from '`,
   `'MOS from '`). Populate the active-outage panel. Populate the
   recent-outage counters. Window selector (24h / 7d / 30d).

3. **FMN-183 — Network Quality Report: capture session-auth metric data
   endpoint** (capture-only)
   Probe `/report/get_service_performance_data` (or whatever the Service
   Performance report uses) for an `icmp.latency` agent_resource to find
   the time-series endpoint. Document findings in
   `docs/api-discovery/metric-data.md`. Discovery-only; no implementation.

4. **FMN-184 — Network Quality Report: time-series enrichment (gated on FMN-183)**
   If a session-auth metric-data endpoint is found, add a "max jitter in
   window" / "max packet loss in window" column to the per-row table.
   Otherwise close as won't-fix-without-FortiMonitor-changes.

5. **FMN-185 — Network Quality Report: instance-subset filter** (FMN-152 deps)
   Reuse omni-search corpus to filter the report to a customer / site /
   tag. Adds the search input above the inventory table.

6. **FMN-186 — Settings entry for Network Quality Report visibility**
   Per project memory `per_tool_visibility_flag.md`, the tile gets its
   own Settings toggle in popup. Default off until FMN-181 and FMN-182 ship.

## 9. Honest "what we'd need first" note

This report is a Network Quality report. It is not a VoIP report.
If a VoIP-quality report (real SIP-registration health, real RTP
packet-loss measured at the codec layer, MOS computed from RFC-3611
RTCP-XR receiver reports) is what the operator eventually wants, the
gap is on FortiMonitor's side, not the toolkit's: FortiMonitor would
need to ship a SIP / RTP / RTCP plugin (or a fortigate-side SIP-ALG
metric export) for the toolkit to surface. None of that exists today.

The Network Quality plugin is what we have; this report makes it
visible across the fleet. That is a real, distinct value-add.
