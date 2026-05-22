# Template / server deletion (session-auth)

Captured FMN-238, 2026-05-21, via an operator-paired UI capture during FMN-228 cleanup. Toolkit had created an orphan template (id 44077868) that v2 couldn't delete; operator clicked "Delete Template" via the FortiMonitor kebab while Playwright intercepted the network.

## Endpoint

```
POST https://fortimonitor.forticloud.com/config/deleteServer
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest
Body: server_id={id}
```

Cookies: session cookie only.

## Returns

- HTTP 200 on success. Response body was empty in the captured run (recording missed the body via Playwright's response listener; the request itself was intercepted clean).
- Confirmed deletion by re-listing `/v2/server_template` (or `/v2/server`) and verifying the id is absent.

## Notable findings

1. **The endpoint is named "deleteServer," not "deleteTemplate."** FortiMonitor templates share the s-{id} numeric namespace with servers (see `docs/api-discovery/server-metadata.md` and CLAUDE.md project notes). The same endpoint handles both resource types. The form field is `server_id` even when the target is a template.

2. **No `X-XSRF-Token` header is required.** Different from `/config/createServerTemplate` and `/config/save_port_selection`, which both DO need it (see `fortimonitor_template_and_metric_write_endpoints.md` memory + FMN-203 capture). The toolkit's `FortimonitorClient.deleteServerOrTemplate()` reflects this: no XSRF cookie read, no token header sent.

3. **No detach-first requirement.** The template was attached to its source 3 servers (we had explicitly detached them in the toolkit's earlier failed cleanup attempt, but the UI's Delete Template flow didn't gate on attachment state). FortiMonitor handles the cascade — attached servers lose the template + any metrics/attributes seeded by it, identical to the v2 `DELETE /server/{id}/template/{tid}?strategy=delete` strategy.

4. **Probed wrong endpoint names returned 200 SPA-shell, not real responses.** `/config/deleteServerTemplate`, `/config/delete_server_template`, `/config/removeServerTemplate` all returned HTTP 200 with the FortiCloud SPA HTML — they are NOT real endpoints. FortiMonitor's router falls through to the SPA on unknown `/config/*` paths. The 500 returned by `/config/deleteServerTemplate` against one body shape was a red herring (probably a parser crash on a different code path).

## Cross-references

- `docs/api-discovery/template-create-from-device.md` — the create-side counterpart (`POST /config/createServerTemplate`). That one DOES require X-XSRF-Token. Auth surface differs between create and delete; don't assume a pattern.
- `docs/api-discovery/templates.md` — v2 read-side coverage. v2 does NOT expose DELETE on `/server_template` (live: 405 Method Not Allowed). Schema discovery confirms.
- `docs/api-discovery/server-metadata.md` — the s-{id} namespace convention.

## Implementation

`FortimonitorClient.deleteServerOrTemplate(id)` ships in this commit. Single signature handles both resource types because the wire shape is identical. Caller verifies success by re-listing the resource collection (the response body doesn't reliably indicate which id was deleted).

## Unblocks

FMN-237 (Toolkit rollback) — the template inverse-op has a known wire shape. The rollback flow can now journal template creations and undo them via this endpoint.
