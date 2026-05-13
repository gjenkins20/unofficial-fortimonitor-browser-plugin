# FortiMonitor Template-Create API Contract (partial)

Captured from a live FortiMonitor tenant on 2026-05-13 via the FMN-199 Playwright-paired discovery session. Source capture: `tools/discovery/fmn-199-capture-2026-05-13.json` (gitignored, holds session cookies). Driven against `https://fortimonitor.forticloud.com/`.

This is the internal UI-only surface that backs FortiMonitor's **Create Template** flow. The v2 API has no template-create resource on this auth surface (per project memory `no_fortimonitor_api.md`); session-auth endpoints on the tenant origin are the only path.

**Status: PARTIAL.** The captured walk-through exercised only the CREATE-shell step. Adding agent_resources, setting thresholds, editing, the duplicate-name error path, and deletion were not exercised in this round and need a follow-up capture (filed as FMN-205).

---

## What was captured

### `GET /config/get_create_server_template_data`

Form-bootstrap endpoint. Returns the create-template form's option vocabulary.

**Request:**

```
GET /config/get_create_server_template_data
Accept: application/json, text/plain, */*
X-XSRF-TOKEN: <verbatim XSRF-TOKEN cookie value>
Referer: https://fortimonitor.forticloud.com/onboarding/v2/
```

**Response (200, application/json):**

```json
{
  "success": true,
  "preselected": ["grp-0"],
  "template_name": "",
  "template_type_options": [
    { "value": "generic_template",        "label": "Generic" },
    { "value": "network_device_template", "label": "Network Device Template" },
    { "value": "vmware_template",         "label": "VMware Template" },
    { "value": "fabric_template",         "label": "Fabric Template" },
    { "value": "dem_template",            "label": "Application Monitoring Template" },
    { "value": "third_party_template",    "label": "Third Party Template" }
  ],
  "alert_timeline_options": [
    { "value": 0,      "label": "Inherit from group" },
    { "value": 367772, "label": "Basic notification schedule" }
  ]
}
```

Notes:
- The `alert_timeline_options` list mirrors what `/monitoring_policy/get_page_data` returns under `actionValueOptions.alert_timeline` (FMN-194). Likely the same per-tenant data, different transport.
- Six template types exist. For FMN-200's Fabric clustering use case, `fabric_template` is the right choice.
- `preselected` `["grp-0"]` is the default server-group pick for the form's group picker.

### `POST /config/createServerTemplate`

The CREATE call. Creates an **empty** template shell. Agent_resources / thresholds are added separately (endpoints not yet captured; see Gaps below).

**Request:**

```
POST /config/createServerTemplate
Content-Type: application/json
X-XSRF-TOKEN: <verbatim XSRF-TOKEN cookie value>
Referer: https://fortimonitor.forticloud.com/onboarding/v2/
Accept: application/json, text/plain, */*

{
  "server_id": null,
  "template_name": "FMN-199 capture probe",
  "template_type": "fabric_template",
  "select_options": "yes",
  "instance_grp_name": "FM Toolkit Templates",
  "notification_schedule": 0,
  "element_ids": "grp-617598"
}
```

Field notes:

| Field | Type | Meaning |
|---|---|---|
| `server_id` | int \| null | When non-null, this is presumably the "clone from server" id (create-template-from-existing-server flow). Null for a fresh template. |
| `template_name` | string | The new template's name. Idempotence key on commit. |
| `template_type` | one of the values from `template_type_options` | `fabric_template` for the FMN-198 use case. |
| `select_options` | `"yes"` \| presumably others | Captured value `"yes"`; semantics not yet probed. May gate "show defaults" or "apply suggestions" toggles. |
| `instance_grp_name` | string | The server group the template is filed under in the UI. Operator picked a custom group ("FM Toolkit Templates"). |
| `notification_schedule` | int | Alert-timeline id from `alert_timeline_options`. `0` is the "Inherit from group" sentinel. |
| `element_ids` | string (`grp-{id}`) | Server-group prefix-id, single value (despite the field name's plural). Matches FMN-71's `element_ids` convention. |

**Response (200, application/json, content-length 124):** body not retained by the Playwright recorder (cross-origin response-body limitation observed). Status was 200 and a follow-up read on the new template's id confirmed:

- The new template appears in the monitoring tree (next `/util/monitoring_tree` POST shows it).
- The new template's id is reachable via `GET /report/get_monitoring_config_data?server_id={new_id}`. In our capture the new template received id `44016756`.

### `GET /report/get_monitoring_config_data?server_id={template_id}`

Read-side. Already documented for the BPA work (FMN-135). Confirmed here that templates and servers share an id namespace. For the freshly-created empty template:

```json
{
  "success": true,
  "categories": { "added": [], "detected": [] },
  "server": {
    "id": 44016756,
    "name": "FMN-199 capture probe",
    "status": "template",
    "is_template": true,
    "device_type": "network_device",
    "device_sub_type": "fabric_template",
    "created": "2026-05-13 13:08:21",
    "...": "..."
  },
  "server_edit_access": true,
  "inbound_categories": { "added": [], "detected": [] },
  "outbound_categories": { "added": [], "detected": [] }
}
```

Notable:
- `categories.added: []` confirms a fresh template carries **no monitoring resources** until something is added separately. The CREATE endpoint produces an empty shell.
- The server-record carries `is_template: true` and `device_sub_type: "fabric_template"` (the chosen type). Even though the operator picked `fabric_template`, the underlying `device_type` field is `network_device`. The `device_sub_type` is the authoritative discriminator.

### `GET /report/get_applied_instances?template_id={id}` (DataTables-shaped)

Returns the list of devices the template is attached to. For a fresh template, `{"data": [], "recordsTotal": 0, "recordsFiltered": 0}`. Same DataTables AJAX pattern as `/report/server_group_inventory_data` (FMN-71). Useful for the FMN-200 commit step's "did the attachment succeed?" verification.

### `POST /util/monitoring_tree?include_templates=1`

Sidebar tree population. Returns the tree FortiMonitor's left-nav uses to render Templates. Fires on initial Templates-page load AND again after a successful create (the post-create call carries a `user_hash` cache-bust query param).

### `GET /report/get_metric_category_data_for_add?server_id={template_id}&category_textkey={textkey}`

Captured once when the operator browsed the new template, with `category_textkey=fortinet.fortigate`. Returned `{"success": true, "messages": [], "has_supported_metric": false}` - i.e. no supported metrics for that category on this template type. This endpoint is likely a pre-flight check before opening the "Add Metric" picker UI; the actual add-metric POST was not captured in this round.

---

## Auth comparison vs `/monitoring_policy/*` (FMN-194)

| Aspect | `/monitoring_policy/*` (FMN-194) | `/config/createServerTemplate` (FMN-199) |
|---|---|---|
| Content-Type on POSTs | `application/x-www-form-urlencoded; charset=UTF-8` | `application/json` |
| Body shape | form-encoded params | JSON object |
| `X-XSRF-TOKEN` header | **NOT sent** by the SPA; server didn't require it | **Sent** by the SPA; assumed required (not yet permuted) |
| `X-Requested-With: XMLHttpRequest` | sent | not observed in the captured headers (axios style omits it) |
| `Referer` | `/monitoring_policy/` | `/onboarding/v2/` |

The `/config/createServerTemplate` endpoint matches the `/config/save_port_selection` pattern (FMN-36) more closely than the `/monitoring_policy/*` pattern: it requires the XSRF token, just like port-scope writes do. Extension code calling this endpoint needs the `cookies` permission to read the `XSRF-TOKEN` cookie (already in the manifest per FMN-36).

---

## Companion findings: add-resource path (FMN-203)

The gaps left by this round (add-agent-resource, threshold-set, etc.) are covered by parallel work in **FMN-203**, which captured the metric-add write call. See `docs/api-discovery/template-create-from-device.md` for that contract. Highlights relevant to FMN-200:

- `POST /config/monitoring/editAgentMetric` (lowercase `e`) is the add-metric write. `Content-Type: application/x-www-form-urlencoded`, `X-Requested-With: XMLHttpRequest`. No `X-XSRF-Token` observed.
- The metric catalog is at `GET /report/ManageCategoryVue2?server_id={template_id}&category_textkey=fortinet.fortigate`.
- Verified end-to-end against empty Fabric template 44017104 (3 metrics added successfully).
- "Create Template from Device" is the same `POST /config/createServerTemplate` with `server_id` set to the source device id. Captured templates: shell at 44017019 (operator's), populated at 44017228 (operator's, FGVM01TM24006844 Template).

### Things NOT yet captured (small follow-ups)

1. **Threshold / `alert_items` write path** - FMN-203 added metrics without thresholds. Likely the same `editAgentMetric` endpoint with `alert_items[...]` populated; verify with one more HAR.
2. **Edit / rename template metadata** - probably another `/config/*` endpoint.
3. **Delete template** - likely `POST /config/deleteServerTemplate`.
4. **Duplicate-name behavior** - not yet probed.

None block FMN-200's first-ship surface (create + populate + attach via Monitoring Policy).

---

## Recommendation for FMN-200 (implementation)

Combined with FMN-203's findings, the wire shape is complete for the create-and-populate path. FMN-200 can build the full flow:

1. `POST /config/createServerTemplate` with `template_type: "fabric_template"` and either `server_id: null` (empty shell) or `server_id: {source_device_id}` (clone-from-device).
2. For each Best-Practice metric: `POST /config/monitoring/editAgentMetric` with `check_method=fabric`, `action=add`, `isTemplate=true`, `template_from_scratch=true`, plus `plugin_textkey` + `resource_textkey` from the catalog.
3. Idempotence: `GET /report/get_monitoring_config_data?server_id={template_id}` before each metric write; skip if the resource textkey is already present.

---

## Capture provenance

- Capture file: `tools/discovery/fmn-199-capture-2026-05-13.json` (gitignored).
- Discovery script: `tools/discovery/fmn-199-templates-create-capture.mjs`.
- Driven by operator on 2026-05-13 against `https://fortimonitor.forticloud.com/`. Lifecycle exercised: navigate to Templates UI, create one template ("FMN-199 capture probe", id 44016756), view the created (empty) template. The walk-through stopped after the create + view; edit, delete, add-resource, and duplicate-name paths are deferred to FMN-205.
- 196 total XHR/fetch captured; 6 template-shaped. 16 candidate-URL probes for guessed endpoints all returned 200 + SPA shell HTML (i.e. none of the guessed paths exist as real endpoints; only the SPA's actual calls are usable).
