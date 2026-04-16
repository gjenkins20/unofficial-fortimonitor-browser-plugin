# FortiCloud Port Scope API Contract

Captured from live FortiCloud UI on 2026-04-16 against test device FGVM01TM24006844 (server 42024060). This is the internal UI-only API that the browser extension will consume to provide per-port monitoring scope control — the capability missing from the FortiMonitor v2 public API (see FMN-34).

---

## Endpoints

### `GET /onboarding/getDevicePorts?server_id={server_id}`

Returns the current port selection state for a device.

**Response** (`200`, `application/json`):

```json
{
  "data": {
    "filter_type": "all",
    "portFilters": {
      "searchTerm": "",
      "filters": []
    },
    "ports": [
      {
        "name": "port1",
        "index": "0",
        "alias": "",
        "descr": null,
        "admin_status": "Unknown",
        "oper_status": "Unknown",
        "isActive": true,
        "isDisabled": false,
        "hasFilterMatch": false,
        "searchValues": ["port1"],
        "templateId": null,
        "templateName": null
      }
    ]
  }
}
```

Field notes:

| Field | Type | Meaning |
|---|---|---|
| `data.filter_type` | `"all" \| "none" \| "manual" \| "name"` | Current selection mode |
| `data.portFilters.searchTerm` | string | Filter term (used when `filter_type == "name"`) |
| `data.portFilters.filters` | array | Structured filters (used when `filter_type == "name"`; empty otherwise) |
| `data.ports[].name` | string | Interface name (e.g., `port1`, `fortilink`) |
| `data.ports[].index` | **string** representation of integer | Stable ordinal used as the identifier in save payloads |
| `data.ports[].isActive` | boolean | Whether this port is currently selected for monitoring |
| `data.ports[].isDisabled` | boolean | Whether the UI disables toggling this port |
| `data.ports[].admin_status`, `oper_status` | string | Per-port status (may be `"Unknown"` on devices without live telemetry) |

### `POST /config/save_port_selection?<query-params>`

Writes a new port selection for a device. **All parameters are sent as URL query string**, despite the `Content-Type: application/x-www-form-urlencoded` header. The request body is empty.

**Request:**

```
POST /config/save_port_selection?serverId=42024060&filters=%5B%5D&portSelectionType=all&searchTerm=&totalPortCount=3&selectedPorts%5B%5D=0&selectedPorts%5B%5D=1&selectedPorts%5B%5D=2

Headers:
  Accept: application/json, text/plain, */*
  Content-Type: application/x-www-form-urlencoded
  X-XSRF-TOKEN: <verbatim XSRF-TOKEN cookie value>
  Cookie: XSRF-TOKEN=...; <session cookie (HttpOnly)>

Body: (empty)
```

**Query parameters:**

| Key | Value | Notes |
|---|---|---|
| `serverId` | integer | FortiMonitor server id |
| `filters` | JSON-serialized array | `"[]"` when not using `name` filter mode |
| `portSelectionType` | `"all"` \| `"none"` \| `"manual"` \| `"name"` | Selection mode |
| `searchTerm` | string | Empty string when not using `name` mode |
| `totalPortCount` | integer | Total number of ports on the device (from GET response `ports.length`) |
| `selectedPorts[]` | repeated integer | One repetition per selected port, using `ports[].index` values from GET. Always sent, even when `portSelectionType="all"` or `"none"` (in the `"all"` capture, all indices were listed; `"none"` behavior not yet captured but expected to be zero repetitions). |

**Response** (`200`, `application/json`):

```json
{"success": true}
```

---

## Auth mechanism

Two components:

1. **Session cookie** — HttpOnly, set at FortiCloud login, sent automatically by the browser. Not readable from JavaScript. Not visible in `document.cookie`.
2. **CSRF token** — a non-HttpOnly cookie named `XSRF-TOKEN` (127-char opaque string). The UI sends it back as the `X-XSRF-TOKEN` request header on state-changing calls. The header value equals the cookie value verbatim (no URL decoding required — the cookie is stored un-encoded).

This is the standard Angular/Axios XSRF convention (`axios` by default reads `XSRF-TOKEN` cookie and mirrors it into `X-XSRF-TOKEN` header for same-origin requests).

**For a Manifest V3 service worker:**

- `fetch()` with `credentials: 'include'` will send both cookies automatically, provided `host_permissions` in the manifest includes `https://fortimonitor.forticloud.com/*`.
- The service worker cannot read `document.cookie` (no DOM). Use `chrome.cookies.get({ url: 'https://fortimonitor.forticloud.com', name: 'XSRF-TOKEN' })` to read the token for the `X-XSRF-TOKEN` header. Manifest must include the `cookies` permission and host permission for the target domain.
- Requests from the service worker are same-origin with respect to the cookie jar (host permissions grant access). No CORS preflight issues observed in UI traffic, but MV3 fetch does not perform CORS checks the way a content script would — treat failures as actionable.

---

## Mode-specific payload shapes

Captured:

| Mode | Captured payload shape |
|---|---|
| `all` | All `selectedPorts[]` indices present (`0`, `1`, `2`). Server behavior is consistent with "select all regardless of list" — the list appears redundant but is always sent by the UI. |
| `manual` | Only selected indices in `selectedPorts[]`. This is the per-port granular control path. |

Not yet captured (inferred):

| Mode | Expected payload shape |
|---|---|
| `none` | `selectedPorts[]` likely absent or empty. Destructive — skips provisioning entirely. |
| `name` | `searchTerm` and `filters` populated; `selectedPorts[]` may be computed server-side from the filter match. |

If the plugin only needs WAN-interface-level granularity (enable/disable specific ports), **`portSelectionType=manual`** with an explicit `selectedPorts[]` list is the only mode required.

---

## Destructive behavior reminder

From FMN-34: deselecting a port via this endpoint **deletes** that port's `agent_resource` rows and their metric history. It does not suspend them. There is no soft-delete. The plugin must confirm with the user before any operation that removes a port from the selection.

---

## Example: programmatic port deselection

See [`port-scope-snippet.js`](./port-scope-snippet.js) for a minimal MV3 service-worker-compatible implementation.
