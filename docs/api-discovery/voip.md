# FortiMonitor VoIP / Network Quality data — discovery (FMN-166)

Captured against the live tenant on 2026-05-11 via the persistent CDP session at
`http://localhost:9222`, using the operator's existing v2 API key and the
extension's session cookies for session-auth endpoints. Sample sources are in
`tests/e2e/__artifacts__/fmn-166-voip-survey-{1..7}.json` (artifacts, not
committed). Probes are in `tools/discovery/fmn-166-voip-survey-*.mjs`.

## Headline

**FortiMonitor does not have a "VoIP" data domain.** There is no SIP, RTP,
RTCP, codec, call-quality or PBX-aware data on the platform. The closest
thing is the **Network Quality** plugin (`resource.icmp`), which derives
four ICMP-probe-based metrics that include a synthetic MOS rating.

Concretely on the tenant scanned (64 servers, 2128 agent_resource_types,
3 OnSight appliances, 71 network_service_types):

- 0 `agent_resource_type` rows mention voip / sip / rtp / rtcp / codec / pbx
  in `label`, `resource_textkey`, `plugin_textkey`, `category`, or `platform`.
- 0 `network_service_type` rows match those terms either.
- 0 `server_template` rows reference voip / sip / etc. in `name` / `description`.
- 0 servers (out of 64) have a voip-shaped string anywhere on the
  `/v2/server` record.
- 4 `agent_resource_type` rows under `category: "Network Quality"`:
  `icmp.latency`, `icmp.jitter`, `icmp.packet_loss`, `icmp.mos`.
- 18 of 64 servers carry Network Quality metrics; 9 of those include MOS.
- The FortiMonitor canned-report library (`/report/ListReports`, 19 cards
  rendered) does not include a VoIP or Network Quality report. The closest
  card is "SD-WAN Report".
- All `/report/voip*`, `/report/SipReport`, `/report/NetworkQuality` URLs
  resolve to the **same 938,971-byte SPA shell** as `/report/totally_made_up_path_xyz`
  - i.e., those routes don't exist. Same SPA-shell-on-unknown-route pattern
  as `/report/get_idp_data` documented in `server-metadata.md`.

If a tool here is going to do anything VoIP-flavored, it is going to do it on
top of the Network Quality plugin's ICMP-derived MOS, not on real call data.

---

## What FortiMonitor exposes that is relevant

### 1. Network Quality (`resource.icmp`) — `agent_resource_type`

Four canonical metrics. The wrapper key for the list endpoint is
`agent_resource_type_list` (see project memory
`fortimonitor_v2_list_wrapper_keys.md`).

| `resource_textkey`  | `label`     | `unit`  | `category`      | id     |
|---------------------|-------------|---------|-----------------|--------|
| `icmp.latency`      | Latency     | `ms`    | Network Quality | 153050 |
| `icmp.jitter`       | Jitter      | `ms`    | Network Quality | 153051 |
| `icmp.packet_loss`  | Packet Loss | `%`     | Network Quality | 153052 |
| `icmp.mos`          | MOS         | `rating`| Network Quality | 153053 |

Endpoint: `GET https://api2.panopta.com/v2/agent_resource_type?limit=200`.
Each list entry has the shape:

```json
{
  "category": "Network Quality",
  "label": "Latency",
  "platform": null,
  "plugin_textkey": "resource.icmp",
  "resource_textkey": "icmp.latency",
  "unit": "ms",
  "url": "https://api2.panopta.com/v2/agent_resource_type/153050"
}
```

There is no extra detail behind `/v2/agent_resource_type/{id}` — the detail
endpoint returns the same record. (Same as `outage`'s detail endpoint
behavior. Don't double-fetch.)

### 2. `network_service_type` rows

Two of 71 entries match ICMP / network quality:

```
icmp.ping     -> Ping   (option: packet_loss_threshold int)
icmp.jitter   -> Jitter (option: packet_number int)
```

`icmp.mos`, `icmp.latency`, `icmp.packet_loss` are **NOT** in the
`network_service_type` catalog. The corresponding metrics are produced by the
Jitter `network_service` check, not by independent services. So:

- `network_service`: configures one Jitter check per (monitor → target) pair,
  with `packet_number` (default appears to be 50).
- `agent_resource`: emits one metric per derivation (latency, jitter, MOS,
  packet_loss).

### 3. `agent_resource` shape on a real Network Quality probe

Example from server 40430881 ("Developers", `developers.google.com`):

```json
{
  "agent_resource_type": "https://api2.panopta.com/v2/agent_resource_type/153052",
  "formatted_name": "Packet Loss from DEM_Lab-01 (EC2AMAZ-O6H219U)",
  "frequency": 60,
  "ip_type": "v4",
  "metric_lock": false,
  "monitor_node": null,
  "monitoring_location": "https://api2.panopta.com/v2/server/42154830",
  "name": "Packet Loss from DEM_Lab-01 (EC2AMAZ-O6H219U)",
  "name_override": null,
  "plugin_textkey": "resource.icmp",
  "resource_option": "*",
  "resource_textkey": "icmp.packet_loss",
  "server_interface": null,
  "status": "active",
  "tags": [],
  "template": "https://api2.panopta.com/v2/server_template/40430873",
  "template_agent_resource": "https://api2.panopta.com/v2/server/40430873/agent_resource/379330150",
  "thresholds": [],
  "url": "https://api2.panopta.com/v2/server/40430881/agent_resource/448746851"
}
```

Per-field notes that matter for the report:

| Field                   | Meaning |
|-------------------------|---------|
| `resource_textkey`      | One of `icmp.latency` / `icmp.jitter` / `icmp.packet_loss` / `icmp.mos`. The discriminator. |
| `frequency`             | Probe interval in seconds (observed: 60). |
| `monitoring_location`   | **URL of the agent / OnSight / server doing the ICMP probe.** This is the "from" side of a Network Quality measurement, not the "to" side. The target is the enclosing server's primary fqdn. |
| `template`              | URL of the source template the resource was applied from. Useful for joining "which template configures NQ?" rollups. |
| `thresholds`            | Per-resource alert thresholds (severity / operator / value / window). Empty on every sample. Configured per server, not at template level. |
| `url`                   | `/v2/server/{server_id}/agent_resource/{resource_id}`. Resource id is what `get_monitoring_config_data` returns as `server_resource_id`. |

### 4. Session-auth `get_monitoring_config_data` — Network Quality category

Same endpoint documented in `templates.md`. For a server with Network
Quality applied, the response includes a category block:

```json
{
  "name": "Network Quality",
  "addable": true,
  "textkey": "network.quality",
  "status": "added",
  "metrics": [
    { "id": -448746861, "type": "server_resource", "name": "Jitter from DEM_Lab-01 (EC2AMAZ-O6H219U)", "alert_items": [], "frequency": "60 sec" },
    { "id": -448746857, "type": "server_resource", "name": "Latency from DEM_Lab-01 (EC2AMAZ-O6H219U)", "alert_items": [], "frequency": "60 sec" },
    { "id": -448746851, "type": "server_resource", "name": "Packet Loss from DEM_Lab-01 (EC2AMAZ-O6H219U)", "alert_items": [], "frequency": "60 sec" }
  ]
}
```

Note: `id` is signed (negative). The absolute value is the `server_resource_id`
used by deep-link routes such as
`/config/PauseService?server_resource_id=448746861` and
`/config/ChooseSimulatedThreshold?server_resource_id=448746861`.

`alert_items` would carry threshold tuples (same shape as `templates.md`).
Empty on every NQ metric sampled because no operator-defined thresholds
exist on this tenant.

### 5. OnSight appliances

Three OnSight devices on the tenant (`/v2/onsight`, count 3). Sample shape:

```json
{
  "name": "ubuntu_onsight_permanent-01",
  "onsight_key": "aqem-v7sk-h75x-58vq",
  "server_group": "https://api2.panopta.com/v2/server_group/617717",
  "status": "active",
  "heartbeat_timeout": 10,
  "geo_latitude": null,
  "geo_longitude": null,
  "url": "https://api2.panopta.com/v2/onsight/16966"
}
```

OnSight devices appear as agents in the `monitoring_location` field of
Network Quality agent_resources. They do **not** carry any VoIP-specific
fields. There is no OnSight-only check that mentions SIP / RTP / codec.

---

## Inventory observed on this tenant

18 of 64 servers (28%) carry at least one Network Quality metric. They split
into two configurations:

- **Latency + Jitter + Packet Loss only** (no MOS): 9 servers, all Google
  Workspace endpoints (`developers.google.com`, `apis.google.com`,
  `mail.google.com`, etc.)
- **Latency + Jitter + Packet Loss + MOS**: 9 servers, all Zoom endpoints
  (`zoom.us`, `support.zoom.us`, `marketplace.zoom.us`, etc.) plus a
  Google DNS monitor.

MOS is opt-in at template-configuration time — the underlying `icmp.mos`
agent_resource_type exists tenant-wide, but the templates applied to the
Google Workspace targets simply don't add it. Any report has to assume that
not every Network-Quality-monitored host has a MOS series.

---

## Gotchas

### `icmp.mos` is synthetic, not measured

FortiMonitor's MOS rating is derived from ICMP probe statistics (latency,
jitter, packet-loss) via the standard ITU-T G.107 E-model approximation —
it is **not** observed from a real RTP stream. Practical implications:

- A "good" MOS on a path means the ICMP path is healthy. It does **not**
  prove that VoIP traffic on the same path is actually good (because
  routers can QoS / shape ICMP differently from RTP).
- A "bad" MOS pinpoints a network problem on the probe path, but the
  failure mode is "network path is bad" not "call quality is bad".
- The plugin's report copy must say "ICMP-derived MOS" or "synthetic MOS"
  somewhere, otherwise an operator skimming the report will assume real
  call data.

### MOS presence is not uniform

On this tenant, only 9 of 18 NQ-monitored servers have an `icmp.mos`
agent_resource. Anything that joins on MOS must left-join the metric
(present on most-but-not-all servers).

### No public time-series endpoint for agent_resource data

v2 has no documented path to read historical metric values. Probed:

- `/v2/server/{id}/agent_resource/{rid}/data` — 404
- `/v2/server/{id}/agent_resource/{rid}/metric_data` — 404
- `/v2/agent_resource/{rid}/data` — 404
- `/v2/server/{id}/agent_resource/{rid}/data_point` — 404
- `/v2/server/{id}/data?agent_resource_id={rid}` — 404

This is the same gap that forced FMN-135 to use the session-auth
`get_monitoring_config_data` for threshold inspection: v2 publishes
configuration but not telemetry.

For a VoIP-quality report to show "MOS over the last 24h", a session-auth
endpoint is required. The Service Performance Report on `/report/ListReports`
hydrates metric chart data from somewhere — capturing that call is the next
step (a follow-up ticket, not this discovery).

### `outage` records do carry MOS / jitter / packet-loss in `description`

Verified separately during FMN-156 noise-analysis work: outages opened
against a Network Quality metric have `description` strings like
`"MOS from DEM_Lab-01 (EC2AMAZ-O6H219U)"` or `"Packet Loss from
DEM_Lab-01 (...)"`. The string match is reliable: the leading word is
exactly the metric `label`. **The `/v2/outage` endpoint is therefore the
cheapest path to "show me sites that had a Network Quality incident in
the last N days"** — no time-series data required.

### Confusingly-named MOS / mos-substring false positives

Five thousand-line `agent_resource_type` rows contain the substring
`"mos"` from "MostRecent" (HCL Domino Mail Queue stats). Any string-match
filter against MOS must constrain to `category === 'Network Quality'`
**or** `resource_textkey === 'icmp.mos'`. A naive `.includes('mos')` will
return 37 unrelated Domino mail-queue records.

### `/report/{anything}` is not a route-existence probe

Every `/report/<path>` returns 200 with the same 938,971-byte SPA shell.
HTTP status and even response length are useless for "does this report
exist?". The only reliable test is to hydrate `/report/ListReports` and
read the rendered `<pa-card>` titles client-side. Doc'd here, applies
to any future ticket that wants to detect a canned report by URL probe.

### Cards / template alignment

On this tenant the NQ configurations are template-driven: 9 Zoom servers
share a template that includes MOS; 8 Google Workspace servers share a
different template that excludes MOS. A site-rollup report should
group-by `template` URL where useful, rather than treating each server
as an independent VoIP site.

---

## Tenant-survey summary

| Question                                                                  | Answer on this tenant                       |
|---------------------------------------------------------------------------|---------------------------------------------|
| Are there voip / sip / rtp / codec agent_resource_types?                  | No                                          |
| Are there voip / sip network_service_types?                               | No                                          |
| Are there voip templates by name?                                         | No                                          |
| Are there NQ (Network Quality) agent_resource_types?                      | Yes — 4 (latency, jitter, packet_loss, mos) |
| Servers configured with NQ                                                | 18 / 64                                     |
| Servers configured with MOS specifically                                  | 9 / 64                                      |
| OnSight appliances                                                        | 3                                           |
| Does FortiMonitor ship a VoIP / Network Quality canned report?            | No                                          |
| Public v2 endpoint for metric time-series                                 | No                                          |
| Outage records that name a NQ metric in `description`                     | Yes (FMN-156 confirms `Packet Loss / MOS / Latency / Jitter` substrings show up there) |

The Network Quality plugin is doing the closest thing FortiMonitor has to
"VoIP-quality monitoring", and there is no rollup report on top of it. That
is the gap a toolkit feature can fill.

---

## Probe scripts

- `tools/discovery/fmn-166-voip-survey.mjs`     — initial term sweep (correct fields TBD)
- `tools/discovery/fmn-166-voip-survey-2.mjs`   — widened terms
- `tools/discovery/fmn-166-voip-survey-3.mjs`   — corrected field names (`resource_textkey` / `label` / `plugin_textkey` / `category`)
- `tools/discovery/fmn-166-voip-survey-4.mjs`   — Network Quality deep-dive + OnSight + per-server NQ scan
- `tools/discovery/fmn-166-voip-survey-5.mjs`   — agent_resource full shape + session-auth monitoring config
- `tools/discovery/fmn-166-voip-survey-6.mjs`   — MOS distribution across tenant + metric_data endpoint probes
- `tools/discovery/fmn-166-voip-survey-7.mjs`   — SPA-shell-vs-real-route confirmation + ListReports card titles

All probe scripts connect over CDP to the persistent Chromium at
`localhost:9222` and reuse the loaded extension's API key from
`chrome.storage.local`.
