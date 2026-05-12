# Snapshot & Diff Card (FMN-154)

A toolkit-added tile on FortiMonitor's Canned Reports page (`/report/ListReports`) that takes a point-in-time snapshot of the deployment (servers, users, templates, server groups) and compares any two snapshots side-by-side.

Snapshots are stored only on the local Chrome profile via `chrome.storage.local`. Nothing is uploaded to FortiMonitor's servers; the only network calls are read-only v2 API requests during the scan. Scans continue in the background if the operator leaves the page.

The diff viewer lives at `chrome-extension://<id>/src/ui/bpa-diff/app.html`; the tile's Open button opens it in a new tab.

Requires a configured RW API key. Opt-in via popup -> Settings ("Show Snapshot & Diff tile on Canned Reports").

See also: [FMN-154 ticket on Plane](https://app.plane.so/myrug/projects/).
