# Custom Metrics - Training Examples

Companion to the **Custom Metrics** training module surfaced by the Unofficial FortiMonitor Toolkit (FMN-244). The module covers the *what* and *why*; this directory carries a concrete, end-to-end *how*.

The example below is reproducible by any new operator with access to a FortiMonitor tenant and an OnSight appliance. It uses one of FortiMonitor's built-in custom-metric data sources (script execution on an OnSight) so no third-party tooling is required.

## Source documentation

The example terminology mirrors:

- *Custom Metric Management* - FortiMonitor 26.2.0 user guide, page 66910.
- *Custom Metrics and Incidents* - FortiMonitor 26.2.0 user guide, page 382178.

## Example: Active SSH sessions on an OnSight appliance

A small, demonstrable custom metric that:

- Runs entirely on infrastructure FortiMonitor already manages (the OnSight appliance itself).
- Returns a single integer the operator can reason about (a session count).
- Has obviously-sensible thresholds (a spike in concurrent SSH sessions on an unattended OnSight is worth a look).
- Walks through every concern the training module names: identity, data source, units + display, scope, frequency, thresholds, and incident routing.

### Prerequisites

- A FortiMonitor tenant the operator can log into.
- At least one OnSight appliance attached to that tenant. Any OnSight will do; the example does not assume any particular hardware revision.
- A test account on the OnSight whose SSH activity the operator can vary on demand (open a second SSH session, log out, etc.) so the metric can be observed reacting in near-real time.

### Files in this example

```
example-ssh-sessions/
  script.sh    - the data-source script run by the OnSight on schedule
  config.md    - field-by-field FortiMonitor configuration walkthrough
```

### Walkthrough

1. Read `example-ssh-sessions/config.md` for the field-by-field FortiMonitor setup. Every UI field the management view asks for is named with its expected value and a short justification.
2. Drop `example-ssh-sessions/script.sh` onto your OnSight (the config doc names the destination path) and `chmod +x` it.
3. Author the custom metric in FortiMonitor against the example values.
4. Wait one evaluation cycle (5 minutes by default), then verify the recent-value column on the Custom Metric Management view reads the current SSH session count.
5. Trigger a threshold breach: open enough additional SSH sessions to cross the warning bound, wait the sustained-time window, and confirm an Incident appears under *Incidents*.

### Cleanup

Deactivate the metric from the Custom Metric Management view when you are done. Deactivation stops evaluation without removing the historical points already collected; full deletion removes both.

## Adding your own examples

Drop new example folders alongside `example-ssh-sessions/`. Each example folder should carry a `config.md` that walks every FortiMonitor field by name, plus any helper artifacts (scripts, sample payloads, screenshots) the operator needs to reproduce it end-to-end.
