# Example: Active SSH sessions on an OnSight appliance

A field-by-field walkthrough of the FortiMonitor Custom Metric configuration for the example introduced by the parent [`README.md`](../README.md).

Pair this document with the in-toolkit **Custom Metrics** training module (FMN-244) for the conceptual material; this doc only covers the concrete values that go in each field.

## 0. Before you begin

- Copy [`script.sh`](script.sh) onto the OnSight appliance you plan to monitor. The suggested path is `/usr/local/bin/fmn-active-ssh-sessions.sh`.
- `chmod 755 /usr/local/bin/fmn-active-ssh-sessions.sh` so the FortiMonitor script-runner can execute it.
- Confirm the script runs and prints one line with one integer:

  ```
  $ /usr/local/bin/fmn-active-ssh-sessions.sh
  3
  ```

  If you see decimals, extra lines, or empty output, fix that before touching FortiMonitor - the script-runner is strict about its input contract.

## 1. Identity

| Field | Value | Notes |
| --- | --- | --- |
| **Name** | `Active SSH Sessions` | Shows up on dashboards, incident captions, and the Custom Metric Management list. Keep it short and human. |
| **Description** | `Count of currently-active SSH login sessions on this OnSight appliance. Source: who \| grep -c .` | First sentence shows up in tooltips. Including the source command makes the metric self-documenting for the next operator who inherits it. |

## 2. Data source

| Field | Value | Notes |
| --- | --- | --- |
| **Source type** | `Script execution (OnSight)` | The OnSight runs the script on the appliance itself and forwards stdout to FortiMonitor. |
| **Script path** | `/usr/local/bin/fmn-active-ssh-sessions.sh` | Match wherever you dropped the script in step 0. |
| **Script timeout** | `5s` | The script returns in microseconds; 5 seconds is a generous safety net. |
| **Run as** | `default OnSight service account` | The script only calls `who`, which is world-readable; no privileged user needed. |

## 3. Units + display

| Field | Value | Notes |
| --- | --- | --- |
| **Unit** | `sessions` | Singular form; FortiMonitor pluralizes for you on display. |
| **Display format** | `integer` | The metric is a count; no decimals. |
| **Graph type** | `line` | Linear time-series, no need for stacked or area variants. |

## 4. Scope

| Field | Value | Notes |
| --- | --- | --- |
| **Attached instances** | The OnSight appliance you copied the script to | Use the single-instance selector. Attaching to a server group is supported but premature for a first example. |

## 5. Frequency

| Field | Value | Notes |
| --- | --- | --- |
| **Evaluation frequency** | `5 minutes` | The fastest useful cadence for a session count; an SSH login that persists less than five minutes is rarely operationally interesting. |

## 6. Thresholds

Define two thresholds so you can observe graduated severity. The values below assume an unattended appliance with no scheduled remote work; tighten or loosen for your environment.

| Severity | Condition | Sustained for | Why |
| --- | --- | --- | --- |
| **Warning** | `value > 5` | `10 minutes` | Five concurrent SSH sessions on an unattended appliance is unusual but not yet alarming; the 10-minute sustain window filters out one-off connectivity tests. |
| **Critical** | `value > 20` | `5 minutes` | Twenty concurrent sessions is far outside steady-state; the shorter sustain window catches an attacker fan-out faster. |

Both thresholds compare against the raw integer value the script returns; no derived expression or rolling window arithmetic is needed for this example.

## 7. Incident routing

| Field | Value | Notes |
| --- | --- | --- |
| **Notification schedule** | The tenant's standard schedule | A custom metric inherits the same routing as a built-in alert; you do not need to author a separate schedule. |
| **Acknowledgement workflow** | Standard | Operators acknowledge from the *Incidents* view; resolution is automatic on the next clean evaluation. |
| **Severity mapping** | Threshold severity flows through verbatim | A Warning threshold breach surfaces as a Warning incident; same for Critical. |

## 8. Demo-the-breach checklist

After saving the metric:

1. Wait one evaluation cycle (about five minutes). Confirm the metric appears on the Custom Metric Management list with a current value matching `who | grep -c .` on the OnSight.
2. Open enough additional SSH sessions to cross the Warning threshold (six total). Hold them open for the 10-minute sustain window.
3. Switch to the FortiMonitor *Incidents* view. A new Warning incident named `Active SSH Sessions` should appear, attributed to the OnSight appliance you scoped the metric to.
4. Close the extra sessions. After the next evaluation cycle confirms the count has dropped back under five, the incident resolves automatically.

If any step fails, the most common causes are:

- Script permissions: `ls -l /usr/local/bin/fmn-active-ssh-sessions.sh` should show `-rwxr-xr-x`.
- Script output: a stray decimal or empty line breaks the integer contract.
- Threshold sustain: a session that disappears inside the sustain window never trips the threshold by design.

## 9. Cleanup

When you are done with the demo, deactivate the metric from the Custom Metric Management list. Deactivation stops evaluation without deleting the historical points already collected. Full deletion is on the same row's action menu.
