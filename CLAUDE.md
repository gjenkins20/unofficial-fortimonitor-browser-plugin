# Unofficial FortiMonitor Browser Plugin

Chrome extension (Manifest V3) that automates FortiMonitor configuration tasks requiring FortiCloud web UI session authentication.

## Project Context

FortiMonitor's v2 API lacks per-port scope reconfiguration (FMN-34 investigation). Granular port control only exists through FortiCloud's internal UI endpoints, requiring browser session auth. This plugin bridges that gap.

## Plane Integration

- Workspace: `myrug`
- Project: FortiMonitor (`fortimonitor`)
- Identifier prefix: `FMN`
- Plane MCP tools are available for ticket management

## Key Technical Findings (from FMN-34)

### FortiMonitor API Limitations
- `port_selection` on `server` and `fabric_connection` is **write-only** (accepted on PUT/POST, never returned on GET)
- `port_selection` is binary all/none — no per-port granularity
- `agent_resource.status=suspended` suspends metrics but does NOT change port scope
- Port scope and agent_resource provisioning are **separate systems**
- UI port deselection is **destructive** — agent_resources and metric history are deleted, not suspended

### Internal FortiCloud Endpoints (browser session auth required)
- `GET /onboarding/getDevicePorts` — enumerates provisioned ports per device
- `POST /config/save_port_selection` — per-port scope control (select/deselect)
- These require FortiCloud session cookies, NOT API key auth

### FortiMonitor MCP Server
- `investigate_server` returns server details, agent_resources, network services, outages
- Agent resources represent interfaces via `resource_option` field (e.g., "port1", "port2")
- Each interface has multiple agent_resources (bandwidth tx/rx, link status, DHCP counts)
- Plugin types for interfaces: `fortigate.bandwidth`, `fortigate.available_interfaces`, `fortigate.interface`
- Agent resources are paginated (20 per page, use offset/limit)

### Test Targets
- FGVM01TM24006844 → server 42024060 (port scope: All 3 of 3 as of 2026-04-16; previously toggled during FMN-34/FMN-36 capture work)
- FGVM01TM24006845 → server 42024061
- FGVM01TM24006846 → server 42024075
- Fabric connections: 16755 and 17465

### FortiGate MCP Server
- Registered but currently exposes no tools or resources
- May need configuration/auth setup before it becomes useful

## Development Notes

### Claude in Chrome Extension
Observation tools are now available: `tabs_context_mcp`, `read_page`, `find`, `get_page_text`, `read_network_requests`, `javascript_tool`, `take_screenshot`. The extension operates on a dedicated MCP tab group (`tabs_context_mcp` creates a new window on first call) — user must log into FortiCloud in that window for session-authenticated captures.

Known limitations:
- `read_network_requests` returns URL/method/status only, **not request/response bodies**. For body capture, install a fetch/XHR interceptor via `javascript_tool` before the user action, store captures on `window.__*`, then read them back.
- `javascript_tool` output is filtered by a safety layer that blocks outputs containing cookie-like or long-token-like strings and query-string patterns. **Strip `URL.search` and redact long base64-ish tokens before returning values**, or results come back as `[BLOCKED: Cookie/query string data]`.
- Extension does NOT see requests from tabs outside its group — user must be in the MCP-created tab.

### Port Scope API Contract (FMN-36, captured 2026-04-16)
Full documentation: [`docs/api-discovery/port-scope.md`](docs/api-discovery/port-scope.md). Reference snippet: [`docs/api-discovery/port-scope-snippet.js`](docs/api-discovery/port-scope-snippet.js).

Summary:
- `GET /onboarding/getDevicePorts?server_id={id}` — returns `{ data: { filter_type, portFilters, ports[{name,index,isActive,admin_status,oper_status,...}] } }`
- `POST /config/save_port_selection?<query-params>` — **all parameters in query string, body empty**, despite `Content-Type: application/x-www-form-urlencoded`. Response: `{"success": true}`. Query params: `serverId`, `filters` (JSON string), `portSelectionType` (`all|none|manual|name`), `searchTerm`, `totalPortCount`, `selectedPorts[]` (repeated, uses `index` not `name`).
- Auth: session cookie (HttpOnly, automatic) + `X-XSRF-TOKEN` header mirroring the `XSRF-TOKEN` cookie verbatim. MV3 service workers read the XSRF cookie via `chrome.cookies.get()` — requires `cookies` permission and `https://fortimonitor.forticloud.com/*` host permission.
- **Status values on production devices (confirmed via screenshot 2026-04-16):** `admin_status` and `oper_status` are populated as lowercase `"up"` / `"down"` strings. The `"Unknown"` values observed on test VMs (FGVM01TM24006844/45/46) are a telemetry gap on those specific VMs, not a limitation of the endpoint. Plugin compares status case-insensitively. No lab device required; no v2 API cross-reference required.

### Scope boundary (non-negotiable)
This plugin is **frontend-only**. No FortiMonitor v2 public API calls. No API key auth. No credentials beyond the FortiCloud browser session. If data is needed that session-authenticated internal UI endpoints don't expose, the fallback is DOM scraping via content script — not a different auth surface. See project memory `no_fortimonitor_api.md`.

### Browser Observation Workflow (fallback)
When live MCP capture hits a blocker, HAR export remains a viable fallback:
1. User opens DevTools Network tab
2. User performs the workflow
3. User exports HAR file
4. Claude parses HAR to extract API contracts, auth headers, payloads

## DokuWiki Integration
- Wiki: myrug-network
- Authenticated as: Greg Jenkins (gjenkins, admin)
