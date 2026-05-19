# FMN-211 HAR Capture Playbook

**Purpose:** capture the FortiMonitor wire contracts for one device of each non-FortiGate Fabric type (FortiAP / FortiSwitch / FortiExtender) from a tenant that has them. The captured HAR feeds `tools/qa/fmn-211-parse-har.mjs`, which redacts customer-identifying content and emits a structured contract doc that drives FMN-211 Phase A reconciliation + Phase F live QA.

**Who runs this:** anyone who can log into a FortiMonitor tenant that has at least one FortiAP, FortiSwitch, or FortiExtender. Browser DevTools is the only tool needed. No install, no scripts.

**What is captured:** four read-only HTTP responses per device class. No POSTs, no template creates, no changes to the tenant.

---

## 1. Prep

1. Open the tenant in **Chrome, Edge, or Firefox**. Any modern browser works.
2. Log in.
3. Open DevTools (Cmd+Opt+I on macOS, F12 on Windows / Linux).
4. Click the **Network** tab.
5. Tick **Preserve log** (so navigation doesn't clear the capture).
6. Click the **clear** icon (⊘ or 🚫) to start with an empty network log.
7. *(Optional but useful for keeping the HAR small)* In the filter box, type `report` to keep only the report endpoints visible. The parser only reads four URL patterns so any filter that keeps them is fine.

---

## 2. Capture (repeat once per device class you can access)

For each of FortiAP / FortiSwitch / FortiExtender, pick **one** device in the tenant and walk through these four steps. The exact order doesn't matter; what matters is that all four happened while the HAR was recording.

1. **Navigate to the device's detail / overview page** (the main page when you click the device in the inventory). Wait for it to fully render.
   - This logs `/report/get_idp_data?server_id=...`

2. **Open the device's Monitoring Config / Settings view** (whichever sub-tab shows the metrics it's monitoring).
   - This logs `/report/get_monitoring_config_data?server_id=...`

3. **Open the "Save as Template" / "Create Template" dialog from that device.** **DO NOT submit the dialog.** Just open it, let it populate its defaults, then **Cancel / close**.
   - This logs `/config/get_create_server_template_data?instance_id=...`

4. **Navigate around the device's pages enough that the port-scope endpoint fires.** Visiting the Ports / Interfaces sub-tab usually triggers it. If nothing fires, that's fine — we just want to confirm the failure mode on non-FortiGate types.
   - This may or may not log `/onboarding/getDevicePorts?server_id=...`

---

## 3. Export

1. In the Network tab, right-click any request row.
2. Choose **"Save all as HAR with content"**. (Important: the *with content* variant — the plain "Save all as HAR" omits response bodies, which is exactly what we need.)
3. Save to a file you can find again. Naming suggestion: `fmn-211-<tenant-shortname>-<date>.har`.

---

## 4. Pre-share sanity check (before sending the file)

Open the HAR in any text editor (it's plain JSON) and **search for any of:**

- Customer names, internal org names, employee names
- Email addresses
- Specific IP blocks or subnets that identify the tenant's infrastructure
- Account slugs, tenant subdomain that's recognisable

If anything obvious turns up, either:

- Delete the affected entries from the HAR, **or**
- Skip step 4 entirely and trust the parser's redaction (covered below). The parser strips IPs, MACs, server names, fqdns, account fields, descriptions, tags, alert thresholds, long tokens, cookies, and auth headers. It's defense-in-depth, not the only line of defense.

---

## 5. Send the HAR

Send the HAR back to whoever asked for the capture (probably Gregori). Include:

- The HAR file
- Which device classes you captured (e.g. "FortiAP only — tenant has no FortiSwitches available to me")
- Anything weird you noticed (e.g. "the Save-as-Template dialog wouldn't open on the FortiAP — got a 'feature not available' message")

---

## 6. What happens next (informational)

Whoever receives the HAR runs:

```bash
node tools/qa/fmn-211-parse-har.mjs --har /path/to/your.har
```

That writes `tools/qa/fmn-211-foreign-tenant-capture.json` (gitignored), which contains only the structural contract data — vendor product names, category textkeys, metric textkeys, response shapes. No tenant-identifying content survives.

That JSON drives:

- **FMN-211 Phase A**: reconciles plugin_textkey assumptions in the code against real shapes
- **FMN-211 Phase F**: synthetic test fixtures get updated to match real contracts
- **Future tickets**: any per-device-type quirks captured here become tickets for follow-up work

---

## Common questions

**"What if I can only capture one device class?"** That's fine. Each class is independent. One is much better than zero.

**"What if the tenant uses a non-standard FortiMonitor URL (custom subdomain)?"** The parser auto-detects the tenant origin from URLs in the HAR and scrubs it.

**"How big will the HAR be?"** Usually under 5 MB if you used the `report` filter in step 1. Without a filter it can balloon to 50+ MB. Either is parseable.

**"Can I capture more than one device per class?"** Sure. The parser handles multiple hits per endpoint. More data is better.

**"Will this change anything in the tenant?"** No. Every endpoint listed here is a GET. The Save-as-Template dialog is opened but explicitly not submitted.
