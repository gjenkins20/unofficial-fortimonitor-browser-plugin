# Native Column Reorder / Hide (FMN-71, FMN-151)

Reorders and hides FortiMonitor's native DataTables columns on `/report/ListServers` (Parent Group, Alert Timeline, Tags, Agent Version, Device Heartbeat). Two surfaces:

1. **FM TK Columns button + popover** in FortiMonitor's bulk-action row (FMN-150). The popover shares storage with the popup card so toggles propagate live.
2. **Drag handles on the sub-headers** directly on the FortiMonitor page (FMN-71).

The implementation hides via paired `display: none` on `<th>` + `<td>` rather than removing nodes from DataTables' `aoColumns`. This preserves sort, AJAX redraw, and column-width sync.

See also:

- [FMN-71 ticket on Plane (Instance IP/DNS columns + reorder)](https://app.plane.so/myrug/projects/).
- [FMN-151 ticket on Plane (column-width sync for merged Instance cell)](https://app.plane.so/myrug/projects/).
