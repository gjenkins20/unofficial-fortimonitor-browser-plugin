# Phase 5 — Live E2E Runbook

The Phase 4 UI is statically verified against the FMN-38 mockups via
`docs/mockups/preview-app.html`. This runbook drives the **live** half:
load the unpacked extension into Chrome against an active FortiMonitor
session and exercise the real service-worker orchestration.

**Only the operator can run this.** The flow rides your existing
FortiMonitor cookies and requires you to be logged in.

---

## 1. Load the unpacked extension

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select `unofficial-fortimonitor-browser-plugin/extension/`
5. Confirm the extension appears as **FortiMonitor WAN Cleanup (Unofficial)**, version `0.1.0`
6. Note the extension ID — needed below

## 2. Open the plugin

- Click the extension's toolbar icon (if not pinned, find it via the puzzle-piece menu)
- OR navigate directly: `chrome-extension://<id>/src/ui/app.html`

You should land on **Step 1 — Load devices from CSV**.

## 3. Log into FortiMonitor

Open a second tab in the same Chrome profile and log into
<https://fortimonitor.forticloud.com/>. This seeds the session cookie
and `XSRF-TOKEN` that the service worker reads via `chrome.cookies.get`.

## 4. Start batch — 3 test VMs

Paste this into the textarea and click **Start review →**:

```
server_id,device_name
42024060,FGVM01TM24006844
42024061,FGVM01TM24006845
42024075,FGVM01TM24006846
```

Expected:
- Parse result: "3 devices ready to review · 3 named from CSV"
- Click **Start review →**
- Service worker issues 3 `GET /onboarding/getDevicePorts` requests (check DevTools → Network)
- Advance to step 2

If you see `No XSRF-TOKEN cookie` or HTTP 401/403 — re-log into
FortiMonitor in the same window, then click **Start review** again.

## 5. Review groups

Each unique `{port_name, admin_status, oper_status}` tuple set
collapses to one prompt. With the 3 test VMs you'll likely see 1 group
(they're templated identically as of 2026-04-16; previously toggled
during FMN-34/FMN-36 capture work).

**Dry-run-safe exercise:**
- Mark **wan2** (or any WAN row that shows `oper_status = down`)
- Verify the `fortilink` row is highlighted in yellow with the
  "fabric link — keep" tag
- Click **Queue for N devices →**

If the 3 VMs split into 2 groups, repeat the marking for each group
(or click **Skip group** on the second).

## 6. Audit the queue

On the queue-overview screen verify:
- Metric strip totals match what you marked
- Group cards expand to show the specific kept/removed ports + device sample
- **Download plan (JSON)** and **Download plan (CSV)** both download correctly
- The **Dry run** toggle is ON by default
- The confirmation input is disabled while Dry run is on

## 7. Dry-run execution

- Click **Run dry run →**
- Execute-progress screen ticks through the entries (local simulation,
  no network calls)
- Metric strip fills: succeeded = total, failed = 0
- **View results** enables when the simulator finishes
- Click it — land on the success verdict banner
- Download the CSV and JSON reports; verify they parse

## 8. STOP — decision gate

**Do not proceed to live execution** unless you're ready for
destructive changes. Each live save deletes the affected port's agent
resources and metric history in FortiMonitor. Rolling back is manual
(re-select the port in the FortiMonitor Port Selection dialog).

If you do proceed:
- Back to the queue-overview step
- Toggle **Dry run** OFF — confirmation input activates and the primary button turns red ("Execute and remove N ports")
- Type `EXECUTE N PORTS` exactly (N matches the live count shown in the gate) — button enables
- Click **Execute and remove N ports**
- Watch the execution-progress screen show real HTTP POSTs via DevTools → Network
- Check each `POST /config/save_port_selection` → 200 with `{"success": true}`

## 9. Verify in FortiMonitor

- Open one of the test servers in FortiMonitor's WebGUI
- Port Selection dialog: confirm the port you removed is deselected
- Metrics view: the agent resources for that port are gone

To restore: re-enter Port Selection in FortiMonitor, re-check the port, save. FortiMonitor re-provisions agent resources (though metric history is permanently gone).

---

## What to look for (troubleshooting)

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No XSRF-TOKEN cookie` on any write | Not logged into FortiMonitor in this profile | Log in, retry |
| HTTP 401/403 on write | Session expired mid-batch | Re-log into FortiMonitor, use the inline **Retry** button on failed rows |
| Empty paste-area parse | CSV header missing `server_id` column | Use a plain list OR include a header row |
| Scan returns "errored" for some IDs | Server doesn't exist in your FortiMonitor session | Remove the stale IDs and retry |
| Service worker can't read cookies | Missing `cookies` permission or `fortimonitor.forticloud.com` host permission | Verify `extension/manifest.json`; reload the extension |
| Extension icon absent from toolbar | No default action popup set (by design) | Click the puzzle-piece menu and pin the extension |

---

## Artifacts to capture for Phase 5 sign-off

- Screenshot of each of the 5 steps against your live session
- The downloaded JSON plan + CSV report
- DevTools Network HAR of the batch (optional, for audit)

Attach to FMN-39 as a Phase 5 comment.

---

## Add Fabric Connection (API) — separate live test (FMN-45)

The Add Fabric Connection tool uses the FortiMonitor v2 public API instead of the FortiMonitor session. Its live-test loop is independent of the port-scope tools above.

### 1. Set the API key

1. Open the launcher popup
2. Click ⚙ in the header → **Settings**
3. Paste an RW API key obtained from your FortiMonitor account
4. Click **Save** then **Test connection** — expect "Connection OK (HTTP 200)"

### 2. Open the tool

- Click **Add Fabric Connection (API)** in the launcher
- The Load step should populate the OnSight + server group dropdowns from your account within ~1s
- If targets fail to load, the inline error tells you whether the issue is auth (re-check the key) or network

### 3. Dry-run first

Paste 2–3 test FortiGates (CSV: `serial,ip,port`), pick OnSight + server group, click Continue → Review.

In Review:
- Inspect the example payload — confirm `upstream_sn` / `upstream_host` / `upstream_port` match your input
- Leave mode on **Dry-run**
- Click Execute. Results should show all rows as **succeeded** with `preview built` detail

### 4. Live run

Repeat the flow, this time:
- Switch mode to **Live**
- Type `CREATE` in the confirmation field to enable Execute
- Watch the per-device progress list — each row transitions pending → running → succeeded/failed
- On completion, the Results step shows resource IDs from the API's `id` response header

### 5. Verify in FortiMonitor

Open the FortiMonitor UI and confirm the new fabric connections appear. Note the API guide caveat: the "Error Creating Persistent Fabric Connection" UI message can take ~5 min to clear when the Control Panel is busy. The 201 response from the API is the source of truth.

### Artifacts for FMN-45 sign-off

- Screenshot of Settings showing the masked API key + successful test
- Screenshot of Results step (live mode)
- Exported CSV/JSON results from the Results step
- Confirmation that connections appear in the FortiMonitor UI

Attach to FMN-45.
