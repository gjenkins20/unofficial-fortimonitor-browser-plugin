# `/v2/outage` shape (FMN-156)

Captured against the live tenant via `tools/discovery/fmn-156-outage-shape.mjs`
on 2026-05-11. Sample size: 50 records.

## Endpoint

```
GET https://api2.panopta.com/v2/outage?limit=200
Authorization: ApiKey <rw-key>
Accept: application/json
```

Response shape: `{ meta: {...}, outage_list: [...] }` (matches the standard
v2 list envelope; see project memory `fortimonitor_v2_list_wrapper_keys.md`).

## Per-record fields (observed)

| Key                          | Type            | Notes |
|------------------------------|-----------------|-------|
| `url`                        | string          | `/v2/outage/{id}`, the trailing segment is the outage id |
| `hash`                       | string          | opaque, ~15 chars |
| `type`                       | string          | `'outage'` on every observed record |
| `status`                     | string          | `'resolved'` on every observed record. **Used as the active-vs-resolved discriminator** (see "Active state" below) |
| `severity`                   | string          | `'critical'`, `'warning'` |
| `start_time`                 | string          | RFC-2822 (`'Mon, 11 May 2026 14:23:08 -0000'`); `parseTimestamp` in `_helpers.js` handles it |
| `end_time`                   | string \| null  | RFC-2822 when resolved; null on active outages |
| `acknowledged`               | bool \| null    | null on every observed sample (acknowledge state is not surfaced through this endpoint in the captured snapshot) |
| `description`                | string          | check / metric name (e.g. `'Agent Heartbeat'`). **This is the per-record "what was monitored" handle** the noise analyzer uses. |
| `summary`                    | string          | empty on every observed record; not useful for ranking |
| `server`                     | string          | `/v2/server/{id}` URL |
| `server_id`                  | number          | numeric server id |
| `server_name`                | string          | display name |
| `server_fqdn`                | string          | fqdn (e.g. `'EC2AMAZ-75R4CUH'`) |
| `server_group_id`            | number          | numeric group id |
| `server_group_name`          | string          | display name |
| `compound_service`           | string \| null  | `/v2/compound_service/{id}` URL when the outage relates to a compound service |
| `compound_service_id`        | number \| null  | |
| `compound_service_name`      | string \| null  | |
| `network_service_type_list`  | array \| []     | per-network-service detail; populated for some outages |
| `metric_tags`                | array           | empty on every observed record |
| `tags`                       | array           | empty on every observed record |
| `has_active_maintenance`     | bool            | false on every observed record |
| `exclude_from_availability`  | bool            | |
| `next_action`                | any \| null     | |
| `metadata`                   | array \| []     | |

## Active state

The endpoint does **not** return an `active` boolean. The existing
`IncidentAnalyzer` (FMN-132) filters with `o?.active === true`, which means
its real-data path never finds any active outages - that branch is
exercised only by the test fixture. The truthful signal is the `status`
field:

- `status === 'active'` (or any value other than `'resolved'`) - the
  outage is open.
- `status === 'resolved'` - the outage has cleared. `end_time` is
  populated.

The noise analyzer (this file's owner, FMN-156) treats `status` as the
authoritative discriminator and falls back to the legacy
`active === true` shape so the analyzer continues to work against unit
fixtures and any other code path that still constructs that shape.

## Metric-level identifier

The closest thing to a per-metric handle is `description`, which carries a
human-readable check name (e.g. `'Agent Heartbeat'`, `'CPU'`,
`'Memory'`). It's a string, not a stable id, but it's consistent across
outages for the same metric on the same server. The noise analyzer ranks
"top noisy metrics" by `(server_id, description)` count, with each row
naming the metric as it appears in the description.

`metric_tags` looked promising for richer metric metadata, but every
sampled record returned an empty array. The other plausible identifier
fields (`compound_service`, `network_service_type_list`) are populated
for a subset of outages; we surface the metric line via `description`
because it is universally present.

## What the analyzer uses

- `server_id`, `server_name` - join key for "top noisy instances"
- `start_time`, `end_time` - duration + MTTR + flap-rate windowing
- `status` (with legacy `active === true` fallback) - filter out
  in-flight outages from duration / MTTR math
- `description` - "top noisy metrics" ranking handle

Anything else on the record is left untouched. No new endpoint is
fetched at runtime; the analyzer is a pure function over the inventory
that `BpaFetcher` already populates.
