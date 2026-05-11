# Native column reorder feasibility — `/report/ListServers`

FMN-93 spike. Captured 2026-04-30.

## Question

Can the toolkit's column-reorder UX (FMN-72) be extended to FortiMonitor's
**native** DataTables columns (Group, Heartbeat, Tags, Agent version, etc.),
not just the plugin-controlled sub-columns inside the merged Instance cell?

## TL;DR

**Reorder: don't do it without ColReorder.** Brittle without the official
DataTables extension; the cost of a custom paired TH+TD mover plus
`aoColumns` index rewriting is high and the breakage surface (sort,
width-sync, AJAX redraw) is large. Path forward only exists if FortiMonitor's
build of DataTables ships the ColReorder extension — verifiable in one
browser console line.

**Hide/show: feasible, low risk.** CSS `display:none` on a paired TH + matching
TDs leaves `aoColumns` cardinality intact and does not provoke the
`sWidth`/`Requested unknown parameter` crashes. This is a meaningfully
useful subset of the original ask and could ship independently of reorder.

## Constraints (from past tickets)

| Constraint | Source | Effect |
|---|---|---|
| Adding sibling `<th>`/`<td>` cells crashes column-width sync (`sWidth` TypeError) | FMN-71 | Cannot grow column count |
| Modifying thead pre-`DataTable()` init throws "Requested unknown parameter 'N'" | FMN-71 | Column-count drift between thead and AJAX response |
| Sub-cell alignment in fixed-header layouts requires JS bounding-rect + deferred translateX | FMN-78 / FMN-80 / FMN-81 | CSS sticky / flex tricks insufficient |
| MutationObserver in `augment.js` re-fires on every DOM write — DOM mutations must be gated on a "something changed this pass" flag | FMN-72 | Any reorder write must short-circuit when DOM order already matches persisted order |

These say "don't add or remove columns" and "don't touch thead before init".
They do *not* foreclose post-init *reordering* of paired existing TH+TD cells,
but they constrain how it can be attempted.

## Approaches considered

### 1. DataTables ColReorder extension (preferred if available)

Official jQuery DataTables extension that exposes `colReorder.move(i, j)` and
participates in DataTables' internal column-index bookkeeping. Survives sort,
pagination, and AJAX redraws because aoColumns is rewritten in lockstep with
the DOM move.

**Verification (one-line, operator-runnable in the page console on
`/report/ListServers`):**

```js
(() => {
  const dt = window.jQuery && window.jQuery('table.pa-table_outage').DataTable && window.jQuery('table.pa-table_outage').DataTable();
  return {
    hasDataTables: !!dt,
    hasColReorder: !!(dt && dt.colReorder),
    extensions: dt ? Object.keys(dt.fn || {}) : null,
  };
})();
```

If `hasColReorder === true`, the implementation is essentially:

- Persist `[colIndex, ...]` per augmentation id alongside the existing
  `fm:webguiColumns` record (extend `column-order.js`).
- On page load and on storage change, call `dt.colReorder.order([...])` and
  `dt.columns(hidden).visible(false)`.
- UX: drag handles on each TH (mousedown timer + threshold to coexist with
  FortiMonitor's existing sort click handler), plus a Settings panel list.

If `hasColReorder === false`, this branch is dead; do not pursue.

### 2. Custom paired TH+TD mover (post-init, no extension)

Move both the TH in `thead` and every matching TD across all `tbody` rows in
lockstep, then call `dt.columns.adjust()` to re-sync widths.

**Why brittle:**

- DataTables' internal `aoColumns` array is indexed by *original* column
  position. Sort handlers fire `column(idx).order()` against original indices;
  AJAX responses populate columns by original index. Reordering DOM without
  rewriting `aoColumns` desyncs sort + AJAX redraws.
- Rewriting `aoColumns` from outside is what ColReorder does internally, with
  side-effect tracking we'd be re-implementing. Approximately 1k lines of
  third-party code we'd be re-creating with worse test coverage.
- `_fnAjaxUpdateDraw` redraws the tbody on every page change, wiping our
  TD moves. We'd have to re-run the move on every `draw.dt` event, racing
  DataTables' own dom writes.
- The MutationObserver feedback-loop trap (FMN-72 history) gets worse
  here because reorder writes to thead+tbody on every page redraw, and any
  observer fires during that write would re-enter our handler.

**Cost/risk:** high cost, high regression risk, fragile to FortiMonitor
backend updates. Not recommended.

### 3. CSS-only visual reorder

Use `flex-direction: row` on TR with `order: N` on each cell. Kills DataTables
because TR/TD must be `display: table-row`/`table-cell` for column-width sync,
overflow scroll, and sticky columns. Not viable.

### 4. Hide/show only (feasible, low risk)

`display: none` on a paired TH + the matching TD cells does *not* change
`aoColumns` cardinality. DataTables still considers the column present;
sort, AJAX redraw, width-sync continue to work. Visually the column
disappears. Persist the hidden set in `column-order.js`'s registry under
a new augmentation id (e.g. `instances-list-native`).

**Caveats:**

- DataTables sometimes writes inline `style="width:..."` to TH after init.
  If we use `display:none`, the inline width is moot. If we instead use
  `visibility: collapse`, browsers vary. Stick to `display:none`.
- `dataTables_scrollHeadInner` (FMN-78 fixed-header layout) duplicates the
  thead. Need to apply the hide in *both* the scroll-head and body theads.
  `augment.js` already handles the same problem for the Instance sub-header,
  the pattern carries.
- Native FortiMonitor TH click handler for sort still binds to the real TH —
  hidden columns are simply unsortable from the page (acceptable; they're
  hidden).

## UX surface

If reorder ships (Approach 1):

- TH-level drag handles. Use `mousedown` + 5px threshold + 200ms hold to
  distinguish a drag from a sort click. FortiMonitor's TH `click` handler
  fires only on `mouseup` without a drag. Pattern is well-trodden — same as
  FMN-72's sub-header drag.
- Settings panel list (already exists for sub-columns) extends with the
  native column set under a separate augmentation id.

If only hide/show ships (Approach 4):

- No in-page UX. Settings panel list is the only surface. Operator
  toggles visibility there; page reflects it on next load and on
  `chrome.storage.onChanged`.

## Recommendation

Two follow-up tickets filed:

1. **FMN-122** — Operator-driven probe for ColReorder presence on the live
   tenant. One console line, one screenshot of the result. Outcome gates
   whether Approach 1 is even on the table.

2. **FMN-123** — Hide/show implementation for native columns (Approach 4).
   Ships independently of probe outcome; meaningfully useful on its own.
   Reuses `column-order.js` registry (new augmentation id
   `instances-list-native`), reuses Settings panel pattern from FMN-72,
   no new MutationObserver gating risk because hide/show is idempotent
   CSS.

If FMN-122 returns `hasColReorder: true`, file a third ticket for
Approach 1. If `false`, update this file to record the dead end and
don't revisit without a different approach (e.g., resurrecting FMN-70's
takeover in a feature-flagged form, which was already cancelled by the
operator).

## Probe result (FMN-122, 2026-05-11)

Probed on the operator's live tenant. ColReorder is **not accessible**
from extension content scripts. Approach 1 is closed.

### Diagnostic

```
{
  "url": "https://fortimonitor.forticloud.com/report/ListServers",
  "hasJQuery": true,
  "jQueryVersion": "3.5.1",
  "hasDataTablesPlugin": false,
  "dtVersion": undefined,
  "hasColReorderGlobal": false,
  "colReorderVersion": undefined,
  "tableCount": 2,
  "tables": [
    { "i": 0, "id": null,               "classes": "pa-table pa-table_outage dataTable no-footer", "isDataTable": false, "hasColReorderInstance": false },
    { "i": 1, "id": "inventory-table",  "classes": "pa-table pa-table_outage dataTable no-footer", "isDataTable": false, "hasColReorderInstance": false }
  ]
}
```

### Interpretation

The DOM is clearly DataTables-rendered. Both `<table>` nodes carry
`dataTable no-footer` (DataTables' own emitted classes), and
`augment.js` continues to target `.dataTables_scrollHead`,
`.dataTables_scrollBody`, and `.dataTables_scrollHeadInner` correctly
for FMN-71, FMN-123, and FMN-150. So FortiMonitor does use DataTables
under the hood.

But the DataTables plugin is loaded as a webpack/bundler-scoped module
and never attached to `window.jQuery`. From an MV3 content script we
hold a reference to `window.jQuery` but not to the bundled DataTables
copy that the page actually instantiates the tables with. Calling
`$(t).DataTable()` returns nothing because `$.fn.dataTable` is
undefined; even when DataTables itself has wired up the table.

`dt.colReorder.move(i, j)` is therefore unreachable. There is no
content-script path to retrieve `dt`. ColReorder is, in practical
terms for our extension, not available.

### Outcome

- **Approach 1 (ColReorder)** is closed. No follow-up implementation
  ticket filed.
- **Approach 2 (custom paired TH+TD mover)** remains rejected on
  cost/risk grounds (see the existing analysis above).
- **Approach 4 (hide/show only)** shipped as FMN-123 (commit
  `118cf02`). That is the entire reordering-adjacent functionality
  the extension ships on `/report/ListServers`.

Native column reorder will not be revisited unless a different escape
hatch appears, e.g. FortiMonitor exposing the DataTables instance on a
known global, or operator-approved revival of FMN-70's takeover. Both
are out of scope here.

## Out of scope

- Implementation. This ticket was a spike.
- Other FortiMonitor list pages. `/report/ListServers` only.
- Replacing DataTables (covered and cancelled by FMN-74).
