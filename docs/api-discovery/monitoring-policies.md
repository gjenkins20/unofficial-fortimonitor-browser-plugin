# FortiMonitor Monitoring Policies API Contract

Captured from a live FortiMonitor tenant on 2026-05-12 via the FMN-194 Playwright-paired discovery session. Source capture: `tools/discovery/fmn-194-capture-2026-05-13.json` (gitignored, holds session cookies). Driven against `https://fortimonitor.forticloud.com/`.

This is the internal UI-only surface that backs the **Monitoring → Monitoring Policies** page. The v2 API has **no** monitoring-policy resource (the candidate-URL probe in the discovery script confirmed every guess returns the SPA shell rather than a JSON resource). The parent ticket (FMN-193, Best-Practice Fabric template + monitoring-policy automation) must therefore use the session-auth endpoints on the tenant origin.

FortiMonitor's internal name for a Monitoring Policy is a **"ruleset"**. Every endpoint and JSON field uses the ruleset spelling; "policy" appears only in the apply-workflow endpoint.

---

## Endpoints

All endpoints live on the tenant origin (`https://fortimonitor.forticloud.com/`). All are session-cookie-authenticated. GET routes are `PascalCase` for HTML drawers / `snake_case` for data; POST routes are `camelCase`. (FortiMonitor convention; treat each one as a literal string.)

### CRUD on rulesets

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/monitoring_policy/get_page_data` | List rulesets, predicate vocabulary, action vocabulary, tenant flags. **One-shot** - no paging. |
| `GET` | `/monitoring_policy/getRuleset?id={ruleset_id}` | Fetch one ruleset (full `config.rules`). |
| `POST` | `/monitoring_policy/addRuleset` | Create a new (empty) ruleset. |
| `POST` | `/monitoring_policy/editRulesetMetadata` | Rename / re-describe a ruleset. **Does not touch `config.rules`.** |
| `POST` | `/monitoring_policy/editRuleset` | Replace `config.rules` wholesale. Increments `latest_version` on every call. |
| `POST` | `/monitoring_policy/deleteRuleset` | Delete a ruleset. |

### Drawer-form GETs (HTML, not JSON)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/monitoring_policy/EditRulesetMetadata?ruleset_id={id}` | HTML of the name/description edit drawer. Form action wired to `editRulesetMetadata`. |
| `GET` | `/monitoring_policy/ApplyPolicy` | HTML of the apply-workflow drawer (instance picker + commit flag). Form action wired to `applyPolicy`. |

Extension code can skip these and POST directly to the action endpoints; the HTML drawers are only for the SPA's UI.

### Helpers

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/monitoring_policy/fetchAttributeOptions?attribute_textkey={textkey}` | Enumerate the allowed values for a given attribute textkey (e.g. `fortigate.model` → `[{value:"FGVMA6", label:"FGVMA6"}]`). Used to populate predicate value dropdowns. |

### Trigger / "test workflow"

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/monitoring_policy/applyPolicy` | Run the ruleset against an operator-chosen set of instances. Optional `commit=on` makes it apply for real; absent/off is dry-run. |

---

## Request shape

### GETs

Sent by the SPA's axios layer. Cookies attach automatically; the SPA also forwards `X-XSRF-TOKEN` (mirroring the `XSRF-TOKEN` cookie) on GETs, but the server returns 200 either way for GETs to this surface.

```
GET /monitoring_policy/getRuleset?id=8812
Accept: application/json, text/plain, */*
X-XSRF-TOKEN: <cookie value, optional in practice>
Cookie: XSRF-TOKEN=...; <session cookie (HttpOnly)>
```

### POSTs

Sent by the SPA's jQuery-based drawer code (`$.ajax({ method: 'POST', traditional: true, ... })`). **The SPA does not send `X-XSRF-TOKEN`** on these POSTs, which differs from `/config/save_port_selection` (FMN-36) where the token is required. The remaining sent headers (`X-Requested-With: XMLHttpRequest`, `Referer`) were not permuted in this session, so it is not known whether the server requires them or just receives them. FMN-135 found the session cookie alone was sufficient for at least some session-auth endpoints (`get_edit_user_data`, `get_monitoring_config_data`); the same may hold here. Verify by permutation before stripping headers in extension code.

```
POST /monitoring_policy/addRuleset
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
Referer: https://fortimonitor.forticloud.com/monitoring_policy/
Accept: */*
Cookie: <session cookie (HttpOnly)>

index=2&name=New+Ruleset+3&description=
```

For an MV3 service worker:
- `fetch()` with `credentials: 'include'` attaches the session cookie (manifest `host_permissions` must include `https://fortimonitor.forticloud.com/*`).
- Set `Content-Type: application/x-www-form-urlencoded; charset=UTF-8` and `X-Requested-With: XMLHttpRequest` explicitly. The `Referer` header is set by the browser when the request originates from a content script on the page; service-worker fetches do not set `Referer` automatically - verify on first use.
- `cookies` permission and an `X-XSRF-TOKEN` header are **not** required for `/monitoring_policy/*` POSTs.

---

## Body schemas

### Per-POST request bodies

| Endpoint | Body (form-encoded) |
|---|---|
| `addRuleset` | `index={n}&name={str}&description={str}`. `index` appears to be the SPA's local ordinal; the server-assigned id comes back in the response. `description` may be empty. |
| `editRulesetMetadata` | `ruleset_id={id}&name={str}&description={str}` |
| `editRuleset` | `ruleset_id={id}&config_json={url-encoded JSON: {"rules":[...]}}` (see Rule schema below) |
| `deleteRuleset` | `ruleset_id={id}` |
| `applyPolicy` | `element_ids={CSV of prefixed ids}&commit=on` (`commit` omitted = dry-run, max 10 instances) |

### Ruleset (response shape)

```json
{
  "id": 8812,
  "name": "FMN-194 capture probe",
  "latest_version": 0,
  "config": { "rules": [/* Rule[], see below */] },
  "textkey": "",
  "created": "2026-05-12 18:02:53 PDT",
  "upated": null,
  "comment": ""
}
```

Field notes:

| Field | Type | Meaning |
|---|---|---|
| `id` | integer | Server-assigned ruleset id. |
| `name` | string | User-visible name. |
| `latest_version` | integer | Incremented on every `editRuleset` POST. Response of `editRuleset` carries `version_id` distinct from this - `version_id` is the change-log entry, `latest_version` is the current head. |
| `config.rules` | Rule[] | Empty `[]` on a freshly created ruleset; populated by `editRuleset`. |
| `textkey` | string | Always empty in the captures. Likely a system-policy slug for stock rulesets (none observed). |
| `created`, `upated` | datetime string with tz | **Server returns `upated` (typo), not `updated`.** Preserved verbatim. `upated` is `null` until first edit. |
| `comment` | string | Free-text comment. Not exposed in the UI as captured but the field exists. |

### Rule

```json
{
  "enabled": true,
  "name": "Apply Template to FMVMA6",
  "conditions": [
    {
      "clauses": [
        {
          "datatype": "attribute",
          "match_type": "pick_one",
          "match_key": "fortigate.model",
          "match_value": "FGVMA6",
          "error": false
        }
      ],
      "operator": "and"
    }
  ],
  "actions": [
    { "action_type": "apply_template", "action_value": "42157589" }
  ]
}
```

Field notes:

| Field | Type | Meaning |
|---|---|---|
| `enabled` | boolean | Per-rule on/off within the ruleset. |
| `name` | string | UI label for the rule. |
| `conditions` | Condition[] | Multiple conditions appear to combine top-level (semantics not yet captured - operator only built one condition). |
| `conditions[].clauses` | Clause[] | The actual predicate terms, joined by `operator`. |
| `conditions[].operator` | `"and"` \| `"or"` | Clause-combiner within a condition. |
| `actions` | Action[] | Run sequentially when the rule's conditions match. |

### Clause

| Field | Type | Notes |
|---|---|---|
| `datatype` | `"name"` \| `"attribute"` \| `"device_type"` \| `"tag"` \| etc. | What the clause matches against. Vocabulary mirrors `nounOptions` keys (see below). Two confirmed values: `"name"` (matches instance name) and `"attribute"` (matches an attribute on the instance). |
| `match_type` | `"regex"` \| `"pick_one"` \| ... | For `datatype="name"`, `regex` was observed. For `datatype="attribute"`, `pick_one` was observed (operator picked from the `fetchAttributeOptions` dropdown). Other match types likely exist; not exhaustively captured. |
| `match_key` | string \| null | The attribute textkey (e.g. `fortigate.model`). `null` when `datatype="name"`. |
| `match_value` | string | The value to match against. For `pick_one`, a value from `fetchAttributeOptions`. For `regex`, the regex source (`.*` was observed). |
| `error` | boolean | Always `false` in captures. UI uses it to mark invalid clauses. |

### Action

| Field | Type | Notes |
|---|---|---|
| `action_type` | one of `"apply_template"`, `"alert_timeline"`, `"server_group"`, `"location"`, `"add_tags"`, `"add_as_dem_location"` | See `actionValueOptions` below for the universe. |
| `action_value` | **string** representation of integer | Target id (template id, alert timeline id, server-group id, location id, etc.). FortiMonitor returns and accepts these as strings, not integers - match exactly. For `alert_timeline`, the special value `"-1"` means "inherit from group". |

---

## `get_page_data` response (full envelope)

```json
{
  "success": true,
  "rulesets": [/* Ruleset[], see above */],
  "defaultServerGroup": {
    "id": 617692,
    "name": "INCOMING SERVERS",
    "created_at": "2024-12-12 16:44:59",
    "type": "instance",
    "location": null,
    "override_location": null
  },
  "nounOptions": { /* predicate vocabulary, see below */ },
  "actionValueOptions": { /* action vocabulary, see below */ },
  "applySubAccounts": false,
  "allowOverride": false,
  "isSubtenant": false,
  "canOverride": false
}
```

`defaultServerGroup` is the tenant's onboarding catch-all group ("INCOMING SERVERS" by default). Newly onboarded instances land here. **It is not a monitoring-policy auto-apply hook by itself** - see Auto-apply section below - but the parent ticket's auto-apply implementation will likely watch it.

Tenant flags (`applySubAccounts`, `allowOverride`, `isSubtenant`, `canOverride`) gate sub-tenant inheritance behavior. All four were `false` on the capture tenant; multi-tenant inheritance was not exercised.

### Predicate vocabulary: `nounOptions`

| Group | Count | Example option |
|---|---|---|
| `device_types` | 6 | `{ label: "FortiGate", value: "[sub_type]fortinet.fortigate" }` |
| `attribute_types` | grouped, ~300 total | `{ label: "Model", value: "attribute,fortigate.model" }` - value is `"attribute,<textkey>"` so the clause's `match_key` is the textkey portion |
| `tags` | 0 on capture tenant | likely `{ label, value }` shape |
| `applications` | 19 | `{ label: "DNS", value: "network.dns" }` |
| `container_hosts` | 0 | - |
| `vmware_integrations` | 0 | - |
| `vmware_hosts` | 0 | - |

`attribute_types` groups (head counts on the capture tenant):

| Group | # options | Notable textkeys |
|---|---|---|
| Attributes | 27 | tenant-defined attributes (e.g. `gregori`, `Environment`, `firstnameapp`) |
| Kubernetes | 183 | `kubernetes.cluster_name`, `kubernetes.kind`, `kubernetes.namespace`, ... |
| Server Configuration | 10 | `server.os`, `server.cpu_architecture`, `server.kernel_version`, ... |
| Network Device Configuration | 2 | `snmp_device_type`, `snmp_sysdescr` |
| Cloud | 17 | `cloud.aws.account_id`, `cloud.aws.instance_id`, ... |
| Container | 4 | `container.id`, `container.image`, ... |
| SNMP | 10 | `snmp.model`, `snmp.sysContact`, ... |
| NCM | 2 | `ncm.unimus.activated`, `ncm.unimus.deactivated` |
| Meraki | 4 | `meraki.model`, `meraki.serial`, ... |
| Fortinet | 4 | `fortinet.serial`, `fortinet.adom`, `fortinet.vdom`, `fortinet.path` |
| FortiGate | 9 | `fortigate.model`, `fortigate.os_version`, `fortigate.ha_mode`, `fortigate.mgmt_ip_str`, `fortigate.cluster_members`, ... |
| FortiSwitch | 7 | `fortiswitch.model`, `fortiswitch.os_version`, ... |
| FortiAP | 10 | `fortiap.ap_profile`, `fortiap.location`, ... |
| DEM | 10 | `dem.model`, `dem.ip`, `dem.location`, ... |
| FortiManager | 3 | `fortimanager.model`, `fortimanager.ha_mode`, `fortimanager.os_version` |
| FortiExtender | 1 | `fortiextender.name` |
| Fabric Settings | 1 | `fabric.distinct_requests` |

For the parent ticket's FortiGate-specific best-practice template attachment, the relevant attribute textkeys are the **FortiGate** group (especially `fortigate.model` and `fortigate.os_version`).

### Action vocabulary: `actionValueOptions`

| `action_type` | # values | Shape | Notes |
|---|---|---|---|
| `server_group` | 45 | `{ label, value: "sg-{id}" }` | Move matched instance into a server group. **Value prefix `sg-` is included** in the option but `action_value` strips the prefix to just the id (verify against UI behavior). |
| `apply_template` | 42 | `{ label, value: "{template_id}" }` | Attach a monitoring template. **The action used by FMN-193's Best-Practice template auto-apply.** Value is the bare numeric template id as a string. |
| `alert_timeline` | 2 | `{ label, value }` | Set alert timeline. `value: "-1"` means "inherit from group"; other values are alert timeline ids. |
| `location` | 6 | nested `{ label, options: [{ label, value, description }] }` | Set location. Grouped by region (Africa, Asia, etc. + OnSight Appliances). `value` may be negative for OnSight appliances. |
| `add_tags` | 0 on capture tenant | `{ label, value }` expected | Add tags. |
| `add_as_dem_location` | 9 | `{ label, value }` | Add the instance as a DEM (Digital Experience Monitoring) target location for one of the configured DEM apps (G Suite, Zoom, Teams, ...). |

---

## Auto-apply trigger semantics (the parent-ticket question)

**The ruleset schema has no auto-apply boolean.** No `enabled_for_onboard`, no `auto_evaluate`, no scheduling fields. The exercise was:

1. Open a ruleset → click "Test Workflow" → drawer renders (`GET ApplyPolicy`).
2. Operator selects target instances + optional `commit` flag → `POST applyPolicy` with `element_ids` + (optional) `commit=on`.
3. Server response: `{"error": false, "async": true}` - processed asynchronously when `commit=on`.

That is the **only** application path observed in the capture. There is no separate "auto-fire on new-instance onboard" endpoint visible from the Monitoring Policies page.

**Implication for FMN-193 (parent):**

- FortiMonitor's Monitoring Policies are an **explicit, on-demand** mechanism. The toolkit cannot persist an "auto-apply this ruleset to new FortiGates" rule on FortiMonitor's side using this API surface.
- To get the auto-apply behavior the parent ticket needs, the toolkit must implement it itself:
  1. Detect new instances (e.g. poll `/util/pending_servers` - observed in this capture as part of the SPA's heartbeat - or watch `/v2/server` for new ids).
  2. For each new instance, evaluate the matching ruleset toolkit-side (we have the predicate vocabulary in `nounOptions`).
  3. POST `applyPolicy` with `element_ids=s-{newId}&commit=on` for the matching ruleset.
- Alternative the deferred sub-ticket should investigate: whether the **server template** attached to `defaultServerGroup` ("INCOMING SERVERS") is FortiMonitor's de facto onboarding hook. If a Best-Practice template is attached to that group, new instances may inherit it automatically without any policy involvement. This is the cleanest path if it works.
- For periodic re-evaluation of existing instances against a ruleset (the other half of "auto-apply"), the toolkit can schedule `applyPolicy` calls itself - the endpoint is idempotent for `apply_template` (re-attaching an already-attached template is a no-op on FortiMonitor's side).

---

## `element_ids` prefix vocabulary (for `applyPolicy`)

`element_ids` is a comma-separated list. Each id is prefixed by its element type, matching the FMN-71 finding for the All-Instances DataTables checkbox column:

| Prefix | Meaning | Example |
|---|---|---|
| `s-` | Server / instance | `s-42024060` |
| `grp-` | Server group | `grp-617692` |
| `ap-` | OnSight appliance | `ap-17887` |
| `cs-` | Other (e.g. cloud service group) | `cs-13492` |

Selecting a group selects all instances within it (the SPA's `p-tree` component expands transitively). For toolkit code targeting one instance, `element_ids=s-{id}` is sufficient.

---

## Endpoint surface recommendation for FMN-193

| Need | Endpoint | Notes |
|---|---|---|
| List rulesets | `GET /monitoring_policy/get_page_data` | Returns rulesets + full predicate/action vocabulary in one shot. Cache it. |
| Create a ruleset | `POST /monitoring_policy/addRuleset` | Then immediately `editRuleset` to populate `config.rules`. |
| Replace a ruleset's rules | `POST /monitoring_policy/editRuleset` | Whole-config replace. There is no per-rule add/edit/delete endpoint - every edit posts the full `{rules: [...]}` array. |
| Rename | `POST /monitoring_policy/editRulesetMetadata` | Optional; only needed if renaming. |
| Delete | `POST /monitoring_policy/deleteRuleset` | - |
| Trigger against an instance | `POST /monitoring_policy/applyPolicy` | `element_ids=s-{id}&commit=on`. Async result; do not wait on the response for completion. |
| Look up attribute values | `GET /monitoring_policy/fetchAttributeOptions?attribute_textkey={textkey}` | Only when the UI needs a dropdown; toolkit code can read attribute values straight off the server record. |

**Session-auth only.** The v2 API is not in play for this surface.

---

## Quirks and gotchas

- **Typo: `upated`** in the response, not `updated`. Don't fix it client-side - match the wire format.
- **POST without `X-XSRF-TOKEN`.** Different from `/config/save_port_selection` (FMN-36). The SPA sends `Referer` and `X-Requested-With: XMLHttpRequest` but those weren't permuted in this session, so it isn't established whether the server requires them. Per FMN-135 the session cookie alone was sufficient for other session-auth endpoints; verify before stripping headers in extension code.
- **`editRuleset` is full-replace.** No partial-update endpoint. To add a rule, fetch via `getRuleset`, mutate the `rules` array, post the whole thing back.
- **`action_value` is a string**, even for numeric ids. `42157589`, not `42157589` as an int. The server appears to accept ints too but the wire format is string.
- **`alert_timeline` action_value `"-1"`** is the magic "inherit from group" sentinel. Other negative values appear on `location` for OnSight-appliance entries.
- **`server_group` action_value prefix.** The `actionValueOptions.server_group` entries have `value: "sg-{id}"`, but it's unclear (from this capture) whether `action_value` in a written rule should keep or strip the prefix. Verify on first use; the captured probe ruleset used `apply_template` only, not `server_group`.
- **No paging on `get_page_data`.** Returns everything in one response. The capture tenant had 2 rulesets and ~300 predicate options; tenants with hundreds of rulesets may see slow responses.
- **`config.rules` is the only mutable body**; `latest_version` is server-managed; `created` / `upated` are server-managed.
- **The "Default Monitoring Templates" server group** (`sg-617598` in the action vocabulary) parallels the partition convention used for stock templates (FMN-135). Stock rulesets (if any exist) may also live behind a name-based partition; none were observed in the capture.

---

## Example: create a ruleset that applies a template to all FortiGates running OS 7.4

```js
// (1) Create the ruleset shell.
const createRes = await fetch('https://fortimonitor.forticloud.com/monitoring_policy/addRuleset', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
  },
  body: new URLSearchParams({
    index: '0',
    name: 'Best-Practice FortiGate 7.4 template',
    description: '',
  }),
}).then((r) => r.json());

const rulesetId = createRes.ruleset.id;

// (2) Populate config.rules.
const config = {
  rules: [
    {
      enabled: true,
      name: 'Attach template',
      conditions: [
        {
          clauses: [
            { datatype: 'attribute', match_type: 'pick_one', match_key: 'fortigate.os_version', match_value: '7.4', error: false },
          ],
          operator: 'and',
        },
      ],
      actions: [
        { action_type: 'apply_template', action_value: '<template-id-as-string>' },
      ],
    },
  ],
};

await fetch('https://fortimonitor.forticloud.com/monitoring_policy/editRuleset', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
  },
  body: new URLSearchParams({
    ruleset_id: String(rulesetId),
    config_json: JSON.stringify(config),
  }),
});

// (3) (Optional) Trigger immediately against a known instance.
await fetch('https://fortimonitor.forticloud.com/monitoring_policy/applyPolicy', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
  },
  body: new URLSearchParams({
    element_ids: 's-42024060',
    commit: 'on',
  }),
});
```

---

## Capture provenance

- Capture file: `tools/discovery/fmn-194-capture-2026-05-13.json` (gitignored).
- Discovery script: `tools/discovery/fmn-194-monitoring-policies-capture.mjs`.
- Driven by operator on 2026-05-12 against `https://fortimonitor.forticloud.com/`. Lifecycle exercised: list, create ("FMN-194 capture probe", id 8812), edit metadata, edit rules (three iterations on `editRuleset` capturing the version bump), delete, plus apply-workflow test on a separate pre-existing ruleset (id 8373).
- 22 policy-shaped requests captured; 17 candidate-URL probes for non-existent v2 endpoints (all returned 200 + SPA shell, confirming no v2 resource).
