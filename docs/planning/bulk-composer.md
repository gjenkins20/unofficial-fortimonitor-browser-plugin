# Bulk Action Composer (FMN-155)

A 4-step wizard tool that picks a subset of instances, picks an action, configures it, previews a per-row prev vs. next table, and commits with bounded concurrency. v1 supports three actions:

- **Add Tag**
- **Remove Tag**
- **Apply Template**

The subset picker re-uses the FMN-152 omni-search corpus so selection is fast on tenants with thousands of servers. Mid-wizard drafts persist in `chrome.storage.local` so an accidental tab close does not lose the operator's progress.

Beta-gated. Requires a configured RW API key and opt-in via popup -> Settings ("Show Bulk Action Composer").

See also: [FMN-155 ticket on Plane](https://app.plane.so/myrug/projects/).
