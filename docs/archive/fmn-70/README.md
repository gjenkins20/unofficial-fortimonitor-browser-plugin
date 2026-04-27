# FMN-70 archive: WebGUI takeover prototype

This directory preserves the artifacts of the [FMN-70](https://plane.myrug-network.com/) WebGUI-takeover experiment. The implementation itself is **not** on `main` and was never shipped to users.

## What the experiment was

A toolkit-served replacement for FortiMonitor's `/report/ListServers` page. Pattern B: when an opt-in setting (`fm:webguiTakeoverEnabled`) was on, the content script intercepted visits to the native list page and `location.replace()`-d to a plugin-served HTML page at `chrome-extension://<id>/src/ui/instances-takeover/app.html`, which fetched the same `/report/server_group_inventory_data` and per-row `/report/get_idp_data` payloads as DataTables and rendered them in a native `<table>` without DataTables / Vue / jQuery.

## Outcome

Successful prototype. End-to-end verified in operator's real Chrome on the live FortiMonitor tenant:

- The popup Settings toggle landed in the right place and persisted.
- The redirect from `https://fortimonitor.forticloud.com/report/ListServers` fired and produced a `chrome-extension://...` URL.
- Cross-origin cookies attached on the takeover page's session-auth fetches via `credentials: 'include'` + `host_permissions`.
- The page populated rows with model / model # / OS from `fabricSystemData`, classified IP vs. DNS via FQDN regex, and rendered a native HTML table.

Decision: not to ship. The augmentation layer (FMN-69 + FMN-71/75/76 sub-cells inside the native FortiMonitor table) remains the operator-preferred shape for now. The prototype answered the feasibility question; productizing it isn't in scope.

## Files in this directory

| File | What |
|---|---|
| `mockup.html` | Static side-by-side mockup of native vs. takeover view. Open in any browser. |
| `screenshot-mockup.png` | Rendered screenshot of the mockup. |
| `screenshot-live-takeover.png` | Rendered screenshot of the live takeover page running against canned FortiMonitor responses (via the synthetic harness). |

The implementation itself (`extension/src/content/augment.js` redirect logic, `extension/src/ui/instances-takeover/app.{html,js,css}`, `extension/src/lib/settings.js` flag, manifest entry, popup wiring, column-order registry entry) was committed as `b4f7997` on a feature branch that has since been deleted. The commit may be findable in the reflog for ~90 days; after that, regenerate from this archive's mockup and the implementation notes in the original Plane ticket comments if the experiment is revisited.
