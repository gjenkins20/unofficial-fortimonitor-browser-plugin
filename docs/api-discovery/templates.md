# Server Template API Contract (v2)

Covers the endpoints the bulk templates tool (FMN-49) uses to list, attach, and
detach monitoring templates on servers. Source: FortiMonitor v2 Swagger 1.2
schema (`~/Projects/fortimonitor-schema-discovery/data/raw_schemas/server.json`
and `server_template.json`) plus live response samples from that project's
`data/response_samples/`.

All endpoints are under `https://api2.panopta.com/v2`. Auth is
`Authorization: ApiKey {key}` - same pattern `PanoptaClient` already uses for
Add Fabric Connection (FMN-45) and Manage Attributes (FMN-48).

## Resource model

The FortiMonitor "template" concept we care about is `server_template`: a bundle
of service checks, metric counters, and attributes that can be applied to one
or more servers. The attach/detach relationship lives **on the server side** as
a mapping resource - there is no way to attach/detach via the template's own
endpoints. The template's `applied_servers[]` field is a read-only projection.

Each template has a `template_type` (e.g. `dem_template`). For this tool's v1
we do not filter on type - the operator picks any template by name.

## Endpoints

### List available templates (catalog)

```
GET /v2/server_template?limit=100&offset=0
```

Query params:
- `limit` (default 50, `0` = unbounded), `offset` - standard pagination
- `name` - substring filter (same contains-match as `/v2/server?name=` per
  FMN-45 findings; client must re-filter for exact match if needed)
- `tags`, `attributes`, `server_group` - additional filters

Response:

```json
{
  "meta": { "limit": 2, "offset": 0, "next": ".../v2/server_template?limit=2&offset=2", "previous": null, "total_count": 40 },
  "server_template_list": [
    {
      "url": "https://api2.panopta.com/v2/server_template/40430873",
      "name": "Developers",
      "template_type": "dem_template",
      "server_group": "https://api2.panopta.com/v2/server_group/621243",
      "applied_servers": [ "https://api2.panopta.com/v2/server/40430881" ],
      "attributes": [ /* seeded attribute values */ ],
      "notification_schedule": null,
      "primary_monitoring_node": null,
      "auxiliary_notification_schedules": [],
      "tags": []
    }
  ]
}
```

Used by the tool's start step for the template picker. Pull with `limit=100`
and follow `meta.next` until exhausted - tenants in the wild have ≥40.

### List templates attached to a server

```
GET /v2/server/{server_id}/template
```

Response:

```json
{
  "meta": { "limit": 2, "offset": 0, "next": null, "previous": null, "total_count": 0 },
  "server_template_list": [
    /* $GetServerTemplateMappingResource */
    { "continuous": true, "server_template": "https://api2.panopta.com/v2/server_template/40430873" }
  ]
}
```

Note the mapping resource shape is **different** from the catalog resource:
catalog entries are full templates, attached entries are `{continuous,
server_template(url)}` pairs. The mapping list reuses the `server_template_list`
key, which is mildly misleading.

Used by the tool's review step to pre-flight (skip attach when already
attached; skip detach when not attached).

### Attach a template to a server

```
POST /v2/server/{server_id}/template
Content-Type: application/json

{ "continuous": true, "server_template": "https://api2.panopta.com/v2/server_template/{id}" }
```

Success: `201 Created`. The `location` header contains the mapping URL; `id`
header contains the mapping id. Response body is empty (`void`).

The `continuous` field controls whether the template continues to add new
metrics to the server as data collection discovers them. **Default the tool to
`true`** unless the operator flips a dedicated checkbox - matches the FortiMonitor
UI default and is the low-surprise behavior.

Errors:
- `400` - validation (e.g. template belongs to a different server_group,
  malformed URL)
- `401` - auth: bad/missing API key
- `404` - server or template not found
- `405` - method not allowed (typo on URL)
- `500` - server-side

### Detach a template from a server

```
DELETE /v2/server/{server_id}/template/{server_template_id}
Content-Type: application/json

{ "strategy": "dissociate" }
```

Path uses the **template id** (not the mapping id) - simpler for the client.

Success: `204 No Content`.

Strategy parameter (optional body):
- `"dissociate"` (default) - removes the association only. Metrics/attributes
  previously seeded by the template stay on the server.
- `"delete"` - removes the association **AND** removes all metrics and
  attributes the template added. **Destructive.**

**UX requirement:** the start step exposes this as a radio: "Dissociate (keep
metrics)" vs. "Delete (remove metrics seeded by this template)". The typed
confirmation gate echoes whichever was chosen so the operator cannot
sleep-walk into the destructive variant.

Errors:
- `401` / `404` / `405` / `500` - as above. Detaching a template that is not
  currently attached returns `404`, which the bulk runner treats as
  skipped-no-change (parity with the attribute tool's remove-of-absent
  behavior).

## Sequencing for bulk operations

Per (server, template) pair, in either direction, is one HTTP call. No batch
endpoint exists. Plan accordingly:

- Default concurrency: 4 (matches FMN-45 / FMN-48).
- Pre-flight: call `GET /v2/server/{id}/template` once per target server to
  compute skip set for dry-run preview.
- Attach idempotence: the API accepts repeat `POST` of an already-attached
  template and creates a second mapping (confirmed by the `id` header
  semantics - each POST creates a new mapping row). The tool dedupes client
  side against the pre-flight list rather than relying on server-side
  idempotence.
- Detach of non-attached: returns `404`, treat as skipped.
- Hard-stop triggers: `401` (auth failure) and `403` (RO key) bail out the
  whole run.

## Open items (resolve during lab test, Step 9)

- Confirm that a second POST of an already-attached template really does
  create a duplicate mapping vs. being a no-op. The schema implies duplicate
  but only live testing settles it. If duplicate, our pre-flight dedupe is
  load-bearing.
- Confirm `strategy=delete` destructiveness against a test server: does it
  wipe agent_resources the template seeded, or only attribute values?
- Confirm behavior when detaching a template whose `template_type` is
  `dem_template` vs. other types - any edge behavior.
- Cross-group attach: the catalog entries carry a `server_group`. Can a
  template be attached to a server in a different group, and what happens if
  that is attempted?
