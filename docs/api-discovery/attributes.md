# FortiMonitor Server Attributes API Contract

This is the **v2 public API** surface used by the *Add/Remove Attributes* tool (FMN-48). Auth choice follows the FMN-45 per-tool rule: attribute mutation is exposed cleanly in v2, so this tool uses the user-supplied RW API key (same `chrome.storage.local` key as the Fabric Connection tool), not FortiMonitor session auth.

Source: live-captured schemas and response samples from the sibling project at `~/Projects/fortimonitor-schema-discovery/` (Swagger 1.2 → OpenAPI 3.0 pipeline). Originally captured 2026-04-15 against production account. Validated against `data/FORTIMONITOR_API_DOCS_v2.md` and `data/response_samples/`.

---

## Two-resource model

Attributes in FortiMonitor are modeled as two distinct resources:

| Resource | What it represents | Scope |
|---|---|---|
| `server_attribute_type` | The attribute **definition** (the "key") — has a `name` and a `textkey`. | Customer-global. Referenced by multiple servers. |
| `server_attribute` | An attribute **value** attached to a specific server — has a `value` plus a pointer to its type. | Per-server. |

**Implication for the plugin:** to add `{Environment: prod}` to a server, the type `Environment` must already exist (either auto-populated by FortiMonitor or previously created). The tool has two reasonable UX paths:

1. **Pick-from-existing** (simpler): populate a dropdown from `GET /server_attribute_type`, then POST the value. Fails cleanly if the user wants a type that doesn't exist.
2. **Type-and-create** (convenience): let the user type a new type name; if it doesn't match an existing type, auto-POST `/server_attribute_type` first, then POST the attribute value using the returned URL.

---

## Auth

```
Authorization: ApiKey {rw_api_key}
Content-Type: application/json
Accept: application/json
```

- **Read/Write key required** for POST/DELETE. RO key is sufficient for GET.
- Same key used by the Fabric Connection tool — `chrome.storage.local['panopta.apiKey']`.
- Base URL: `https://api2.panopta.com/v2`.

---

## Endpoints

### `GET /server/{server_id}/server_attribute`

List all attributes attached to a server.

**Query params:**

| Name | Type | Default | Notes |
|---|---|---|---|
| `full` | boolean | `false` | If `true`, resolves `server_attribute_type` URL to the full object inline. |
| `limit` | integer | `50` | Page size. `0` returns all. |
| `offset` | integer | `0` | Pagination offset. |
| `order_by` | string | — | Field to sort on. |
| `order` | string | — | `asc` or `desc`. |

**Success response** (`200 OK`):

```json
{
  "meta": {
    "limit": 2,
    "offset": 0,
    "previous": null,
    "next": "https://api2.panopta.com/v2/server/40234446/server_attribute?limit=2&offset=2",
    "total_count": 5
  },
  "server_attribute_list": [
    {
      "name": "Server Origin",
      "textkey": "server.origin",
      "value": "agent",
      "server_attribute_type": "https://api2.panopta.com/v2/server_attribute_type/315",
      "url": "https://api2.panopta.com/v2/server/40234446/server_attribute/350536706"
    },
    {
      "name": "Operating System",
      "textkey": "server.os",
      "value": "Linux",
      "server_attribute_type": "https://api2.panopta.com/v2/server_attribute_type/290",
      "url": "https://api2.panopta.com/v2/server/40234446/server_attribute/350536728"
    }
  ]
}
```

Note that `name` and `textkey` are denormalized from the referenced type — the plugin does not need a separate lookup to display them. The `url` field contains the `{server_attribute_id}` needed to DELETE.

---

### `POST /server/{server_id}/server_attribute`

Attach an attribute value to a server.

**Request body:**

```json
{
  "server_attribute_type": "https://api2.panopta.com/v2/server_attribute_type/{id}",
  "value": "prod"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `server_attribute_type` | string (URI) | yes | Full resource URL of an existing attribute type. |
| `value` | string | yes | The attribute value. |

**Success response:** `201 Created`. The `Location` response header contains the URL of the new `server_attribute`; the `id` response header contains the new id.

---

### `DELETE /server/{server_id}/server_attribute/{server_attribute_id}`

Remove an attribute from a server.

**Success response:** `204 No Content`.

---

### `GET /server_attribute_type`

List all attribute types (keys) the customer owns — both auto-populated (e.g. `server.origin`, `server.os`) and user-created.

**Query params:** `full`, `limit`, `offset`, `order_by`, `order` (same semantics as above).

**Success response** (`200 OK`):

```json
{
  "meta": { "limit": 2, "offset": 0, "previous": null, "next": "...", "total_count": 183 },
  "server_attribute_type_list": [
    { "name": "Environment", "textkey": "Environment", "url": "https://api2.panopta.com/v2/server_attribute_type/14629" },
    { "name": "gregori",     "textkey": "gregori",     "url": "https://api2.panopta.com/v2/server_attribute_type/14641" }
  ]
}
```

Live observation: 183 types on the production test account. System-populated types use dotted `textkey`s (`server.origin`, `server.os`); user-created types reuse the `name` as the `textkey`.

---

### `POST /server_attribute_type`

Create a new attribute type (key).

**Request body:**

```json
{ "name": "Environment" }
```

**Success response:** `201 Created`. `Location` and `id` headers return the new resource pointer.

---

### `DELETE /server_attribute_type/{server_attribute_type_id}`

Delete an attribute type. `204 No Content`.

**Destructive.** Out of scope for v1 of the plugin — we manipulate *values*, not definitions.

---

### `PUT /server_attribute_type/{server_attribute_type_id}`

Rename an attribute type. Body is `{ "name": "..." }`. `204 No Content`.

Out of scope for v1.

---

## Error codes

Standard v2 error model:

| Code | Meaning |
|---|---|
| `400` | Validation error — check response body. E.g. POST with a `server_attribute_type` URL that doesn't exist. |
| `401` | Missing/invalid API key, or RO key used on a write. |
| `404` | Unknown `server_id`, `server_attribute_id`, or `server_attribute_type_id`. |
| `405` | Wrong method on the endpoint. |
| `500` | Server-side failure. |

---

## Open questions (not blocking v1)

- **Soft cap on attributes per server?** Not documented. Test account has 5 on one server; no cap observed.
- **Multi-server batch?** No dedicated batch endpoint — multi-server apply is one POST per server. Bounded concurrency (4) matches the pattern in `lookupBatch`.
- **Uniqueness:** can the same `server_attribute_type` have multiple values on the same server? The docs list `value` as a plain string, not an array, which hints "one value per type per server." Needs a live probe to confirm — POST a second value for the same type and see whether it replaces, errors, or stacks.
