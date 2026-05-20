# FortiMonitor Monitoring Tree API Contract

Captured from a live FortiMonitor capture archive (`tools/discovery/fmn-199-capture-2026-05-13.json`) on 2026-05-13. This is the session-authenticated internal endpoint that powers FortiMonitor's nested group / server / template tree (used by the SPA's left-nav and the various server-group picker dialogs).

Documented for FMN-224 to drive Bulk Composer's new "load devices from server group(s)" input mode, but the surface is reusable - any future tool that needs an inventory of groups + members can pull from the same endpoint without a v2 API key.

---

## Endpoint

### `POST /util/monitoring_tree?include_templates=1`

Returns the full nested group tree, with server and template leaves attached at their group nodes.

**Request:**

```
POST /util/monitoring_tree?include_templates=1

Headers:
  Accept: application/json, text/plain, */*
  Cookie: <session cookie (HttpOnly)>
  X-XSRF-TOKEN: <value from XSRF-TOKEN cookie>   (mimics browser; see auth note)

Body: <empty>
```

**Auth note:** the captured browser request included `X-XSRF-TOKEN`. We have not verified whether the header is strictly required for this endpoint (the memory note for FMN-135 found several SPA endpoints accept session cookie alone, but `monitoring_tree` was not on that probe list). The plugin sends `X-XSRF-TOKEN` when the cookie is present to match the browser exactly; if the cookie is missing the request still goes out without the header and a 403 there would be the failure signal.

**Response** (`200`, `application/json`, ~26KB for a tenant with ~60 groups + ~100 servers):

```json
{
  "userHash": "258624-308609-1778644138-fcc01242dadeb5caefd1d362f5a84e79",
  "nodes": [
    {
      "id": "grp-0",
      "node-type": "group",
      "icon_title": "Server Group",
      "text": "All Instances",
      "children": [
        {
          "id": "grp-617598",
          "node-type": "group",
          "text": "Default Monitoring Templates",
          "children": [
            { "id": "s-41913280", "node-type": "template", "text": "Linux - Core",
              "href": "/report/InstanceDetails?server_id=41913280", "children": false },
            ...
          ]
        },
        {
          "id": "grp-928375",
          "node-type": "group",
          "text": "Digital_Experience_Monitoring",
          "children": [
            { "id": "grp-929056", "node-type": "group", "text": "us-east-1",
              "children": [ { "id": "s-42154820", "node-type": "server", "text": "DEM_Lab-A" } ] },
            { "id": "s-42157265", "node-type": "server", "text": "www.office.com" }
          ]
        }
      ]
    }
  ]
}
```

### Node taxonomy

| `node-type`  | `id` prefix | Meaning                              | FMN-224 treatment              |
|--------------|-------------|--------------------------------------|--------------------------------|
| `group`      | `grp-{n}`   | A server group                       | Listed in picker               |
| `server`     | `s-{n}`     | A real device                        | Counted as a member            |
| `server`     | `a-{n}`     | An OnSight appliance                 | Skipped (surfaced in skip count) |
| `server`     | `cs-{n}`    | A compound service                   | Skipped (surfaced in skip count) |
| `template`   | `s-{n}`     | A monitoring template                | Skipped (templates aren't devices) |

The `s-` / `a-` / `cs-` prefix on `id` is the durable type discriminator. `node-type` is the same `"server"` for all three "real instance" variants - the prefix is how you tell them apart. Templates also use `s-{n}` for `id`, so `node-type` is the only thing distinguishing a template leaf from a server leaf in the same group.

### Nesting

The tree is genuinely hierarchical. A group's `children` array can contain other groups, which can in turn contain more groups + servers. Root is always `grp-0` "All Instances" (FortiMonitor's catch-all).

The FMN-224 picker treats group membership recursively: picking `grp-928375` (Digital_Experience_Monitoring) includes every server reachable through its child groups, not just the direct children. Operators expect "apply this action to all devices in DEM" rather than "apply to whatever DEM directly contains."

### Other related variants (not consumed by FMN-224)

The same path supports several query-string permutations the SPA uses for different dialogs:

- `?only_groups=true&include_compound_services=false&selectable_root=0` - groups only, no server / template leaves (~10KB). Used by group picker dialogs that don't show membership.
- `?include_templates=1&user_hash={hash}` - subsequent fetches; the `userHash` from the first response is echoed back. We have not verified whether the param is load-bearing or just telemetry.
- `POST /util/monitoring_tree_deferred?node_id={grp-id}&include_servers=true&...` - lazy-loads a single subtree. Not needed when the full tree fits in one round-trip (~26KB observed).

### Failure modes

- **Session expired / not logged in:** FortiMonitor returns HTTP 200 with an HTML login-page body. `getMonitoringTree()` detects the non-JSON `content-type` and throws `FortimonitorError(phase: 'auth')`.
- **Non-2xx HTTP:** thrown as `FortimonitorError(phase: 'read')` with the status preserved.
- **Empty / malformed JSON:** `parseMonitoringTree()` is defensive - returns `{ groups: [] }` for null / non-object / missing `nodes` inputs.

---

## Why this endpoint over `/report/server_group_inventory_data`

`/report/server_group_inventory_data?server_group_id={id}&draw=...&start=0&length=...` is the DataTables AJAX feed that powers the `/report/ServerGroupReport` page (per FMN-71). It returns a single group's members in DataTables row shape.

We picked `monitoring_tree` over it for FMN-224 because:

1. **One round-trip vs N.** A tenant with 59 groups would need 59 GETs against `server_group_inventory_data` to enumerate them all; `monitoring_tree` returns the whole thing in one POST.
2. **Smaller total payload.** ~26KB vs ~5-50KB per group call (depends on member count). Even at the high end, 1 × 26KB << 59 × 5KB.
3. **Tree shape preserved.** Nested-group semantics are visible in the response, so the picker can render group hierarchy and roll up descendant counts without extra calls.
4. **No DataTables draw/start/length state to manage.** The DataTables endpoint expects pagination params that don't map cleanly to "give me everything."

The downside: stale data is staler. `monitoring_tree` is fetched once when the picker opens, so a device onboarded mid-session won't appear until the operator reopens the picker. For Bulk Composer this is fine - the operator is making a single decision and the data freshness window is seconds. If a future tool needs live-membership semantics, `server_group_inventory_data` is the right choice.

---

## Consumers

- **`extension/src/lib/fortimonitor-client.js`** `getMonitoringTree()` - the fetch wrapper.
- **`extension/src/lib/monitoring-tree.js`** `parseMonitoringTree()` / `unionMembers()` - the pure parser + group-union helper.
- **`extension/src/background/bulk-composer-handlers.js`** `bulk-composer:list-server-groups-tree` - the SW handler that wires the two together for the Bulk Composer picker (FMN-224).
