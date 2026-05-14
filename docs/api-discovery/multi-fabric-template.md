# Multi-Fabric template contracts (FortiAP / FortiSwitch / FortiGate)

Captured during FMN-211 Phase A (2026-05-13) from operator-provided HARs across two tenants. Documents the verified per-type contracts used by the Bulk Composer's Profile + Create Templates action. SNMP/OnSight-only network devices are out of scope here; see FMN-217.

## Source data

| Device class | Tenant | Onboarding |
|---|---|---|
| FortiGate | (operator's production tenant) | Fabric (per FMN-203) |
| Fabric FortiSwitch | `my.us01.fortimonitor.com` | Fabric |
| Fabric FortiAP | `my.us01.fortimonitor.com` | Fabric |
| SNMP FortiAP | `data.guide.fortimonitor.com` | OnSight / SNMP (FMN-217) |

Raw redacted captures: `tools/qa/fmn-211-fortiap-fabric-capture.json`, `tools/qa/fmn-211-fortiswitch-capture.json`, `tools/qa/fmn-211-fortiap-capture.json` (SNMP, FMN-217 reference).

## Identity (`/report/get_idp_data` -> `pageData.instance`)

| Field | FortiGate | Fabric FortiAP | Fabric FortiSwitch | SNMP FortiAP (FMN-217) |
|---|---|---|---|---|
| `isFabric` | `true` | `true` | `true` | `null` |
| `deviceType` | `network_device` | `network_device` | `network_device` | `network_device` |
| `deviceSubType` | `fortinet.fortigate` | `fortinet.fortiap` | `fortinet.fortiswitch` | `null` |
| `hasOnsight` | varies | `true` | `true` | `true` |
| `fabricRoot` | `null` (root) | `{id, name}` (parent FortiGate) | `{id, name}` (parent FortiGate cluster) | `null` |
| `fabricSystemData` | present | present | present | **absent** |

**Take:** `deviceSubType` (only populated when `isFabric === true`) is the canonical type indicator across all three Fabric classes. SNMP-monitored devices have neither and are excluded from FMN-211.

## `fabricSystemData` shape (per-class)

| Field | FortiGate (per FMN-203) | FortiAP | FortiSwitch |
|---|---|---|---|
| `model_name` | `"FortiGate"` | absent | absent |
| `model_number` | `"FGVMxx"` etc. | absent | absent |
| `model` | (not used) | unreliable - operator's Fabric FortiAP had `"TMH"` (customer override) | `"FS2F48"` (product code) |
| `os_version` | `"FGT...-vX.Y.Z..."` | `"FP431F-v7.4.6-build0771"` | `"FS2F48-v7.4.8-build929,250909 (GA)"` |
| `serial` | (not noted in FMN-203) | present | present |
| `device_type` | (not noted) | unreliable - operator's FortiAP had `"TMH"` | `"FS2F48"` |
| `path` | n/a | `"FG180FTK21901422:FP431FTF21039768"` | `"FG180FTK21901452:FS2F48TV24001439"` |
| `vdom` | n/a | `"root"` | `"root"` |
| `connecting_from` | n/a | IP | IP |
| `join_time` | n/a | timestamp | timestamp |
| Per-class extras | (varies) | `ap_profile`, `wtp_id`, `wtp_mode` | `peer_intf_name`, `type`, `owner_vdom` |

**Take:** FortiGate and FortiAP/Switch use disjoint field schemas. The clusterer cannot rely on `model_name` + `model_number` cross-type.

## Make/Model extraction (canonical)

```js
// 1) Back-compat: explicit FortiGate shape from FMN-203 still works.
if (fsd.model_name && fsd.model_number) {
  return { make: fsd.model_name, model: fsd.model_number };
}

// 2) Cross-Fabric canonical path:
if (instance.isFabric !== true) return null;
const make = {
  'fortinet.fortigate': 'FortiGate',
  'fortinet.fortiap': 'FortiAP',
  'fortinet.fortiswitch': 'FortiSwitch',
  'fortinet.fortiextender': 'FortiExtender'
}[instance.deviceSubType];
if (!make) return null;

// Product code from os_version prefix: "FP431F-v7.4.6-build0771" -> "FP431F"
const m = (fsd.os_version || '').match(/^([A-Za-z][A-Za-z0-9-]+)-v/);
const model = m ? m[1] : (fsd.model || null);
return model ? { make, model } : null;
```

Implementation: `extension/src/lib/template-clusterer.js` `extractMakeAndModel()`.

## Monitoring config (`/report/get_monitoring_config_data` -> `categories.added[]`)

| Aspect | FortiGate | Fabric FortiAP | Fabric FortiSwitch | SNMP FortiAP (FMN-217) |
|---|---|---|---|---|
| Category `textkey` | `fortinet.fortigate` | `fortinet.fortiap` (all categories) | `fortinet.fortiswitch` (all categories) | Human strings: `"Admin Status"`, `"Bandwidth In (32 bit)"`, etc. |
| Metric records carry `textkey` | yes | yes | yes | NULL on most |
| Metric records carry `plugin_textkey` | yes | yes | yes | NULL |
| Metric `name` | metric-typed | metric-typed | metric-typed | interface name (`"eth0"`, `"wifi0"`) |

**Take:** Across all three Fabric classes, the category `textkey` IS the `plugin_textkey` to send on writes. SNMP devices have a completely different model.

## `template_type` (`/config/get_create_server_template_data` -> `template_type_options`)

| Class | `template_type_options[0].value` |
|---|---|
| Fabric FortiGate | `fabric_template` |
| Fabric FortiAP | `fabric_template` |
| Fabric FortiSwitch | `fabric_template` |
| SNMP FortiAP (FMN-217) | `network_device_template` |

**Take:** All three Fabric classes share `fabric_template` for the create POST. FortiMonitor differentiates SNMP/OnSight devices into `network_device_template`. Code reads the first option's `value` per cluster representative; never hardcodes.

Implementation: `bulk-composer:get-create-template-defaults` SW handler in `extension/src/background/bulk-composer-handlers.js`. Configure step calls it per cluster after initial render and stitches `cluster.template_type` into the params before commit.

## `/onboarding/getDevicePorts`

**Returns useful data on all three Fabric classes** (confirmed in the FortiAP and FortiSwitch HARs). Previously gated FortiGate-only in FMN-211 Phase D; gate removed. SW handler swallows errors on devices that don't support the endpoint and returns null per id.

The Fabric FortiAP capture showed `ports[]` with `admin_status`/`oper_status`/`templateId`/`templateName` populated for the active interfaces (eth0, eth1, wifi0..3).

## Create-template submit (`POST /config/createServerTemplate`)

Not captured in FMN-211 Phase A - no sandbox tenant available for non-destructive POST testing. The FMN-203 contract (captured against a Fabric FortiGate) is the inherited wire shape:

```json
{
  "server_id": <number>,
  "template_name": "<string>",
  "template_type": "<value from get_create_server_template_data>",
  "select_options": "yes" | "no",
  "instance_grp_name": "<string>",
  "notification_schedule": <number>,
  "element_ids": "grp-<number>"
}
```

Required headers (FMN-203): `X-XSRF-Token` (mirror of `XSRF-TOKEN` cookie), `Content-Type: application/json`, `X-Requested-With: XMLHttpRequest`.

**Open question for Phase F live QA:** does FortiMonitor accept the same wire shape for Fabric FortiAP/Switch? Will surface as a 400 with the rejected field if not; recover by reading any per-class signal from `get_create_server_template_data`.
