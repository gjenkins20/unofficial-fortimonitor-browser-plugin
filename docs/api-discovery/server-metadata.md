# FortiMonitor Server Metadata API Contract

Captured from live FortiMonitor UI on 2026-04-20 against test device FGVM01TM24006844 (server 42024060) plus two additional test IDs (42024061, 42024075). This is the session-authenticated internal UI endpoint that powers the Instance Detail Page, used here to resolve server IDs → human-readable names for FMN-61. Unlocks auto-population of the `device_name` column in the step-3 queue CSV.

Discovery path: the Instance Detail Page at `/report/Instance/{server_id}/details` is a Vue SPA shell (the initial HTML from the server does not contain the server name - `markerCount: 0` for the name in the raw response body). The Vue app hydrates by calling a `getPageData()` method on the instance-page component, which issues the XHR documented below.

---

## Endpoint

### `GET /report/get_idp_data?server_id={server_id}`

Returns a large JSON payload containing metadata for a single device. `idp` = "Instance Detail Page".

**Request:**

```
GET /report/get_idp_data?server_id=42024060

Headers:
  Accept: application/json
  Cookie: <session cookie (HttpOnly)>
```

No XSRF token required (GET, non-mutating).

**Response** (`200`, `application/json`, ~49KB per device):

```json
{
  "success": true,
  "device_tree_id": "...",
  "device_tree_parents": [ ... ],
  "breadcrumbs": [ { "text": "...", "href": "..." }, ... ],
  "pageData": {
    "instance": {
      "id": 42024060,
      "name": "FGVM01TM24006844",
      "formattedName": "FGVM01TM24006844 (10.0.0.94)",
      "fqdn": "10.0.0.94",
      "status": "active",
      "deviceType": "network_device",
      "deviceSubType": "fortinet.fortigate",
      "serverKey": "kcne-fou5-ptqn-ovjf",
      "serverGroup": { "id": ..., "name": "..." },
      "serverGroups": [ ... ],
      "appliance": { "id": ..., "name": "...", "canPerform": [...] },
      "portConfig": { "portSelectionType": "..." },
      "tags": [ ... ],
      "nonSystemAttributes": [ ... ],
      "monitoredSince": "2025-09-05 10:39 PDT",
      "lastSyncDateTime": "2025-11-05 11:25:17 PST",
      "availability": { "day": ..., "week": ..., "month": ... },
      "isFabric": true,
      "isFabricDown": true,
      "hasOnsight": true,
      "...": "~80 other fields"
    },
    "timezone": "...",
    "customer": { ... },
    "accessLevel": "...",
    "originalUser": { ... },
    "activeEvents": [ ... ],
    "monitoringConfig": { ... },
    "apps": [ ... ],
    "...": "other pageData fields"
  }
}
```

Field notes:

| Field | Type | Meaning |
|---|---|---|
| `pageData.instance.id` | integer | Server id (matches `server_id` query param) |
| `pageData.instance.name` | string | **Human-readable server name** - what the operator sees in the UI breadcrumbs and page title |
| `pageData.instance.formattedName` | string | `"{name} ({fqdn})"` - useful for display contexts that want both |
| `pageData.instance.fqdn` | string | Primary host/IP - **only the first entry of `fqdns[]`**. Do not rely on this alone (see FMN-153 note below). |
| `pageData.instance.fqdns` | array of `{ fqdn, ipTypes }` | **Full list of host/IP entries for the instance.** Source of truth; the scalar `.fqdn` is just `fqdns[0].fqdn`. |
| `pageData.instance.deviceSubType` | string | e.g., `"fortinet.fortigate"` - useful filter for FortiGate-only tools |
| `pageData.instance.serverKey` | string | Internal key (not used by plugin) |
| `pageData.instance.status` | string | `"active"` for normal devices |
| `success` | boolean | Set on successful JSON responses |

The plugin uses only `pageData.instance.name` (and optionally `formattedName` for display). The other ~85 fields are ignored but documented here in case future tools need them.

### FMN-153 finding: `fqdns[]` array, and `ipTypes` is unreliable

Captured 2026-05-11 against 19 representative instances on a production tenant.

`pageData.instance.fqdns` is the canonical list of address entries for the instance. Each entry has the shape `{ fqdn: string, ipTypes: "v4" | "v6" | ... }`. The scalar `pageData.instance.fqdn` is simply `fqdns[0].fqdn`; relying on it alone misses every secondary address.

**The `ipTypes` hint is not trustworthy** - it appears to record the type chosen at instance-configuration time, not the actual content. Observed cases on the captured tenant:

| `fqdns[i].fqdn` | `fqdns[i].ipTypes` | Reality |
|---|---|---|
| `"server"` (literal word, no dot) | `"v4"` | Not an address at all |
| Hostname like `"yahoo.com"` | `"v6"` (sometimes) | Hostname, not IPv6 |
| Hostname like `"www.slack.com"` | `"v4"` | Hostname, not IPv4 |
| Plain IPv4 like `"10.0.0.94"` | `"v4"` | Correct (coincidence on this set) |

Callers must classify each `fqdns[i].fqdn` string from value alone using local regex. The toolkit's classifier (FMN-153, in `extension/src/content/augment.js` and `extension/src/background/omni-search-handlers.js`) accepts:

- IPv4 - strict octet-bounded regex - routes to the IP Address column
- IPv6 - hex+colon shape with at least one colon - routes to the IP Address column
- Hostname - DNS-label form with at least one dot - routes to the DNS Name column
- Anything else (bare words, status text, URLs with schemes) - **dropped**

Multi-value cases render comma-separated. Duplicates are deduped in insertion order.

### What the plugin actually reads from `instance.*`

| Use site | Field(s) |
|---|---|
| FMN-61 name resolution | `pageData.instance.name`, `formattedName` |
| FMN-71 IP Address sub-column | classified from `pageData.instance.fqdns[*].fqdn` |
| FMN-71 DNS Name sub-column | classified from `pageData.instance.fqdns[*].fqdn` |
| FMN-76 Model / Model # / OS | `pageData.fabricSystemData.{model_name, model_number, os_version}` (Fortinet/fabric only) |

---

## Auth mechanism

Session cookie only. No XSRF token required (GET, idempotent, non-mutating).

- `fetch()` with `credentials: 'include'` sends the session cookie automatically, provided the manifest `host_permissions` includes `https://fortimonitor.forticloud.com/*`.
- Same-origin for the existing port-scope client, so no new manifest entries needed.

---

## Error handling: silent SPA-shell response

**Important:** on invalid or malformed input, this endpoint returns `200 OK` with the SPA shell HTML (`text/html`, ~930KB), **not** a JSON error body. Observed for all of:

| Scenario | Response |
|---|---|
| `server_id=99999999` (non-existent) | `200` + HTML shell |
| `server_id` omitted | `200` + HTML shell |
| `server_id=abc` (non-numeric) | `200` + HTML shell |
| `server_id=-1` | `200` + HTML shell |
| `server_id=` (empty) | `200` + HTML shell |
| Session expired / not logged in | (inferred - same HTML shell, redirect-to-login pattern) |

Callers must **not** rely on HTTP status alone. The correct detection pattern:

1. Check `Content-Type` header contains `json`.
2. Attempt `response.json()`; catch parse errors.
3. Check `pageData?.instance?.name` is a non-empty string before trusting the result.

Any of these failing means "name not resolvable" - degrade gracefully to empty. This mirrors the existing port-scope client's handling in `extension/src/lib/fortimonitor-client.js:181-199` (same non-JSON-on-auth-failure pattern).

---

## Concurrency and performance

- Payload is ~49KB per device. For 200 servers resolved in parallel that's ~10MB of network traffic - acceptable for a one-time scan but not free.
- Recommended concurrency: **3** - matches the existing scan-loop concurrency in `scanner.js` and keeps per-tenant load predictable.
- No rate-limit headers observed during discovery; no 429s during the probe phase.
- Response time typically <500ms per request in the test tenant.

---

## Bulk-variant: not found

Probed nine guessed bulk-endpoint paths (`/report/get_lsp_data`, `/report/get_servers_data`, `/util/list_servers`, etc.) - all returned the SPA shell, meaning they're not real endpoints. The Instance List page (`/report/ListServers`) presumably has its own data endpoint, but capturing it requires a fresh session observation (it loads before an injected interceptor can register).

Follow-up: if FMN-61 performance at scale is a concern, open a capture ticket to observe `/report/ListServers` traffic and find the bulk endpoint. The current single-server endpoint is sufficient to unblock FMN-61.

---

## Verification

Three server IDs resolved successfully in the captured session:

| Input `server_id` | HTTP | Response `pageData.instance.id` | Name resolved |
|---|---|---|---|
| 42024060 | 200 | 42024060 | ✓ |
| 42024061 | 200 | 42024061 | ✓ |
| 42024075 | 200 | 42024075 | ✓ |

All five edge-case probes degraded to the SPA-shell pattern documented above.

---

## Example: programmatic name resolution

See [`server-metadata-snippet.js`](./server-metadata-snippet.js) for a minimal MV3 service-worker-compatible reference implementation.
