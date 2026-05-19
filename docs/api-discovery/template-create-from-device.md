# Create Template from Device - endpoint contract

Captured 2026-05-13 via HAR export + endpoint probes (FMN-203). Sanitized HAR slice at `docs/api-discovery/captures/template-from-device-2026-05-13.json`. Endpoint dumps at `docs/api-discovery/captures/template-probe-*.json`.

## Verified facts

### The create endpoint

```
POST https://fortimonitor.forticloud.com/config/createServerTemplate
Content-Type: application/json
X-XSRF-Token: <mirror of XSRF-TOKEN cookie>
```

Auth: session cookie (HttpOnly, automatic) + `X-XSRF-TOKEN` header.

One observed request body:

```json
{
  "server_id":            42024075,                        // source device
  "template_name":        "FGVM01TM24006846 Template",
  "template_type":        "fabric_template",
  "select_options":       "no",                            // see below
  "instance_grp_name":    "FGVM01TM24006846 Template",
  "notification_schedule": 0,
  "element_ids":          "grp-985142"                     // destination server group
}
```

Pre-dialog defaults come from `GET /config/get_create_server_template_data?instance_id={server_id}`.

### Two created templates, two outcomes

| Template id | Name | Source device | Categories.added | `select_options` known? |
|---|---|---|---:|---|
| 44017019 | FGVM01TM24006846 Template | 42024075 (Fabric FortiGate) | **0 (empty)** | `"no"` (from HAR) |
| 44017228 | FGVM01TM24006844 Template | 42024076 (Fabric FortiGate) | **17 (all `fortinet.fortigate`)** | unknown - not captured |

Both have `device_type: "network_device"`, `device_sub_type: "fabric_template"`, `is_template: true`. They differ structurally only in the contents of `categories.added`. **A populated Fabric template absolutely exists on the tenant; the operator created it manually through FortiMonitor's UI.**

### The populated template's metric structure

`GET /report/get_monitoring_config_data?server_id=44017228` returns 30 KB with 17 categories. All have `textkey: "fortinet.fortigate"`. Category names (each is a metric group):

- FortiGate Antivirus Stats (5 metrics)
- FortiGate Bandwidth In / Bandwidth Out (2 metrics each)
- FortiGate CPU / Disk / Memory (2 metrics each)
- FortiGate Errors In / Errors Out / Packets In / Packets Out (2 metrics each)
- FortiGate Interface DHCP / Interface Status / Port Admin Status (2 metrics each)
- FortiGate Security Rating (12 metrics)
- FortiGate Sessions (4 metrics)
- FortiGate VPN_SSL Sessions / VPN_SSL Stats (1 + 3 metrics)

Each metric is shaped:

```json
{
  "id":          -535178745,
  "type":        "server_resource",
  "name":        "Memory Usage (global)",
  "alert_items": [
    ["critical", "CRITICAL", "server's default timeline", "greater than 87% for more than 1 minute", []],
    ["critical", "CRITICAL", "server's default timeline", "greater than 94% for more than 1 minute", []]
  ],
  "frequency":   "60 sec",
  "tags":        [],
  "actions":     [
    { "text": "Edit",   "button_type": "edit",    "icon": "pencil" },
    { "text": "Delete", "button_type": "onclick", "icon": "delete",
      "href": "window.app.rootVue.$broadcast('metric-table-action:delete', 'sr-535178745', 'Memory Usage (global)');" }
  ]
}
```

Key facts:
- Metric `id` is negative; the UI references it with `sr-{id}` prefix.
- `type: "server_resource"` — Fabric metrics are first-class server_resource records on the template's instance.
- `alert_items` carries threshold tuples `[severity, label, timeline, condition_text, extras]`.
- The Edit / Delete actions go through Vue `$broadcast` events (`metric-table-action:delete`, presumably also `:edit` and `:add`), not direct fetch calls. The actual HTTP write happens inside the Vue handler.

### Source device 42024075 vs populated template 44017228

Source device has 16 `fortinet.fortigate` categories: Antivirus Stats, Bandwidth In/Out, CPU, Disk, Errors In/Out, Interface DHCP, Interface Status, Memory, Packets In/Out, Security Rating, Sessions, VPN_SSL Sessions, VPN_SSL Stats.

Populated template has 17 of the same categories (one extra: "Port Admin Status"), each named `"FortiGate <X>"` instead of just `"<X>"`. Otherwise identical metric set.

**The populated template is a near-direct clone of the source device's monitoring config.** That's what "Save as Template" produces *when called with the right options*. The 44017019 empty result is the anomaly, not the populated 44017228.

### Things we tried that didn't lead anywhere

- `/fabric/get_connection_data` returns `success: false, "No matching connections found"` for both templates AND the source device — not the Fabric metric surface.
- 14 other guessed paths (`/fabric/get_template_data`, `/fabric/get_metric_data`, `/config/get_fabric_*`, etc.) all return the SPA shell HTML — they don't exist.
- v2 `/api/v2/server_template` is wrong base; v2 API lives at `api2.panopta.com/v2/` and requires an RW API key, not the session cookie.

## Add Fabric metric to an existing template (write side, captured 2026-05-13)

The UI surface lives on the **Monitoring Config** sub-tab, NOT the Details tab:

```
/report/Instance/{template_id}/monitoring/template_incidents_config
```

Flow: click **Add Monitoring** → pick category (e.g., FortiGate) → dialog opens via `GET /report/ManageCategoryVue2?server_id={template_id}&category_textkey=fortinet.fortigate` (33 KB payload, the full FortiGate metric catalog: 39 sub-categories, 30 addable as Fabric). Catalog at `docs/api-discovery/captures/fortinet-fortigate-metric-catalog.json`. Pick a specific metric → form opens via `GET /config/monitoring/EditAgentMetric` (capital E) → submit → write fires.

### The write endpoint

```
POST /config/monitoring/editAgentMetric           (LOWERCASE 'e' - matters)
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest
Referer: /report/Instance/{template_id}/monitoring/template_incidents_config
Auth: session cookie. No X-XSRF-Token observed.
Response: 200 OK, application/json, ~591 bytes. Body presumed { success: true, server_resource_id: <new_id> }; DevTools elided.
```

**Note the case sensitivity:** `GET /config/monitoring/EditAgentMetric` (capital E) loads the form HTML; `POST /config/monitoring/editAgentMetric` (lowercase e) is the actual write. Same path otherwise.

### Load-bearing form fields

```
server_id            = {template_id}              # int
plugin_textkey       = fortigate.resources        # from catalog add_url
resource_textkey     = memory_usage_percent       # from catalog add_url
check_method         = fabric                     # discriminates Fabric writes
plugin_name          = Memory Usage               # display label
resource_name        = Memory Usage               # display label
server_resource_id   =                            # empty -> create new; populated -> edit existing
action               = add                        # write op
frequency            = 60                         # poll interval (seconds)
units                = %                          # metric units
isTemplate           = true                       # flag
template_from_scratch = true                      # flag: built without source clone
match_type           = positive_pattern           # filter semantics
send_new             = true                       # new-add path
```

Additional fields observed but appear to be UI dropdown-option echo-back (almost certainly server-ignored): `frequencies[]`, `notification_schedules[]`, `delays[]`, `conditions[]`, `boolean_conditions[]`, `enum_conditions[]`, `log_*_options[]`, `timeFrameOptions[]`, `countermeasure_options[]` (38 of these), `countermeasure_delays[]`. A minimal programmatic write should be able to omit all of these; minimum-required-set verification is a follow-up if it matters.

### Verified end-to-end

Empty Fabric template 44017104 went from `categories.added: []` → 3 metrics added (FortiGate Bandwidth In, CPU, Memory Usage) by repeating this flow once per metric. Demonstrated operator-driven 2026-05-13. Captures at `docs/api-discovery/captures/add-fabric-metric-to-template-2026-05-13.json`.

## Open follow-ups (small)

1. **Response body of `POST /config/monitoring/editAgentMetric`** — DevTools elided. Likely `{success: true, server_resource_id}`. A re-capture with the response loaded would confirm.
2. **Minimum-required form-field set** — UI sends ~40 fields total, most appear to be echo-back. Trial-and-error would identify the actual minimum required.
3. **Threshold / `alert_items` write path** — the catalog write captured here adds the metric with no alert. Setting a threshold ("alert when Memory > 80%") fires a separate save we haven't captured. Probably the same endpoint with `alert_items[...]` fields populated; verify with one more HAR.
4. **Other plugin categories (SNMP, agent, DEM)** — same `editAgentMetric` endpoint with different `check_method` values. SNMP is FMN-197.

## Audit: catalog-hidden categories on cloned templates (FMN-204, 2026-05-19)

FMN-203 noted that the FortiGate catalog (`ManageCategoryVue2?category_textkey=fortinet.fortigate`) lists 39 sub-categories but **8 carry `metric_types: []`**: they appear as section headers in the Add Monitoring dialog but expose no addable metric variants. Yet the populated template 44017228 carries metrics under at least one of those categories (Antivirus Stats). FMN-204 audits how those metrics arrive on the template.

### Step 1: which of the 8 actually appear on the populated template + source device

| Catalog "hidden" category (textkey) | On populated template 44017228 | On source device 42024075 |
|---|---|---|
| `fortinet.fortigate.antivirus.stats` | yes, 5 metrics | yes, 5 metrics |
| `fortinet.fortigate.firewall.bytes` | no | no |
| `fortinet.fortigate.firewall.hit_count` | no | no |
| `fortinet.fortigate.firewall.packets` | no | no |
| `fortinet.fortigate.sdwan` | no | no |
| `fortinet.fortigate.interface.dhcpv4_clients` | no | no |
| `fortinet.fortigate.interface.dhcpv6_clients` | no | no |
| `fortinet.fortigate.vpnssl_sessions` | yes, 1 metric | yes, 1 metric |

Two of the 8 appear (Antivirus Stats, VPN_SSL Sessions). The other six don't manifest on either the source device or the cloned template. Captures: `docs/api-discovery/captures/template-probe-{populated-template,empty-template,source-device}-*-get_monitoring_config_data.json`.

### Step 2: metric-record shape comparison

Metric records on the 2 manifesting hidden categories (Antivirus Stats, VPN_SSL Sessions) are **structurally identical** to records in clearly-addable categories (Bandwidth In, CPU, etc.). Same `type: "server_resource"`, same `frequency`, same negative-id pattern, same Edit/Delete actions. Only incidental difference: interface-bound metrics carry `tags: ["lan"]` (or similar), VDOM-scoped metrics carry `tags: []`. The category itself reports `addable: true` at the get_monitoring_config_data level once metrics exist. There is no flag on the metric record that distinguishes "hidden-category-origin" from "catalog-added"; they are the same row type.

### Step 3: ManageCategoryVue2 scope comparison

The catalog endpoint was hit with `category_textkey=fortinet.fortigate` against three targets and the 8 hidden categories examined for `metric_types`:

| Target | http | sub_categories | metric_types[] on the 8 hidden |
|---|---|---|---|
| source-device 42024075 | 200 | 39 | empty on all 8 |
| populated-template 44017228 | 200 | 39 | empty on all 8 |
| empty-template 44017104 | 200 | 39 | empty on all 8 |

The catalog returns identical "no metric_types" for the 8 categories regardless of whether the scope is a live FortiGate, a cloned template with metrics in those categories, or an empty template. **The catalog is scope-agnostic for the hidden set.** Probe + captures: `tools/qa/fmn-204-catalog-comparison.mjs`, `docs/api-discovery/captures/fmn-204-managecategoryvue2-{source-device,populated-template,empty-template}-*.json`, `docs/api-discovery/captures/fmn-204-catalog-comparison-summary.json`.

### Step 4 (conditional): HAR while adding hidden-category metric on source device

**Not run; preconditions absent.** Step 4 was gated on "if the device-side catalog exposes metric_types for these categories where the template-side doesn't." Step 3 showed the device-side catalog is identical to the template-side: both return empty `metric_types` for all 8. So there is no UI "Add" flow on the device side to capture either. The Add Monitoring dialog itself refuses to surface variants for these categories regardless of the scope.

### Conclusion

The 8 "hidden" catalog categories are **server-side auto-populated** when the underlying FortiGate feature is active. They are not added via any UI flow we have visibility into; they are not addable via `editAgentMetric` (the catalog gates which `plugin_textkey` + `resource_textkey` pairs that endpoint accepts, and these 8 surface no pairs); they survive `createServerTemplate` clone-from-device because cloning copies all existing `server_resource` records irrespective of catalog status.

The 6 hidden categories that don't appear on FGVM01TM24006844 (Firewall Bytes/Hit Count/Packets, SD-WAN, DHCPv4/v6 Clients) represent FortiGate features that test VM does not have configured. On a tenant with a real-world FortiGate (firewall policies, SD-WAN setup, DHCP server enabled), additional categories from the hidden 8 would manifest. The current capture set is insufficient to confirm that empirically; a follow-up capture against a feature-rich FortiGate would resolve it.

### Implications for FMN-193

- **31 of 39 catalog categories** (`metric_types[]` non-empty) are writable via `POST /config/monitoring/editAgentMetric` per the FMN-203 contract.
- **8 of 39 are not.** A rulebook that wants metrics in these categories on a template cannot synthesize them via `editAgentMetric`. The only path is **clone-from-device with `select_options: "yes"`** using a source device that already has the desired hidden-category metrics. The rulebook implementation must:
  1. Identify a representative device with the target hidden-category metrics configured.
  2. Clone-with-metrics from that device.
  3. Strip metrics outside the rulebook's scope using whatever delete primitive Vue's `metric-table-action:delete` resolves to (not captured; if FMN-193 needs the delete write call, capture it as a follow-up under FMN-193 or a new sub-ticket).
- **Alternative:** the FMN-193 rulebook explicitly excludes the 8 hidden categories from its scope. This is the cleaner option if the rulebook can deliver value without them. Antivirus Stats and SSL-VPN session monitoring are the two that have real operational relevance among the 8; the others (Firewall byte/hit/packet counts, SD-WAN, DHCPv4/v6 client counts) are less commonly part of a monitoring baseline.

The choice between clone-with-metrics-and-strip vs scope-exclusion is a planning decision for FMN-193, not a discovery gap.

## Implications for FMN-193 sub-ticket #3 (FMN-203 era; superseded in part by FMN-204)

- v2 `POST /server_template` is clone-only (`copy_from` required); session-auth `POST /config/createServerTemplate` is the create.
- A Fabric template can be built programmatically by:
  1. `POST /config/createServerTemplate` with any source device's `server_id` and `template_type: "fabric_template"`. The cheapest source for metric selection is `select_options: "no"` (produces an empty shell).
  2. For each desired metric from the catalog's addable set (31 of 39 sub-categories): `POST /config/monitoring/editAgentMetric` with the catalog's `plugin_textkey` + `resource_textkey` + `check_method=fabric` + `action=add` + `isTemplate=true` + `template_from_scratch=true`.
  3. Idempotence: lookup `get_monitoring_config_data` on the destination template before each write, skip if the metric textkey already present.
- **The 8 catalog-hidden sub-categories** (see FMN-204 audit above) require a different path or scope exclusion; they cannot be added via step 2.
