# FortiMonitor Fabric Connection API Contract

This is the **v2 public API** surface used by the *Add Fabric Connection (Bulk)* tool. Unlike port-scope (which lives only in the FortiMonitor internal UI), fabric_connection has a clean v2 endpoint, so this tool uses API-key auth instead of FortiMonitor session auth. See project memory `no_fortimonitor_api.md` for the per-tool auth-choice rule.

Source: sibling project at `~/Projects/fortimonitor_fabric_connection/` (Python CLI v1.1) plus its `FortiMonitor_Fabric_Connection_API_Guide_Draft.md`.

---

## Auth

```
Authorization: ApiKey {rw_api_key}
Content-Type: application/json
Accept: application/json
```

- **Read/Write key required.** A read-only key returns 401 on POST.
- The literal text `ApiKey` precedes the token, separated by a single space.
- No session→API-token exchange exists: the user must paste a key. Stored in `chrome.storage.local` under `panopta.apiKey`.

---

## Endpoints

### `POST /v2/fabric_connection`

Creates one OnSight CSF (Security Fabric) tunnel connection for one FortiGate device.

**Base URL:** `https://api2.panopta.com/v2`

**Request body** (`application/json`):

```json
{
  "integration_type": "onsight_csf_tunnel",
  "label": "FortiGate-Branch-Office",
  "onsight": "https://api2.panopta.com/v2/onsight/{onsight_id}",
  "server_group": "https://api2.panopta.com/v2/server_group/{server_group_id}",
  "appliance_group": "https://api2.panopta.com/v2/onsight_group/{onsight_group_id}",
  "upstream_host": "10.0.0.94",
  "upstream_port": 8013,
  "upstream_sn": "FGVM01TM24006844",
  "fortios_version": 7,
  "discover_frequency": 60,
  "verify_ssl_cert": false,
  "import_immediately": false
}
```

#### Required fields

| Field | Type | Notes |
|---|---|---|
| `integration_type` | string | Always `"onsight_csf_tunnel"` for this tool. |
| `onsight` | string | Full resource URL of the OnSight instance. Get from `GET /v2/onsight`. |
| `server_group` | string | Full resource URL of the server group. Get from `GET /v2/server_group`. |
| `upstream_host` | string | FortiGate management IP. |
| `upstream_port` | integer | FortiGate management port (commonly `8013` or `541`). |
| `upstream_sn` | string | FortiGate serial number. |

#### Optional fields with defaults

| Field | Type | Default | Notes |
|---|---|---|---|
| `label` | string | `upstream_host` | Friendly name shown in FortiMonitor UI. |
| `discover_frequency` | integer | `60` | Discovery frequency in seconds. |
| `fortios_version` | integer | `7` | FortiOS major version (`6` or `7`). |
| `verify_ssl_cert` | boolean | `false` | Whether to validate the FortiGate cert. |
| `import_immediately` | boolean | `false` | Import environment immediately after creation. **The tool always sends `true`** (FMN-266): without it the device is created but discovery only runs on the next scheduled poll, so "add device" wouldn't kick off discovery. The API default is `false`; the tool overrides it via `executeFabricBatch({ importImmediately: true })` (the default for that param). |

#### Conditionally required

| Field | When required |
|---|---|
| `appliance_group` | When the target OnSight is HA-clustered. Full resource URL from `GET /v2/onsight_group`. Despite the field name, this points to an `onsight_group/` resource. |

**Success response** (`201 Created`):

Headers:
```
location: https://api2.panopta.com/v2/fabric_connection/{new_id}
id: {new_id}
Content-Type: application/json
```

Body:
```json
{
  "id": 98765,
  "integration_type": "onsight_csf_tunnel",
  "label": "FortiGate-Branch-Office",
  "upstream_host": "10.0.0.94",
  "upstream_sn": "FGVM01TM24006844",
  "status": "created"
}
```

#### Error responses

| Status | Cause | Retry? |
|---|---|---|
| `400` | Invalid request body or missing required field. Body has `{ error, message, details: { field, expected } }`. | No - fix payload. |
| `401` | Invalid / missing / read-only API key. | No - re-prompt for key. |
| `405` | Method other than POST used. | No - bug. |
| `408`, `425`, `429`, `500`, `502`, `503`, `504` | Transient. | Yes - backoff + retry per `lib/retry.js`. |

> **Latency caveat from API guide:** "Error Creating Persistent Fabric Connection" may surface immediately after a successful 201 if the FortiMonitor Control Panel is busy. Allow ~5 minutes before treating it as a real failure when verifying via the UI. The 201 itself is the source of truth for the API outcome.

---

### `GET /v2/onsight`

Lists OnSight instances available to the API key. Used to populate the OnSight dropdown in the tool's Load step.

Response shape (Panopta v2 standard):

```json
{
  "meta": { "limit": 50, "offset": 0, "total_count": 3 },
  "objects": [
    {
      "id": 16966,
      "name": "OnSight - Branch Region",
      "resource_uri": "/v2/onsight/16966"
    }
  ]
}
```

The full resource URL the POST expects is built as `https://api2.panopta.com{resource_uri}`.

### `GET /v2/server_group`

Lists server groups (instance groups). Same response shape as `/v2/onsight`. Used for the server-group dropdown.

### `GET /v2/onsight_group`

Lists OnSight HA groups. Same response shape. Used for the optional appliance-group dropdown when the selected OnSight is part of an HA pair.

> **Note:** Pagination via `?limit=` / `?offset=` is supported. For account sizes typical of this tool, `?limit=100` is enough for a single fetch. If `meta.total_count > limit`, fall back to paged fetches.

---

## Test-Connection probe

For the settings UI's "Test Connection" button, call:

```
GET /v2/onsight?limit=1
```

with the user's pasted key. `200` confirms the key is valid and has at least read permission. `401` confirms invalid/missing key. Any other status surfaces the body to the user.

This probe doesn't verify RW vs RO; that surfaces only on the actual POST. Document this caveat in the settings UI.

---

## Reference snippet

A minimal fetch-based equivalent (matches what `lib/panopta-client.js` ships):

```js
const res = await fetch('https://api2.panopta.com/v2/fabric_connection', {
  method: 'POST',
  headers: {
    'Authorization': `ApiKey ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  body: JSON.stringify({
    integration_type: 'onsight_csf_tunnel',
    onsight: onsightResourceUrl,
    server_group: serverGroupResourceUrl,
    upstream_host: ip,
    upstream_port: port,
    upstream_sn: serial
  })
});
```
