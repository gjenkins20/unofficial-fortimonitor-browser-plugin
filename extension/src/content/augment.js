// FMN-69: FortiMonitor WebGUI augmentation framework + FM Toolkit sidebar
// entry. Runs as a content script on FortiMonitor domains. Survives SPA
// re-renders via MutationObserver and route changes via pushState/replaceState
// /popstate hooks. Clicking the FM Toolkit entry toggles an iframe overlay
// that embeds the existing popup.html, so the sidebar menu IS the popup with
// identical styling, search, settings, tool cards, and behavior.

(() => {
  // Dev-reload bridge: lets the operator (or an automation tool driving the
  // page) trigger chrome.runtime.reload() of this extension via a DOM event,
  // skipping the manual chrome://extensions reload step during iteration.
  //
  // Inert by default. Activates only when the operator has explicitly opted
  // in by running this on a FortiMonitor tab once:
  //
  //   localStorage.setItem('fmn_dev_reload', '1')
  //
  // To trigger a reload from any context that can dispatch DOM events on the
  // page (DevTools, browser-automation MCP, etc.):
  //
  //   document.dispatchEvent(new CustomEvent('fmn-dev-reload-extension'))
  //
  // Third-party sites cannot set FortiMonitor-origin localStorage, so an
  // unsuspecting installer of the toolkit is unaffected: the listener never
  // attaches without their explicit opt-in.
  try {
    if (localStorage.getItem('fmn_dev_reload') === '1') {
      document.addEventListener('fmn-dev-reload-extension', () => {
        // FMN-85: chrome.runtime.reload is a privileged-context API and is
        // not available in content scripts. Route the request through a
        // chrome.runtime message; the service worker handles the actual
        // reload (it has full chrome.runtime access).
        console.log('[FMN dev] requesting extension reload');
        chrome.runtime.sendMessage({ type: 'fm:dev-reload-extension' }).catch((err) => {
          // Service worker tears down mid-send when it calls
          // chrome.runtime.reload, so a "Receiving end does not exist" or
          // similar rejection is expected and means the reload succeeded.
          // Log at info level rather than warn.
          console.log('[FMN dev] reload-message channel closed (expected on reload):', err && err.message);
        });
      });
    }
  } catch {
    // localStorage inaccessible (sandboxed iframe, etc.) - silently skip.
  }

  const LAUNCHER_ID = 'toolkit-launcher';
  const OVERLAY_ID = 'fmn-toolkit-overlay';
  const ENTRY_ATTR = 'data-fmn-entry';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const POPUP_URL = chrome.runtime.getURL('src/popup/popup.html');
  // FMN-83: sidebar launcher is opt-in via popup ⚙ Settings. Mirror of the
  // SIDEBAR_LAUNCHER_ENABLED_KEY constant in src/lib/settings.js — keep both
  // in sync. Default false so a fresh install doesn't inject the entry.
  const SIDEBAR_LAUNCHER_KEY = 'fm:sidebarLauncherEnabled';
  // FMN-86: per-feature "FM Toolkit" attribution ribbon. Mirror of
  // SHOW_FEATURE_BADGES_KEY in src/lib/settings.js. Default true so a
  // fresh install attributes each visible UI feature this extension adds
  // to FortiMonitor pages. Toggle change takes effect on the next page
  // load (no in-flight hot-update — augmentations only run once per page).
  const SHOW_FEATURE_BADGES_KEY = 'fm:showFeatureBadges';
  const FEATURE_BADGE_STYLE_ID = 'fmn-feature-badge-styles';
  const FEATURE_BADGE_HOST_ATTR = 'data-fmn-badge-host';

  const augmentations = [];
  const overlayState = { el: null, outsideHandler: null, keyHandler: null };
  let sidebarLauncherEnabled = false;
  let showFeatureBadgesEnabled = true;

  function register(aug) {
    augmentations.push(aug);
  }

  function ensureAll() {
    for (const aug of augmentations) {
      try {
        aug.mount();
      } catch (err) {
        console.error('[FMN augment]', aug.id, err);
      }
    }
  }

  register({
    id: LAUNCHER_ID,
    mount() {
      const existing = document.querySelector(`[${ENTRY_ATTR}="${LAUNCHER_ID}"]`);
      // FMN-83: launcher is gated on the operator's setting. Remove the
      // existing entry (and any open overlay anchored on it) when the flag
      // flips from on to off; bail when the flag is off and nothing is
      // mounted.
      if (!sidebarLauncherEnabled) {
        if (existing) existing.remove();
        if (overlayState.el) hideOverlay();
        return;
      }
      if (existing) return;
      const anyTopLevel = document.querySelector('li.pa-side-nav__top-level-item');
      if (!anyTopLevel || !anyTopLevel.parentElement) return;
      anyTopLevel.parentElement.appendChild(buildLauncherEntry());
    },
  });

  // FMN-71: IP Address + DNS Name columns on /report/ListServers.
  // Source: /report/get_idp_data?server_id={id} -> pageData.instance.fqdn,
  // classified into IP vs. DNS by regex. Fetches are per-row with
  // concurrency 3 and cached in-memory for the session.
  //
  // FMN-72/FMN-73: order + visibility per sub-column, persisted in
  // chrome.storage.local under "fm:webguiColumns". Mirror of the registry +
  // normalize logic in src/lib/column-order.js — keep both in sync.
  const INSTANCES_PATH = '/report/ListServers';
  const SERVER_ID_RE = /^s-(\d+)$/;
  const APPLIANCE_ID_RE = /^a-\d+$/;
  const OTHER_ID_RE = /^cs-\d+$/;
  const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
  const IPV6_HINT_RE = /^[0-9a-fA-F:]+$/;
  const FETCH_CONCURRENCY = 3;
  const HEADER_AUG_ATTR = 'data-fmn-ip-augmented';
  const ROW_AUG_ATTR = 'data-fmn-ip-row-augmented';
  const IP_CELL_ATTR = 'data-fmn-ip-cell';
  const DNS_CELL_ATTR = 'data-fmn-dns-cell';
  const MODEL_CELL_ATTR = 'data-fmn-model-cell';
  const MODEL_NUMBER_CELL_ATTR = 'data-fmn-model-number-cell';
  const OS_CELL_ATTR = 'data-fmn-os-cell';
  const COL_ATTR = 'data-fmn-col';
  const WEBGUI_COLUMNS_KEY = 'fm:webguiColumns';
  const AUG_ID = 'instances-ip-dns-columns';

  // Column metadata for the Instances list augmentation. Mirror of the
  // 'instances-ip-dns-columns' entry in src/lib/column-order.js.
  const COLUMNS = {
    instance:    { label: 'Instance',   lockedVisible: true,  width: 'minmax(120px, 1fr)' },
    ip:          { label: 'IP Address', lockedVisible: false, width: 'minmax(110px, 130px)' },
    dns:         { label: 'DNS Name',   lockedVisible: false, width: 'minmax(140px, 200px)' },
    type:        { label: 'Type',       lockedVisible: false, width: 'minmax(110px, 150px)' },
    model:       { label: 'Model',      lockedVisible: false, width: 'minmax(110px, 150px)' },
    modelNumber: { label: 'Model #',    lockedVisible: false, width: 'minmax(100px, 140px)' },
    os:          { label: 'OS',         lockedVisible: false, width: 'minmax(110px, 180px)' },
  };
  const DEFAULT_COL_IDS = ['instance', 'ip', 'dns', 'type', 'model', 'modelNumber', 'os'];

  // FMN-75: classify the row by its checkbox-value prefix (per FMN-71 capture).
  // Returns a display label or null if the value doesn't match a known prefix.
  function classifyInstancePrefix(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    if (SERVER_ID_RE.test(v)) return 'Server';
    if (APPLIANCE_ID_RE.test(v)) return 'OnSight Appliance';
    if (OTHER_ID_RE.test(v)) return 'Other';
    return null;
  }

  const fetchCache = new Map();
  const fetchQueue = [];
  let activeFetches = 0;
  const sortState = { column: null, direction: null };
  let currentColumns = defaultColumnOrder();
  let columnOrderLoaded = false;

  function defaultColumnOrder() {
    return DEFAULT_COL_IDS.map((id) => ({ id, hidden: false }));
  }

  function normalizeColumnOrder(persisted) {
    const known = new Set(DEFAULT_COL_IDS);
    const seen = new Set();
    const out = [];
    if (Array.isArray(persisted)) {
      for (const entry of persisted) {
        if (!entry || typeof entry.id !== 'string') continue;
        if (!known.has(entry.id)) continue;
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        const meta = COLUMNS[entry.id];
        out.push({
          id: entry.id,
          hidden: meta.lockedVisible ? false : Boolean(entry.hidden),
        });
      }
    }
    for (const id of DEFAULT_COL_IDS) {
      if (!seen.has(id)) out.push({ id, hidden: false });
    }
    return out;
  }

  async function loadColumnOrder() {
    try {
      const data = await chrome.storage.local.get(WEBGUI_COLUMNS_KEY);
      const all = (data && data[WEBGUI_COLUMNS_KEY]) || {};
      currentColumns = normalizeColumnOrder(all[AUG_ID]);
    } catch {
      currentColumns = defaultColumnOrder();
    }
    columnOrderLoaded = true;
  }

  async function persistColumnOrder(list) {
    const normalized = normalizeColumnOrder(list);
    let current = {};
    try {
      const data = await chrome.storage.local.get(WEBGUI_COLUMNS_KEY);
      current = (data && data[WEBGUI_COLUMNS_KEY]) || {};
    } catch {
      current = {};
    }
    const next = Object.assign({}, current, { [AUG_ID]: normalized });
    await chrome.storage.local.set({ [WEBGUI_COLUMNS_KEY]: next });
  }

  function subscribeColumnOrder() {
    if (!chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName && areaName !== 'local') return;
      const change = changes && changes[WEBGUI_COLUMNS_KEY];
      if (!change) return;
      const newAll = (change.newValue) || {};
      const next = normalizeColumnOrder(newAll[AUG_ID]);
      if (sameOrder(currentColumns, next)) return;
      currentColumns = next;
      applyColumnOrderToDom();
    });
  }

  function sameOrder(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id || a[i].hidden !== b[i].hidden) return false;
    }
    return true;
  }

  register({
    id: 'instances-ip-dns-columns',
    mount() {
      if (location.pathname !== INSTANCES_PATH) return;
      // Gate: only touch the DOM once DataTables has finished its first draw
      // (signaled by any tbody containing a data row). Modifying thead before
      // DataTables' own .DataTable() call would make its column count 11 and
      // blow up on the 9-column AJAX response ("Requested unknown parameter
      // '9' for row 0, column 9"). Post-init thead changes are cosmetic.
      const hasDataRows = !!document.querySelector(
        'table.pa-table_outage tbody tr input.pa-table-row-checkbox'
      );
      if (!hasDataRows) return;
      ensureColumnStyles();
      let anyChanged = false;
      for (const table of document.querySelectorAll('table.pa-table_outage')) {
        if (augmentTable(table)) anyChanged = true;
      }
      // FMN-151: The Instance cell's fmn-instance-merged min-width (1080px)
      // pushes both scroll-head and scroll-body tables past DataTables'
      // first-draw column-width measurement. Without re-pinning, the two
      // tables size independently to their own content and drift apart
      // (head ~1780px, body ~2007px on a typical tenant), cumulating into
      // ~228px column-boundary offset by the right end. Idempotent: only
      // called when augmentTable actually mutated DOM this pass.
      if (anyChanged) {
        syncScrollTableWidths();
        // Keep the DataTables-adjust call as a defense-in-depth path for
        // any tenant that exposes $.fn.DataTable.
        requestDataTablesAdjust();
      }
    },
  });

  // FMN-123: hide/show for FortiMonitor's native DataTables columns on
  // /report/ListServers. Reorder is intentionally NOT implemented here -
  // it is gated on FMN-122's ColReorder probe outcome. Hide/show via
  // display:none on paired TH+TDs does not change DataTables' aoColumns
  // cardinality, so sort/AJAX redraw/width-sync continue to work.
  //
  // Mirror of the 'instances-list-native' entry in src/lib/column-order.js.
  // The ids and matchText values must stay in sync.
  const NATIVE_AUG_ID = 'instances-list-native';
  const NATIVE_HIDDEN_ATTR = 'data-fmn-native-hidden';
  const NATIVE_STYLE_ID = 'fmn-native-column-styles';
  const NATIVE_COLUMN_DEFS = [
    { id: 'instance',      lockedVisible: true,  matchText: 'Instance' },
    { id: 'parentGroup',   lockedVisible: false, matchText: 'Parent Group' },
    { id: 'alertTimeline', lockedVisible: false, matchText: 'Alert Timeline' },
    { id: 'tags',          lockedVisible: false, matchText: 'Tags' },
    { id: 'agentVersion',  lockedVisible: false, matchText: 'Agent Version' },
    { id: 'heartbeat',     lockedVisible: false, matchText: 'Device Heartbeat' },
  ];
  const NATIVE_DEFAULT_COL_IDS = NATIVE_COLUMN_DEFS.map((c) => c.id);
  const NATIVE_META_BY_ID = new Map(NATIVE_COLUMN_DEFS.map((c) => [c.id, c]));

  let currentNativeColumns = defaultNativeColumnOrder();
  let nativeColumnOrderLoaded = false;

  function defaultNativeColumnOrder() {
    return NATIVE_DEFAULT_COL_IDS.map((id) => ({ id, hidden: false }));
  }

  function normalizeNativeColumnOrder(persisted) {
    const seen = new Set();
    const out = [];
    if (Array.isArray(persisted)) {
      for (const entry of persisted) {
        if (!entry || typeof entry.id !== 'string') continue;
        const meta = NATIVE_META_BY_ID.get(entry.id);
        if (!meta) continue;
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push({
          id: entry.id,
          hidden: meta.lockedVisible ? false : Boolean(entry.hidden),
        });
      }
    }
    for (const id of NATIVE_DEFAULT_COL_IDS) {
      if (!seen.has(id)) out.push({ id, hidden: false });
    }
    return out;
  }

  async function loadNativeColumnOrder() {
    try {
      const data = await chrome.storage.local.get(WEBGUI_COLUMNS_KEY);
      const all = (data && data[WEBGUI_COLUMNS_KEY]) || {};
      currentNativeColumns = normalizeNativeColumnOrder(all[NATIVE_AUG_ID]);
    } catch {
      currentNativeColumns = defaultNativeColumnOrder();
    }
    nativeColumnOrderLoaded = true;
  }

  function subscribeNativeColumnOrder() {
    if (!chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName && areaName !== 'local') return;
      const change = changes && changes[WEBGUI_COLUMNS_KEY];
      if (!change) return;
      const newAll = (change.newValue) || {};
      const next = normalizeNativeColumnOrder(newAll[NATIVE_AUG_ID]);
      if (sameOrder(currentNativeColumns, next)) return;
      currentNativeColumns = next;
      applyNativeHideShowToAll();
      // FMN-151: directly re-sync head and body widths after hide/show.
      // requestDataTablesAdjust silently no-ops on this tenant
      // because $.fn.DataTable is not exposed at content-script eval time.
      syncScrollTableWidths();
      requestDataTablesAdjust();
    });
  }

  function ensureNativeColumnStyles() {
    if (document.getElementById(NATIVE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = NATIVE_STYLE_ID;
    // FMN-151: Do NOT use `display: none` here. With table-layout:fixed
    // and our FMN-151 colgroup, a column whose cells are display:none
    // causes Chrome to silently zero the ADJACENT column's allotted
    // width too (verified live on a real tenant; adjacent col[i]
    // computed width comes back 0 even with width:200px !important).
    // Instead, zero out padding + borders + content visibility, and rely
    // on syncScrollTableWidths() setting col[i].style.width = 0 in the
    // colgroup to actually collapse the column. Both rows stay in
    // layout, so adjacent columns are unaffected.
    style.textContent = `
      table.pa-table_outage th[${NATIVE_HIDDEN_ATTR}],
      table.pa-table_outage td[${NATIVE_HIDDEN_ATTR}] {
        padding: 0 !important;
        border: 0 !important;
        overflow: hidden !important;
      }
      table.pa-table_outage th[${NATIVE_HIDDEN_ATTR}] > *,
      table.pa-table_outage td[${NATIVE_HIDDEN_ATTR}] > * {
        visibility: hidden !important;
      }
    `;
    document.head.appendChild(style);
  }

  // For each table on the page (scroll-head clone + body table when
  // DataTables fixed-header layout is active, single table otherwise),
  // build a column-index → header-text map from thead, then for every
  // hidden column id in currentNativeColumns mark TH and matching-index
  // TDs with the hidden attribute. Idempotent: only mutates the
  // attribute when the desired value differs from the current one, so
  // re-runs do not trigger MutationObserver feedback loops.
  function applyNativeHideShowToAll() {
    if (!nativeColumnOrderLoaded) return;
    const tables = document.querySelectorAll('table.pa-table_outage');
    if (tables.length === 0) return;
    ensureNativeColumnStyles();
    for (const table of tables) {
      applyNativeHideShowToTable(table);
    }
  }

  function applyNativeHideShowToTable(table) {
    const thead = table.querySelector('thead');
    if (!thead) return;
    const headerRow = thead.querySelector('tr');
    if (!headerRow) return;
    const headerCells = Array.from(headerRow.children);
    if (headerCells.length === 0) return;

    // Map registry id → column index, by trimmed-text TH match.
    const idToIndex = new Map();
    for (const def of NATIVE_COLUMN_DEFS) {
      const match = def.matchText.toLowerCase();
      for (let i = 0; i < headerCells.length; i++) {
        const text = (headerCells[i].textContent || '').trim().toLowerCase();
        if (text === match || text.startsWith(match)) {
          if (!idToIndex.has(def.id)) idToIndex.set(def.id, i);
        }
      }
    }
    if (idToIndex.size === 0) return;

    for (const col of currentNativeColumns) {
      const idx = idToIndex.get(col.id);
      if (idx == null) continue;
      const meta = NATIVE_META_BY_ID.get(col.id);
      // Locked-visible columns can never be hidden, even if storage
      // says otherwise. normalize() also enforces this; defense in depth.
      const wantHidden = !meta?.lockedVisible && Boolean(col.hidden);
      const headerCell = headerCells[idx];
      if (headerCell) setHiddenAttr(headerCell, wantHidden);
      const bodyRows = table.querySelectorAll('tbody > tr');
      for (const row of bodyRows) {
        const cell = row.children[idx];
        if (cell) setHiddenAttr(cell, wantHidden);
      }
    }
  }

  function setHiddenAttr(el, wantHidden) {
    const has = el.hasAttribute(NATIVE_HIDDEN_ATTR);
    if (wantHidden && !has) el.setAttribute(NATIVE_HIDDEN_ATTR, '1');
    else if (!wantHidden && has) el.removeAttribute(NATIVE_HIDDEN_ATTR);
  }

  // After visibility changes, ask DataTables to re-fit remaining columns.
  // Best-effort: jQuery is loaded on FortiMonitor but $.fn.DataTable is
  // not exposed at the time augment.js runs (probed live during FMN-151),
  // so this typically no-ops. syncScrollTableWidths() below is the
  // authoritative width-sync; this function is kept for tenants that may
  // expose the DataTable API differently.
  function requestDataTablesAdjust() {
    try {
      const $ = window.jQuery;
      if (!$ || typeof $ !== 'function') return;
      const $tables = $('table.pa-table_outage');
      $tables.each(function () {
        const $t = $(this);
        if (typeof $t.DataTable !== 'function') return;
        const dt = $t.DataTable();
        if (!dt) return;
        if (typeof dt.columns === 'function') {
          const cols = dt.columns();
          if (cols && typeof cols.adjust === 'function') cols.adjust();
        }
      });
    } catch {
      // jQuery / DataTables absent or threw - hide/show still worked
      // visually via CSS; sort/scroll behavior may be slightly off until
      // the next native draw. Acceptable.
    }
  }

  // FMN-151: directly synchronize the scroll-head and scroll-body table
  // widths. Required because FortiMonitor does not expose $.fn.DataTable
  // at content-script-eval time (verified live), so requestDataTablesAdjust
  // silently no-ops. The two tables size independently to their own
  // intrinsic content under auto-layout, which the FMN-71 1080px Instance
  // min-width pushes past DataTables' first-draw measurement, producing a
  // ~200+px column-boundary drift between thead and tbody by the right
  // end of the table.
  //
  // Sync algorithm: write column widths into a <colgroup>/<col> set on
  // each of the head and body tables. Under table-layout:fixed the
  // colgroup widths are the authoritative column-width source: per-cell
  // padding differences between thead and tbody (which FortiMonitor's CSS
  // applies asymmetrically - e.g. paddingRight:10px on TH vs 0 on TD on
  // some columns) are absorbed inside the column, so the rendered cell
  // rect at column N matches between head and body. Per-cell width styles
  // and CSS !important rules (like the 20px checkbox-column override) are
  // also respected: with table-layout:fixed, the column width wins.
  //
  // Hidden columns (display:none from FMN-123 hide/show) get a 0-width
  // <col> so the column collapses; the body cell's display:none ensures
  // the content stays hidden.
  function syncScrollTableWidths() {
    const scrollHead = document.querySelector('.dataTables_scrollHead table.pa-table_outage');
    const scrollBody = document.querySelector('.dataTables_scrollBody table.pa-table_outage');
    if (!scrollHead || !scrollBody) return;
    const headRow = scrollHead.querySelector('thead tr');
    const bodyFirstRow = scrollBody.querySelector('tbody tr');
    if (!headRow || !bodyFirstRow) return;
    const headCells = Array.from(headRow.children);
    const bodyCells = Array.from(bodyFirstRow.children);
    if (headCells.length !== bodyCells.length) return;

    // Clear any prior pinning so we measure natural widths fresh. Without
    // this, post-toggle calls would re-measure our own pinned values and
    // the sync would be a no-op.
    scrollHead.style.tableLayout = '';
    scrollBody.style.tableLayout = '';
    scrollHead.style.width = '';
    scrollBody.style.width = '';
    removeFmnColgroup(scrollHead);
    removeFmnColgroup(scrollBody);
    void scrollBody.offsetWidth;

    // Measure per-column rendered widths from both tables. Use the larger
    // so neither side's content overflows. Cells flagged hidden by the
    // FMN-123 native-hidden mechanism contribute 0 - we collapse the
    // column via colgroup col[i].width = 0 below, and FMN-151's CSS
    // ensures the cell renders at zero effective width (padding 0 +
    // content visibility:hidden).
    const isFmnHidden = (el) => el && el.hasAttribute(NATIVE_HIDDEN_ATTR);
    const widths = [];
    for (let i = 0; i < headCells.length; i++) {
      const headCell = headCells[i];
      const bodyCell = bodyCells[i];
      const headHidden = isFmnHidden(headCell);
      const bodyHidden = isFmnHidden(bodyCell);
      if (headHidden && bodyHidden) { widths.push(0); continue; }
      const hW = headHidden ? 0 : headCell.getBoundingClientRect().width;
      const bW = bodyHidden ? 0 : bodyCell.getBoundingClientRect().width;
      widths.push(Math.max(hW, bW));
    }

    const total = widths.reduce((a, b) => a + b, 0);
    scrollHead.style.width = total + 'px';
    scrollBody.style.width = total + 'px';
    scrollHead.style.tableLayout = 'fixed';
    scrollBody.style.tableLayout = 'fixed';
    applyFmnColgroup(scrollHead, widths);
    applyFmnColgroup(scrollBody, widths);
    scrollHead.setAttribute('data-fmn-width-synced', JSON.stringify(widths));
    scrollBody.setAttribute('data-fmn-width-synced', JSON.stringify(widths));
  }

  // Clear widths on any existing colgroup cols so per-column measurement
  // sees natural widths, not values we (or DataTables) pinned earlier.
  // We do not delete the colgroup itself - FortiMonitor / DataTables may
  // rely on its presence and we want to reuse it in applyFmnColgroup.
  function removeFmnColgroup(table) {
    const cg = table.querySelector('colgroup');
    if (!cg) return;
    for (const col of cg.children) col.style.width = '';
  }

  function applyFmnColgroup(table, widths) {
    // Reuse the existing colgroup if any (preserving its non-width state),
    // otherwise create one. Adjust the <col> count to match the column
    // count, then set widths.
    let cg = table.querySelector('colgroup');
    if (!cg) {
      cg = document.createElement('colgroup');
      table.insertBefore(cg, table.firstChild);
    }
    cg.setAttribute('data-fmn-colgroup', '1');
    while (cg.children.length < widths.length) cg.appendChild(document.createElement('col'));
    while (cg.children.length > widths.length) cg.removeChild(cg.lastElementChild);
    for (let i = 0; i < widths.length; i++) {
      // 0-width columns collapse; we keep them in the DOM so column
      // indices stay aligned with cell indices.
      cg.children[i].style.width = (widths[i] > 0 ? widths[i] : 0) + 'px';
    }
  }

  register({
    id: NATIVE_AUG_ID,
    mount() {
      if (location.pathname !== INSTANCES_PATH) return;
      // Same DataTables-init gate as instances-ip-dns-columns: bail
      // until tbody has at least one data row. This keeps us from
      // touching thead before DataTables has read aoColumns.
      const hasDataRows = !!document.querySelector(
        'table.pa-table_outage tbody tr input.pa-table-row-checkbox'
      );
      if (!hasDataRows) return;
      applyNativeHideShowToAll();
    },
  });

  // FMN-150: in-page "Columns" button + popover on /report/ListServers.
  // Anchors a toolkit-styled trigger to FortiMonitor's bulk-action row
  // (Add / Move / Delete / Tag / Download) and opens a popover whose
  // toggles share the same fm:webguiColumns['instances-list-native']
  // storage key as the FMN-123 popup card. chrome.storage.onChanged
  // already drives applyNativeHideShowToAll(), so toggling in either
  // surface updates the page and the other surface live.
  const COLUMNS_BUTTON_ID = 'fmn-columns-button';
  const COLUMNS_POPOVER_ID = 'fmn-columns-popover';
  const COLUMNS_MENU_STYLE_ID = 'fmn-columns-menu-styles';
  const COLUMNS_MENU_ID = 'instances-columns-menu';
  const COLUMNS_LABEL_BY_ID = {
    instance: 'Instance',
    parentGroup: 'Parent Group',
    alertTimeline: 'Alert Timeline',
    tags: 'Tags',
    agentVersion: 'Agent Version',
    heartbeat: 'Device Heartbeat',
  };

  const columnsPopoverState = {
    el: null,
    anchor: null,
    outsideHandler: null,
    keyHandler: null,
    scrollHandler: null,
    resizeHandler: null,
  };

  function ensureColumnsMenuStyles() {
    if (document.getElementById(COLUMNS_MENU_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = COLUMNS_MENU_STYLE_ID;
    style.textContent = `
      .fmn-columns-trigger {
        display: inline-flex; align-items: center; gap: 6px;
        background: #fff; border: 1px solid #B6C8EB;
        color: #3954BF; border-radius: 4px;
        padding: 6px 10px; font-size: 12px; font-weight: 500;
        cursor: pointer; line-height: 1; font-family: inherit;
        margin-left: auto;
      }
      .fmn-columns-trigger:hover { background: #E8ECF8; }
      .fmn-columns-trigger.is-open { background: #E8ECF8; }
      .fmn-columns-trigger .fmn-tk-chip {
        display: inline-block; font-size: 9.5px; font-weight: 700;
        background: #3954BF; color: #fff; padding: 2px 4px; border-radius: 2px;
        letter-spacing: 0.04em;
      }
      .fmn-columns-trigger .fmn-caret { font-size: 9px; color: #9AA4BC; }
      .fmn-columns-popover {
        position: fixed; z-index: 2147483646;
        background: #fff; border: 1px solid #D6D9DD; border-radius: 6px;
        box-shadow: 0 6px 22px rgba(16, 22, 26, 0.18);
        width: 268px; padding: 0;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif;
        color: #394449;
      }
      .fmn-columns-popover-header {
        display: flex; justify-content: space-between; align-items: baseline;
        padding: 10px 12px 8px; border-bottom: 1px solid #E4E7EB;
      }
      .fmn-columns-popover-title { font-size: 12px; font-weight: 600; color: #394449; }
      .fmn-columns-popover-context {
        font-size: 10.5px; color: #9AA4BC;
        font-family: ui-monospace, Menlo, monospace;
      }
      .fmn-columns-popover-list { padding: 4px 0; max-height: 320px; overflow-y: auto; }
      .fmn-columns-popover-row {
        display: grid; grid-template-columns: 1fr 28px;
        align-items: center; gap: 8px;
        padding: 7px 12px; font-size: 12.5px;
      }
      .fmn-columns-popover-row + .fmn-columns-popover-row {
        border-top: 1px solid #E4E7EB;
      }
      .fmn-columns-popover-row.is-locked .fmn-col-name::after {
        content: ' (always visible)'; color: #9AA4BC;
        font-size: 10.5px; font-style: italic; font-weight: 400;
      }
      .fmn-columns-popover-row.is-hidden .fmn-col-name {
        color: #9AA4BC; text-decoration: line-through;
      }
      .fmn-col-name {
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .fmn-col-toggle {
        width: 28px; height: 24px; border: 1px solid #D6D9DD;
        background: #fff; border-radius: 4px;
        cursor: pointer; color: #9AA4BC;
        font: inherit; padding: 0;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .fmn-col-toggle.is-on {
        color: #3954BF; border-color: #B6C8EB; background: #E8ECF8;
      }
      .fmn-col-toggle:disabled { opacity: 0.45; cursor: default; }
      .fmn-columns-popover-footer {
        display: flex; justify-content: flex-end;
        padding: 8px 12px; border-top: 1px solid #E4E7EB; background: #FAFBFC;
      }
      .fmn-columns-popover-reset {
        background: transparent; border: none; color: #3954BF;
        font-size: 11.5px; cursor: pointer; padding: 0; font-family: inherit;
      }
      .fmn-columns-popover-reset:hover { text-decoration: underline; }
    `;
    document.head.appendChild(style);
  }

  // Find FortiMonitor's bulk-action row on /report/ListServers by
  // text-matching the canonical button labels (Move/Delete/Tag/Download)
  // and locating their common parent. Resilient across class-name churn.
  // Returns null if fewer than 3 of the expected labels are co-resident.
  function findInstancesActionBar() {
    const WANTED = new Set(['move', 'delete', 'tag', 'download']);
    const counts = new Map();
    const parents = [];
    const buttons = document.querySelectorAll(
      'button, a.btn, .btn, [role="button"]'
    );
    for (const el of buttons) {
      const text = (el.textContent || '').trim().toLowerCase();
      if (!WANTED.has(text)) continue;
      const parent = el.parentElement;
      if (!parent) continue;
      if (!counts.has(parent)) {
        counts.set(parent, 0);
        parents.push(parent);
      }
      counts.set(parent, counts.get(parent) + 1);
    }
    let best = null;
    let bestCount = 0;
    for (const parent of parents) {
      const count = counts.get(parent);
      if (count > bestCount) {
        best = parent;
        bestCount = count;
      }
    }
    return bestCount >= 3 ? best : null;
  }

  function buildColumnsButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = COLUMNS_BUTTON_ID;
    btn.setAttribute(ENTRY_ATTR, COLUMNS_MENU_ID);
    btn.className = 'fmn-columns-trigger';
    btn.title = 'Show or hide table columns';

    const chip = document.createElement('span');
    chip.className = 'fmn-tk-chip';
    chip.textContent = 'FM TK';
    btn.appendChild(chip);

    const label = document.createElement('span');
    label.textContent = 'Columns';
    btn.appendChild(label);

    const caret = document.createElement('span');
    caret.className = 'fmn-caret';
    caret.textContent = '▾';
    btn.appendChild(caret);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (columnsPopoverState.el) {
        closeColumnsPopover();
      } else {
        openColumnsPopover(btn);
      }
    });

    return btn;
  }

  function openColumnsPopover(anchor) {
    if (columnsPopoverState.el) return;
    ensureColumnsMenuStyles();

    const popover = document.createElement('div');
    popover.id = COLUMNS_POPOVER_ID;
    popover.className = 'fmn-columns-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Table columns');

    renderColumnsPopoverContents(popover);
    document.body.appendChild(popover);
    columnsPopoverState.el = popover;
    columnsPopoverState.anchor = anchor;

    repositionColumnsPopover();
    anchor.classList.add('is-open');

    const outsideHandler = (e) => {
      const target = e.target;
      if (popover.contains(target)) return;
      if (anchor.contains(target) || target === anchor) return;
      closeColumnsPopover();
    };
    document.addEventListener('mousedown', outsideHandler, true);
    columnsPopoverState.outsideHandler = outsideHandler;

    const keyHandler = (e) => {
      if (e.key === 'Escape') closeColumnsPopover();
    };
    document.addEventListener('keydown', keyHandler);
    columnsPopoverState.keyHandler = keyHandler;

    const reposition = () => repositionColumnsPopover();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    columnsPopoverState.scrollHandler = reposition;
    columnsPopoverState.resizeHandler = reposition;
  }

  function closeColumnsPopover() {
    if (columnsPopoverState.anchor) {
      columnsPopoverState.anchor.classList.remove('is-open');
    }
    if (columnsPopoverState.el) {
      columnsPopoverState.el.remove();
      columnsPopoverState.el = null;
    }
    if (columnsPopoverState.outsideHandler) {
      document.removeEventListener('mousedown', columnsPopoverState.outsideHandler, true);
      columnsPopoverState.outsideHandler = null;
    }
    if (columnsPopoverState.keyHandler) {
      document.removeEventListener('keydown', columnsPopoverState.keyHandler);
      columnsPopoverState.keyHandler = null;
    }
    if (columnsPopoverState.scrollHandler) {
      window.removeEventListener('scroll', columnsPopoverState.scrollHandler, true);
      columnsPopoverState.scrollHandler = null;
    }
    if (columnsPopoverState.resizeHandler) {
      window.removeEventListener('resize', columnsPopoverState.resizeHandler);
      columnsPopoverState.resizeHandler = null;
    }
    columnsPopoverState.anchor = null;
  }

  function repositionColumnsPopover() {
    const popover = columnsPopoverState.el;
    const anchor = columnsPopoverState.anchor;
    if (!popover || !anchor) return;
    if (!document.body.contains(anchor)) {
      // Anchor was re-rendered out from under us. Close to avoid
      // leaving an orphaned popover floating on the page.
      closeColumnsPopover();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const popWidth = popover.offsetWidth || 268;
    const GAP = 6;
    let top = rect.bottom + GAP;
    let left = rect.right - popWidth;
    if (left < 8) left = 8;
    if (top + popover.offsetHeight + 8 > window.innerHeight) {
      // Flip above the anchor when there's no room below.
      top = Math.max(8, rect.top - popover.offsetHeight - GAP);
    }
    popover.style.top = top + 'px';
    popover.style.left = left + 'px';
  }

  function renderColumnsPopoverContents(popover) {
    popover.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'fmn-columns-popover-header';
    const title = document.createElement('span');
    title.className = 'fmn-columns-popover-title';
    title.textContent = 'Columns';
    const ctx = document.createElement('span');
    ctx.className = 'fmn-columns-popover-context';
    ctx.textContent = INSTANCES_PATH;
    header.appendChild(title);
    header.appendChild(ctx);
    popover.appendChild(header);

    const list = document.createElement('div');
    list.className = 'fmn-columns-popover-list';
    for (const col of currentNativeColumns) {
      const meta = NATIVE_META_BY_ID.get(col.id);
      if (!meta) continue;
      const row = document.createElement('div');
      row.className = 'fmn-columns-popover-row';
      if (meta.lockedVisible) row.classList.add('is-locked');
      if (col.hidden && !meta.lockedVisible) row.classList.add('is-hidden');

      const name = document.createElement('span');
      name.className = 'fmn-col-name';
      name.textContent = COLUMNS_LABEL_BY_ID[col.id] || meta.matchText || col.id;
      row.appendChild(name);

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'fmn-col-toggle';
      const isVisible = meta.lockedVisible || !col.hidden;
      if (isVisible) toggle.classList.add('is-on');
      toggle.textContent = isVisible ? '\u{1F441}' : '\u{1F441}';
      toggle.title = meta.lockedVisible
        ? 'This column is always visible'
        : isVisible ? 'Hide this column' : 'Show this column';
      if (meta.lockedVisible) {
        toggle.disabled = true;
      } else {
        toggle.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          setNativeColumnHidden(col.id, !col.hidden).catch((err) => {
            console.error('[FMN columns]', 'toggle failed', err);
          });
        });
      }
      row.appendChild(toggle);
      list.appendChild(row);
    }
    popover.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'fmn-columns-popover-footer';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'fmn-columns-popover-reset';
    reset.textContent = 'Reset to default';
    reset.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetNativeColumns().catch((err) => {
        console.error('[FMN columns]', 'reset failed', err);
      });
    });
    footer.appendChild(reset);
    popover.appendChild(footer);
  }

  async function setNativeColumnHidden(colId, hidden) {
    const meta = NATIVE_META_BY_ID.get(colId);
    if (!meta || meta.lockedVisible) return;
    const data = await chrome.storage.local.get(WEBGUI_COLUMNS_KEY);
    const all = (data && data[WEBGUI_COLUMNS_KEY]) || {};
    const list = normalizeNativeColumnOrder(all[NATIVE_AUG_ID]);
    for (const col of list) {
      if (col.id === colId) {
        col.hidden = Boolean(hidden);
        break;
      }
    }
    all[NATIVE_AUG_ID] = list;
    await chrome.storage.local.set({ [WEBGUI_COLUMNS_KEY]: all });
  }

  async function resetNativeColumns() {
    const data = await chrome.storage.local.get(WEBGUI_COLUMNS_KEY);
    const all = (data && data[WEBGUI_COLUMNS_KEY]) || {};
    if (!all[NATIVE_AUG_ID]) return;
    delete all[NATIVE_AUG_ID];
    await chrome.storage.local.set({ [WEBGUI_COLUMNS_KEY]: all });
  }

  // Re-render popover contents whenever the native-columns storage
  // entry changes, so toggling in the popup card is mirrored here.
  function subscribeColumnsPopoverToStorage() {
    if (!chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName && areaName !== 'local') return;
      if (!changes || !changes[WEBGUI_COLUMNS_KEY]) return;
      if (!columnsPopoverState.el) return;
      // Defer one frame so the FMN-123 listener has updated
      // currentNativeColumns first.
      Promise.resolve().then(() => {
        if (columnsPopoverState.el) {
          renderColumnsPopoverContents(columnsPopoverState.el);
        }
      });
    });
  }
  subscribeColumnsPopoverToStorage();

  register({
    id: COLUMNS_MENU_ID,
    mount() {
      if (location.pathname !== INSTANCES_PATH) return;
      const existing = document.querySelector(
        `[${ENTRY_ATTR}="${COLUMNS_MENU_ID}"]`
      );
      if (existing && document.body.contains(existing)) {
        // Button still present; reposition popover if open in case
        // the action bar shifted (FortiMonitor re-render, viewport).
        if (columnsPopoverState.el) repositionColumnsPopover();
        return;
      }
      const actionBar = findInstancesActionBar();
      if (!actionBar) return;
      ensureColumnsMenuStyles();
      const button = buildColumnsButton();
      actionBar.appendChild(button);
    },
  });

  function ensureColumnStyles() {
    if (document.getElementById('fmn-ip-column-styles')) return;
    const style = document.createElement('style');
    style.id = 'fmn-ip-column-styles';
    style.textContent = `
      /* IP/DNS content is rendered as sub-columns inside the existing Instance
         cell (td.instance-column / its matching th). Adding sibling <th>/<td>
         cells crashes DataTables' column-width sync (sWidth TypeError) and
         halts pagination/native sort, so we stay inside the cell DataTables
         already manages. */
      th.fmn-instance-merged, td.instance-column.fmn-instance-merged {
        min-width: 1080px !important;
        padding-right: 12px !important;
        /* FMN-80: TH and TD have different default paddingLeft on
           FortiMonitor (TH ~10px, TD ~8.28px). Different inner widths
           make grid tracks distribute extra space differently between
           header and body, leaving 1-2px sub-cell offsets. Force the
           same paddingLeft so the inner grid widths match. */
        padding-left: 10px !important;
      }
      .fmn-hdr-grid, .fmn-cell-grid {
        display: grid;
        gap: 14px;
        align-items: center;
      }
      .fmn-hdr-grid > * { min-width: 0; }
      .fmn-cell-grid > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .fmn-hdr-grid > [hidden], .fmn-cell-grid > [hidden] { display: none !important; }
      .fmn-cell-ip { font-variant-numeric: tabular-nums; color: #394449; }
      .fmn-cell-dns { color: #394449; }
      .fmn-cell-type { color: #394449; }
      .fmn-cell-model { color: #394449; }
      .fmn-cell-model-number { color: #394449; }
      .fmn-cell-os { color: #394449; }
      .fmn-cell-ip.fmn-unresolved, .fmn-cell-dns.fmn-unresolved,
      .fmn-cell-type.fmn-unresolved,
      .fmn-cell-model.fmn-unresolved, .fmn-cell-model-number.fmn-unresolved,
      .fmn-cell-os.fmn-unresolved {
        color: #9AA4BC; font-style: italic; font-weight: 400;
      }
      .fmn-skel {
        display: inline-block; height: 10px; border-radius: 3px;
        background: linear-gradient(90deg, #EEF1F5 0%, #E4E7EB 50%, #EEF1F5 100%);
        background-size: 200% 100%;
        animation: fmn-skel-pulse 1.1s ease-in-out infinite;
        vertical-align: middle;
      }
      @keyframes fmn-skel-pulse {
        0% { background-position: 100% 0; }
        100% { background-position: 0 0; }
      }
      .fmn-sub-hdr {
        cursor: pointer; user-select: none; position: relative;
        color: #7F899C; font-weight: 500; font-size: 11px;
        text-transform: uppercase; letter-spacing: 0.02em;
        padding: 2px 4px 2px 0; border-radius: 2px;
      }
      .fmn-sub-hdr:hover { color: #394449; }
      .fmn-sub-hdr.fmn-sort-asc, .fmn-sub-hdr.fmn-sort-desc { color: #1f6feb; }
      .fmn-hdr-instance-label { color: inherit; font-weight: inherit; }

      /* Drag affordance + drop indicators on the in-page sub-headers. */
      .fmn-hdr-grid > [${COL_ATTR}] {
        cursor: grab;
        padding: 2px 4px;
        border-radius: 3px;
        transition: background 80ms ease, opacity 80ms ease;
      }
      .fmn-hdr-grid > [${COL_ATTR}]:hover { background: #eef1f5; }
      .fmn-hdr-grid > [${COL_ATTR}]:active { cursor: grabbing; }
      .fmn-hdr-grid > [${COL_ATTR}].fmn-dragging { opacity: 0.4; }
      .fmn-hdr-grid > [${COL_ATTR}].fmn-drop-before { box-shadow: inset 2px 0 0 0 #1f6feb; }
      .fmn-hdr-grid > [${COL_ATTR}].fmn-drop-after  { box-shadow: inset -2px 0 0 0 #1f6feb; }
    `;
    document.head.appendChild(style);
  }

  function augmentTable(table) {
    let headerMutated = false;
    const thead = table.querySelector('thead');
    // FMN-78: DataTables fixed-header layouts duplicate the table - a
    // scroll-head clone (visible thead, empty tbody) sits above a body
    // table (collapsed thead, tbody with rows). Augmenting both theads
    // can leak a duplicate "IP Address / DNS Name" sub-header row during
    // scroll-sync transitions. When the scroll-head wrapper is present,
    // only augment the thead inside it; otherwise (legacy layout / no
    // DataTables fixed header) augment any thead we find.
    const pageHasScrollHead = !!document.querySelector('.dataTables_scrollHeadInner');
    const isScrollHeadTable = !!table.closest('.dataTables_scrollHeadInner');
    const shouldAugmentHeader = !pageHasScrollHead || isScrollHeadTable;
    if (thead && shouldAugmentHeader) {
      const headerRow = thead.querySelector('tr');
      if (headerRow && !headerRow.hasAttribute(HEADER_AUG_ATTR)) {
        const instanceTh = findInstanceCell(Array.from(headerRow.children));
        if (instanceTh) {
          augmentInstanceHeader(instanceTh);
          headerRow.setAttribute(HEADER_AUG_ATTR, '1');
          updateSortIndicators();
          headerMutated = true;
        }
      }
    }

    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    let addedAny = false;
    for (const row of tbody.querySelectorAll('tr')) {
      if (augmentRow(row)) addedAny = true;
    }
    // Only re-apply order when something actually got augmented this pass.
    // Calling appendChild on every slot every pass mutates the DOM and the
    // MutationObserver feedback would loop forever, freezing the page.
    if (headerMutated || addedAny) applyColumnOrderToDom();
    if (addedAny && sortState.column) applySortIfActive();
    return headerMutated || addedAny;
  }

  function findInstanceCell(cells) {
    for (const th of cells) {
      const text = (th.textContent || '').trim();
      if (text === 'Instance' || text.startsWith('Instance')) return th;
    }
    return null;
  }

  function augmentInstanceHeader(th) {
    const originalText = (th.textContent || '').trim() || 'Instance';
    // Move any existing inline children (text, sort-arrow spans) into a
    // wrapper so FortiMonitor's own sort-click continues to hit the same TH
    // when the operator clicks "Instance". The wrapper occupies whichever
    // grid slot is assigned to it; IP and DNS slots stop click propagation
    // so they never trigger native sort.
    th.classList.add('fmn-instance-merged');
    const originalChildren = Array.from(th.childNodes);
    th.textContent = '';

    const grid = document.createElement('div');
    grid.className = 'fmn-hdr-grid';

    // Build all known column slots once. Order/visibility/widths are
    // applied separately by applyColumnOrderToDom() so the same code path
    // handles initial mount and later storage-driven re-renders.
    for (const id of DEFAULT_COL_IDS) {
      let slot;
      if (id === 'instance') {
        slot = document.createElement('span');
        slot.className = 'fmn-hdr-instance-label';
        if (originalChildren.length > 0) {
          for (const c of originalChildren) slot.appendChild(c);
        } else {
          slot.textContent = originalText;
        }
      } else {
        slot = buildSortableSubHeader(COLUMNS[id].label, id);
        // FMN-86: per-sub-header attribution ribbon. Only the toolkit-added
        // sub-headers (ip, dns, type) get a ribbon; the native "Instance"
        // sub-header above is FortiMonitor's own column and stays unbadged.
        // xs variant because sub-headers are ~18-22 px tall in live use.
        attachFeatureBadge(slot, 'xs');
      }
      slot.setAttribute(COL_ATTR, id);
      slot.setAttribute('draggable', 'true');
      attachHeaderDrag(slot);
      grid.appendChild(slot);
    }
    th.appendChild(grid);
  }

  function augmentRow(row) {
    if (row.hasAttribute(ROW_AUG_ATTR)) return false;
    const checkbox = row.querySelector('input.pa-table-row-checkbox');
    if (!checkbox) return false;
    const instanceCell = row.querySelector('td.instance-column');
    if (!instanceCell) return false;
    if (instanceCell.querySelector('.fmn-cell-grid')) {
      row.setAttribute(ROW_AUG_ATTR, '1');
      return false;
    }

    const serverMatch = SERVER_ID_RE.exec(checkbox.value || '');
    const serverId = serverMatch ? serverMatch[1] : null;

    instanceCell.classList.add('fmn-instance-merged');
    const originalChildren = Array.from(instanceCell.childNodes);
    instanceCell.textContent = '';

    const grid = document.createElement('div');
    grid.className = 'fmn-cell-grid';

    const rawValue = (checkbox.value || '').trim();
    const typeLabel = classifyInstancePrefix(rawValue);

    for (const id of DEFAULT_COL_IDS) {
      const slot = document.createElement('span');
      slot.setAttribute(COL_ATTR, id);
      if (id === 'instance') {
        slot.className = 'fmn-cell-name';
        for (const c of originalChildren) slot.appendChild(c);
      } else if (id === 'ip') {
        slot.className = 'fmn-cell-ip';
        if (serverId) slot.setAttribute(IP_CELL_ATTR, serverId);
      } else if (id === 'dns') {
        slot.className = 'fmn-cell-dns';
        if (serverId) slot.setAttribute(DNS_CELL_ATTR, serverId);
      } else if (id === 'type') {
        // Populated synchronously from the checkbox-value prefix;
        // no fetch, no skeleton, no async state.
        slot.className = 'fmn-cell-type';
        if (typeLabel) {
          slot.textContent = typeLabel;
          slot.title = 'Row type derived from checkbox prefix (' + rawValue.split('-')[0] + '-).';
        } else {
          slot.classList.add('fmn-unresolved');
          slot.textContent = 'unknown';
          slot.title = 'Unrecognized row checkbox prefix: ' + rawValue;
        }
      } else if (id === 'model') {
        slot.className = 'fmn-cell-model';
        if (serverId) slot.setAttribute(MODEL_CELL_ATTR, serverId);
      } else if (id === 'modelNumber') {
        slot.className = 'fmn-cell-model-number';
        if (serverId) slot.setAttribute(MODEL_NUMBER_CELL_ATTR, serverId);
      } else if (id === 'os') {
        slot.className = 'fmn-cell-os';
        if (serverId) slot.setAttribute(OS_CELL_ATTR, serverId);
      }
      grid.appendChild(slot);
    }

    instanceCell.appendChild(grid);
    row.setAttribute(ROW_AUG_ATTR, '1');

    if (serverId) {
      const cached = fetchCache.get(serverId);
      renderCell(grid.querySelector('[' + IP_CELL_ATTR + ']'), cached);
      renderCell(grid.querySelector('[' + DNS_CELL_ATTR + ']'), cached);
      renderCell(grid.querySelector('[' + MODEL_CELL_ATTR + ']'), cached);
      renderCell(grid.querySelector('[' + MODEL_NUMBER_CELL_ATTR + ']'), cached);
      renderCell(grid.querySelector('[' + OS_CELL_ATTR + ']'), cached);
      enqueueFetch(serverId);
    } else {
      renderUnavailableCell(grid.querySelector('.fmn-cell-ip'), 'ip');
      renderUnavailableCell(grid.querySelector('.fmn-cell-dns'), 'dns');
      renderUnavailableCell(grid.querySelector('.fmn-cell-model'), 'model');
      renderUnavailableCell(grid.querySelector('.fmn-cell-model-number'), 'modelNumber');
      renderUnavailableCell(grid.querySelector('.fmn-cell-os'), 'os');
    }
    return true;
  }

  // Reorder + show/hide every augmented grid (the header and each row).
  // Slot DOM nodes are kept; only their order, visibility, and the parent
  // grid-template-columns are mutated. This keeps event handlers attached
  // and avoids tearing down DataTables-managed structure.
  function applyColumnOrderToDom() {
    const widths = currentColumns
      .filter((c) => !c.hidden)
      .map((c) => COLUMNS[c.id].width)
      .join(' ');
    for (const grid of document.querySelectorAll('.fmn-hdr-grid, .fmn-cell-grid')) {
      grid.style.gridTemplateColumns = widths;
      for (const col of currentColumns) {
        const slot = grid.querySelector('[' + COL_ATTR + '="' + col.id + '"]');
        if (!slot) continue;
        if (col.hidden) {
          slot.setAttribute('hidden', '');
        } else {
          slot.removeAttribute('hidden');
        }
        // appendChild moves an existing node to the end of children -
        // iterating in desired order yields the desired order.
        grid.appendChild(slot);
      }
    }
    alignHeaderToBody();
  }

  // FMN-81: in DataTables fixed-header layouts the scroll-head TH and body
  // TD live in different scroll containers and have a constant ~10px offset
  // (cell-position delta + paddingLeft mismatch). Measure the actual delta
  // between the header grid and body's first-row grid, apply translateX to
  // the header grid so they line up.
  //
  // Timing matters: DataTables's own scroll handler programmatically syncs
  // scroll-head's scrollLeft to body's scrollLeft, but it may run AFTER our
  // listener (or async). If we measure mid-scroll-sync we see the body in
  // its post-scroll position but the header still in its pre-sync position
  // and compute a huge wrong offset. Defer the measurement to setTimeout(0)
  // so it runs after the macrotask queue drains - past DataTables sync,
  // past any rAF-based work. De-bounce so rapid scroll events collapse to
  // one alignment.
  let alignTimeoutId = null;
  let alignScrollHooked = false;
  function alignHeaderToBody() {
    if (alignTimeoutId !== null) clearTimeout(alignTimeoutId);
    alignTimeoutId = setTimeout(() => {
      alignTimeoutId = null;
      const headerGrid = document.querySelector(
        '.dataTables_scrollHead th.fmn-instance-merged .fmn-hdr-grid'
      );
      const firstRowCellGrid = document.querySelector(
        '.dataTables_scrollBody tbody tr td.instance-column.fmn-instance-merged .fmn-cell-grid'
      );
      if (!headerGrid || !firstRowCellGrid) return;
      headerGrid.style.transform = '';
      const headerLeft = headerGrid.getBoundingClientRect().left;
      const bodyLeft = firstRowCellGrid.getBoundingClientRect().left;
      const offset = bodyLeft - headerLeft;
      if (Math.abs(offset) > 0.5) {
        headerGrid.style.transform = 'translateX(' + offset + 'px)';
      }
    }, 0);

    if (!alignScrollHooked) {
      const scrollBody = document.querySelector('.dataTables_scrollBody');
      if (scrollBody) {
        scrollBody.addEventListener('scroll', alignHeaderToBody, { passive: true });
        alignScrollHooked = true;
      }
      window.addEventListener('resize', alignHeaderToBody, { passive: true });
    }
  }

  function renderUnavailableCell(cell, kind) {
    if (!cell) return;
    cell.classList.add('fmn-unresolved');
    if (kind === 'ip' || kind === 'dns') {
      cell.textContent = 'not captured';
      cell.title = kind === 'ip'
        ? 'IP address not captured for this row type'
        : 'DNS name not captured for this row type';
      return;
    }
    // FMN-76: model / modelNumber / os render n/a for non-server rows since
    // those fields are not exposed for OnSight (a-) or other (cs-) entities.
    cell.textContent = 'n/a';
    cell.title = kind === 'model'
      ? 'Model not available for this row type'
      : kind === 'modelNumber'
        ? 'Model number not available for this row type'
        : 'OS not available for this row type';
  }

  function buildSortableSubHeader(label, col) {
    const span = document.createElement('span');
    span.className = 'fmn-sub-hdr fmn-' + col + '-hdr';
    span.setAttribute('data-fmn-sort-col', col);
    span.setAttribute('title', 'Sort (client-side; within currently rendered rows)');
    span.textContent = label;
    span.addEventListener('click', (e) => {
      // Suppress click as sort if we just finished a drag - HTML5 DnD fires
      // a synthetic click on the source element after dragend on some
      // browsers, and we don't want to flip the IP/DNS sort as a side
      // effect of dropping a column.
      if (span.__fmnJustDragged) {
        span.__fmnJustDragged = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Stop propagation so the Instance TH's own FortiMonitor sort doesn't
      // fire when the operator is sorting by IP or DNS.
      e.preventDefault();
      e.stopPropagation();
      onSortClick(col);
    });
    return span;
  }

  // Drag-and-drop on the in-page sub-headers. stopPropagation everywhere so
  // FortiMonitor's native Instance-column sort handler on the TH never sees
  // these events; otherwise dragging would flip native sort.
  function attachHeaderDrag(slot) {
    slot.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      slot.classList.add('fmn-dragging');
      slot.__fmnJustDragged = true;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', slot.getAttribute(COL_ATTR));
    });
    slot.addEventListener('dragend', (e) => {
      e.stopPropagation();
      slot.classList.remove('fmn-dragging');
      for (const s of document.querySelectorAll('.fmn-drop-before, .fmn-drop-after')) {
        s.classList.remove('fmn-drop-before', 'fmn-drop-after');
      }
    });
    slot.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const rect = slot.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      slot.classList.toggle('fmn-drop-before', before);
      slot.classList.toggle('fmn-drop-after', !before);
    });
    slot.addEventListener('dragleave', (e) => {
      e.stopPropagation();
      slot.classList.remove('fmn-drop-before', 'fmn-drop-after');
    });
    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const fromId = e.dataTransfer.getData('text/plain');
      const targetId = slot.getAttribute(COL_ATTR);
      const rect = slot.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      slot.classList.remove('fmn-drop-before', 'fmn-drop-after');
      if (!fromId || fromId === targetId) return;

      const next = currentColumns.slice();
      const fromIdx = next.findIndex((c) => c.id === fromId);
      if (fromIdx < 0) return;
      const [item] = next.splice(fromIdx, 1);
      let toIdx = next.findIndex((c) => c.id === targetId);
      if (toIdx < 0) toIdx = next.length;
      if (!before) toIdx += 1;
      next.splice(toIdx, 0, item);

      currentColumns = next;
      applyColumnOrderToDom();
      // Persist - the storage subscription will broadcast to the popup; the
      // local DOM is already updated so we don't wait on the round-trip.
      persistColumnOrder(currentColumns).catch((err) => {
        console.error('[FMN augment] persist column order failed', err);
      });
    });
  }

  function onSortClick(col) {
    if (sortState.column !== col) {
      sortState.column = col;
      sortState.direction = 'asc';
    } else if (sortState.direction === 'asc') {
      sortState.direction = 'desc';
    } else {
      sortState.column = null;
      sortState.direction = null;
    }
    updateSortIndicators();
    applySortIfActive();
  }

  function updateSortIndicators() {
    for (const el of document.querySelectorAll('.fmn-sub-hdr')) {
      el.classList.remove('fmn-sort-asc', 'fmn-sort-desc');
      const col = el.getAttribute('data-fmn-sort-col');
      if (col === sortState.column && sortState.direction) {
        el.classList.add('fmn-sort-' + sortState.direction);
      }
    }
  }

  function applySortIfActive() {
    if (!sortState.column || !sortState.direction) return;
    for (const tbody of document.querySelectorAll('table.pa-table_outage tbody')) {
      const rows = Array.from(tbody.querySelectorAll('tr[' + ROW_AUG_ATTR + ']'));
      if (rows.length < 2) continue;
      rows.sort((a, b) => compareRows(a, b, sortState.column, sortState.direction));
      for (const r of rows) tbody.appendChild(r);
    }
  }

  function compareRows(a, b, col, direction) {
    const va = rowValue(a, col);
    const vb = rowValue(b, col);
    const aEmpty = va === null;
    const bEmpty = vb === null;
    if (aEmpty && !bEmpty) return 1;
    if (!aEmpty && bEmpty) return -1;
    if (aEmpty && bEmpty) return 0;
    let cmp;
    if (col === 'ip') cmp = compareIps(va, vb);
    else cmp = va.toLowerCase().localeCompare(vb.toLowerCase());
    return direction === 'asc' ? cmp : -cmp;
  }

  function rowValue(row, col) {
    const cb = row.querySelector('input.pa-table-row-checkbox');
    if (!cb) return null;
    if (col === 'type') {
      // Synchronous: derived from the checkbox value prefix, no cache dependency.
      return classifyInstancePrefix(cb.value);
    }
    const m = SERVER_ID_RE.exec(cb.value || '');
    if (!m) return null;
    const cached = fetchCache.get(m[1]);
    if (!cached || cached.state !== 'resolved') return null;
    return cached[col] || null;
  }

  function compareIps(a, b) {
    const aV4 = IPV4_RE.test(a);
    const bV4 = IPV4_RE.test(b);
    if (aV4 && bV4) {
      const ao = a.split('.').map(Number);
      const bo = b.split('.').map(Number);
      for (let i = 0; i < 4; i++) {
        if (ao[i] !== bo[i]) return ao[i] - bo[i];
      }
      return 0;
    }
    if (aV4 && !bV4) return -1;
    if (!aV4 && bV4) return 1;
    return a.localeCompare(b);
  }

  function classifyFqdn(fqdn) {
    if (typeof fqdn !== 'string') return { ip: null, dns: null };
    const v = fqdn.trim();
    if (!v) return { ip: null, dns: null };
    if (IPV4_RE.test(v)) return { ip: v, dns: null };
    if (v.includes(':') && IPV6_HINT_RE.test(v)) return { ip: v, dns: null };
    return { ip: null, dns: v };
  }

  function enqueueFetch(serverId) {
    if (fetchCache.has(serverId)) return;
    fetchCache.set(serverId, { state: 'loading' });
    fetchQueue.push(serverId);
    pumpQueue();
  }

  function pumpQueue() {
    while (activeFetches < FETCH_CONCURRENCY && fetchQueue.length > 0) {
      const id = fetchQueue.shift();
      activeFetches++;
      fetchServerInstance(id)
        .then((result) => {
          fetchCache.set(id, result);
          paintCellsForServer(id);
          if (sortState.column) applySortIfActive();
        })
        .catch(() => {
          fetchCache.set(id, { state: 'failed' });
          paintCellsForServer(id);
        })
        .finally(() => {
          activeFetches--;
          pumpQueue();
        });
    }
  }

  async function fetchServerInstance(serverId) {
    const res = await fetch('/report/get_idp_data?server_id=' + encodeURIComponent(serverId), {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    const ct = res.headers.get('Content-Type') || '';
    if (!ct.includes('json')) return { state: 'failed' };
    let body;
    try { body = await res.json(); } catch { return { state: 'failed' }; }
    const inst = body && body.pageData && body.pageData.instance;
    const { ip, dns } = classifyFqdn(inst && inst.fqdn);
    // FMN-76: Model / Model # / OS pulled from fabricSystemData. Populated only
    // on Fortinet/fabric devices; non-fabric rows resolve as null and render
    // 'n/a' per the ticket's accepted empty state. pageData.instance.deviceModel
    // and pageData.instance.operatingSystem are unreliable on this endpoint
    // (placeholder + stale; verified in live capture 2026-04-26) and not used.
    const fsd = inst && inst.fabricSystemData;
    const model = (fsd && typeof fsd.model_name === 'string' && fsd.model_name) || null;
    const modelNumber = (fsd && typeof fsd.model_number === 'string' && fsd.model_number) || null;
    const os = (fsd && typeof fsd.os_version === 'string' && fsd.os_version) || null;
    return { state: 'resolved', ip, dns, model, modelNumber, os };
  }

  function paintCellsForServer(serverId) {
    const cached = fetchCache.get(serverId);
    const sel = [IP_CELL_ATTR, DNS_CELL_ATTR, MODEL_CELL_ATTR, MODEL_NUMBER_CELL_ATTR, OS_CELL_ATTR]
      .map((a) => '[' + a + '="' + serverId + '"]')
      .join(', ');
    for (const cell of document.querySelectorAll(sel)) {
      renderCell(cell, cached);
    }
  }

  // Per-kind metadata for renderCell: which cache field to read, the skeleton
  // width, and the empty-state copy. Order matters only for cellKind() lookup.
  // emptyText differs by kind: FMN-71's ip/dns columns render "not captured"
  // when the FQDN is missing; FMN-76's model/modelNumber/os render "n/a"
  // because the underlying fields are populated only on Fortinet/fabric rows
  // by design - "not captured" would imply a capture failure that didn't occur.
  const CELL_KINDS = [
    { attr: IP_CELL_ATTR,           field: 'ip',          skelWidth: '90px',  emptyText: 'not captured', emptyTitle: 'No IP address captured for this instance',     failTitle: 'Unable to resolve address for this instance' },
    { attr: DNS_CELL_ATTR,          field: 'dns',         skelWidth: '140px', emptyText: 'not captured', emptyTitle: 'No DNS name captured for this instance',       failTitle: 'Unable to resolve address for this instance' },
    { attr: MODEL_CELL_ATTR,        field: 'model',       skelWidth: '110px', emptyText: 'n/a',          emptyTitle: 'No model reported for this instance',          failTitle: 'Unable to resolve model for this instance' },
    { attr: MODEL_NUMBER_CELL_ATTR, field: 'modelNumber', skelWidth: '100px', emptyText: 'n/a',          emptyTitle: 'No model number reported for this instance',  failTitle: 'Unable to resolve model number for this instance' },
    { attr: OS_CELL_ATTR,           field: 'os',          skelWidth: '120px', emptyText: 'n/a',          emptyTitle: 'No OS reported for this instance',             failTitle: 'Unable to resolve OS for this instance' },
  ];

  function cellKind(cell) {
    for (const k of CELL_KINDS) {
      if (cell.hasAttribute(k.attr)) return k;
    }
    return null;
  }

  function renderCell(cell, cached) {
    if (!cell) return;
    const kind = cellKind(cell);
    if (!kind) return;
    cell.textContent = '';
    cell.classList.remove('fmn-unresolved');
    cell.removeAttribute('title');
    if (!cached || cached.state === 'loading') {
      const skel = document.createElement('span');
      skel.className = 'fmn-skel';
      skel.style.width = kind.skelWidth;
      cell.appendChild(skel);
      return;
    }
    const value = cached[kind.field];
    if (value) {
      cell.textContent = value;
      cell.title = value;
      return;
    }
    cell.classList.add('fmn-unresolved');
    cell.textContent = kind.emptyText;
    cell.title = cached.state === 'failed' ? kind.failTitle : kind.emptyTitle;
  }

  function buildLauncherEntry() {
    const li = document.createElement('li');
    li.setAttribute(ENTRY_ATTR, LAUNCHER_ID);
    li.className = 'pa-side-nav__top-level-item pa-py-8';
    li.title = 'Open the Unofficial FortiMonitor Toolkit';
    Object.assign(li.style, {
      background: '#1f6feb',
      color: '#fff',
      fontWeight: '600',
      margin: '6px 10px',
      padding: '9px 14px',
      borderRadius: '5px',
      border: '1px solid #1a5fcf',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      cursor: 'pointer',
      listStyle: 'none',
      fontSize: '14px',
      lineHeight: '1',
      transition: 'background 120ms ease',
      userSelect: 'none',
    });
    li.addEventListener('mouseenter', () => {
      li.style.background = '#1a5fcf';
    });
    li.addEventListener('mouseleave', () => {
      li.style.background = '#1f6feb';
    });
    li.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (overlayState.el) {
        hideOverlay();
      } else {
        showOverlay(li);
      }
    });

    li.appendChild(buildGridIcon());
    const label = document.createElement('span');
    label.textContent = 'FM Toolkit';
    label.style.flex = '1';
    li.appendChild(label);
    return li;
  }

  function showOverlay(anchor) {
    if (overlayState.el) return;

    const anchorRect = anchor.getBoundingClientRect();
    const MARGIN = 8;
    const height = 540;
    const anchorMidY = (anchorRect.top + anchorRect.bottom) / 2;
    const top = anchorMidY - height / 2;

    const wrap = document.createElement('div');
    wrap.id = OVERLAY_ID;
    Object.assign(wrap.style, {
      position: 'fixed',
      left: (anchorRect.right + MARGIN) + 'px',
      top: top + 'px',
      width: '360px',
      height: height + 'px',
      background: '#fff',
      border: '1px solid #c5cbd3',
      borderRadius: '8px',
      boxShadow: '0 8px 28px rgba(0, 0, 0, 0.22)',
      overflow: 'hidden',
      zIndex: '2147483647',
      display: 'flex',
      flexDirection: 'column',
    });

    const iframe = document.createElement('iframe');
    iframe.src = POPUP_URL;
    iframe.setAttribute('title', 'Unofficial FortiMonitor Toolkit');
    Object.assign(iframe.style, {
      width: '100%',
      height: '100%',
      border: 'none',
      background: '#fff',
      display: 'block',
    });
    wrap.appendChild(iframe);

    document.body.appendChild(wrap);
    overlayState.el = wrap;

    const outsideHandler = (e) => {
      const target = e.target;
      if (wrap.contains(target) || anchor.contains(target) || target === anchor) return;
      hideOverlay();
    };
    document.addEventListener('mousedown', outsideHandler, true);
    overlayState.outsideHandler = outsideHandler;

    const keyHandler = (e) => {
      if (e.key === 'Escape') hideOverlay();
    };
    document.addEventListener('keydown', keyHandler);
    overlayState.keyHandler = keyHandler;
  }

  function hideOverlay() {
    if (overlayState.el) {
      overlayState.el.remove();
      overlayState.el = null;
    }
    if (overlayState.outsideHandler) {
      document.removeEventListener('mousedown', overlayState.outsideHandler, true);
      overlayState.outsideHandler = null;
    }
    if (overlayState.keyHandler) {
      document.removeEventListener('keydown', overlayState.keyHandler);
      overlayState.keyHandler = null;
    }
  }

  function buildGridIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.style.flexShrink = '0';
    for (const [x, y] of [[3, 3], [14, 3], [3, 14], [14, 14]]) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', '7');
      rect.setAttribute('height', '7');
      rect.setAttribute('rx', '1');
      svg.appendChild(rect);
    }
    return svg;
  }

  async function loadSidebarLauncherFlag() {
    try {
      const data = await chrome.storage.local.get(SIDEBAR_LAUNCHER_KEY);
      sidebarLauncherEnabled = Boolean(data && data[SIDEBAR_LAUNCHER_KEY]);
    } catch {
      sidebarLauncherEnabled = false;
    }
  }

  async function loadShowFeatureBadgesFlag() {
    try {
      const data = await chrome.storage.local.get(SHOW_FEATURE_BADGES_KEY);
      const value = data && data[SHOW_FEATURE_BADGES_KEY];
      // Undefined → default true; explicit false from operator → false.
      showFeatureBadgesEnabled = value === undefined ? true : Boolean(value);
    } catch {
      showFeatureBadgesEnabled = true;
    }
  }

  // FMN-86: per-feature "FM Toolkit" attribution ribbon. Operator-confirmed
  // design from docs/mockups/fortimonitor-fm-toolkit-ribbons.html — geometry
  // numbers below were dialed in by the operator via the mockup's live
  // tuner and must not drift without a new round of approval.
  //
  // Three variants:
  //   default — for net-new visible UI elements with their own DOM
  //             (currently no shipping surface; reserved for future use)
  //   --sm    — for ~40 px-or-larger hosts that aren't part of a
  //             DataTables sub-header structure (no shipping surface today)
  //   --xs    — for cramped table sub-headers (~18-22 px tall). Currently
  //             attached to each toolkit-added sub-header on the merged
  //             Instance cell on /report/ListServers (FMN-71/75): IP
  //             Address, DNS Name, Type. The native "Instance" sub-header
  //             stays unbadged.
  //
  // The host attribute adds position:relative + overflow:hidden so the
  // rotated strip clips at the host's bounding box rather than spilling
  // onto adjacent FortiMonitor UI.
  function ensureFeatureBadgeStyles() {
    if (document.getElementById(FEATURE_BADGE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = FEATURE_BADGE_STYLE_ID;
    style.textContent = `
      [${FEATURE_BADGE_HOST_ATTR}] {
        position: relative !important;
        overflow: hidden !important;
      }
      .fmn-feature-badge {
        position: absolute;
        top: 0;
        right: 0;
        width: 60px;
        height: 60px;
        pointer-events: none;
        overflow: hidden;
        z-index: 50;
      }
      .fmn-feature-badge::before {
        content: "FM Toolkit";
        position: absolute;
        display: block;
        width: 90px;
        padding: 2px 0;
        top: 10.5px;
        right: -25px;
        background: #1f6feb;
        color: #fff;
        font-size: 7.5px;
        font-weight: 600;
        letter-spacing: 0.03em;
        text-align: center;
        text-indent: 5.5px;
        text-transform: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22);
        transform: rotate(45deg);
        transform-origin: center;
      }
      .fmn-feature-badge--sm {
        width: 40px;
        height: 40px;
      }
      .fmn-feature-badge--sm::before {
        width: 60px;
        padding: 1px 0;
        top: 7px;
        right: -16.5px;
        text-indent: 3.5px;
        font-size: 6px;
        letter-spacing: 0.02em;
        box-shadow: 0 1px 1px rgba(0, 0, 0, 0.22);
      }
      .fmn-feature-badge--xs {
        width: 28px;
        height: 28px;
      }
      .fmn-feature-badge--xs::before {
        /* Operator-confirmed: at xs scale, "FM Toolkit" doesn't read; the
           abbreviation "FM TK" is used instead. Default and compact
           variants keep the full text. */
        content: "FM TK";
        width: 42px;
        padding: 0;
        top: 5px;
        right: -10px;
        text-indent: 2.5px;
        font-size: 5.5px;
        letter-spacing: 0.01em;
        box-shadow: 0 1px 1px rgba(0, 0, 0, 0.22);
      }
    `;
    document.head.appendChild(style);
  }

  // Idempotent: bails when the badge already exists on the host. Bails
  // when the operator has toggled badges off (read once at start; takes
  // effect on next page load, per the operator-confirmed spec).
  function attachFeatureBadge(host, variant) {
    if (!showFeatureBadgesEnabled) return;
    if (!host) return;
    if (host.querySelector(':scope > .fmn-feature-badge')) return;
    ensureFeatureBadgeStyles();
    let variantClass = '';
    let variantAttr = 'default';
    if (variant === 'sm') { variantClass = ' fmn-feature-badge--sm'; variantAttr = 'sm'; }
    else if (variant === 'xs') { variantClass = ' fmn-feature-badge--xs'; variantAttr = 'xs'; }
    host.setAttribute(FEATURE_BADGE_HOST_ATTR, variantAttr);
    const badge = document.createElement('span');
    badge.className = 'fmn-feature-badge' + variantClass;
    badge.setAttribute('aria-hidden', 'true');
    badge.title = 'Added by the Unofficial FortiMonitor Toolkit. Toggle off in popup → Settings to hide these badges.';
    host.appendChild(badge);
  }

  function subscribeSidebarLauncherFlag() {
    if (!chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName && areaName !== 'local') return;
      const change = changes && changes[SIDEBAR_LAUNCHER_KEY];
      if (!change) return;
      const next = Boolean(change.newValue);
      if (next === sidebarLauncherEnabled) return;
      sidebarLauncherEnabled = next;
      ensureAll();
    });
  }

  // FMN-152: in-page omni-search across every searchable server field.
  // Replaces FortiMonitor's "Search Instances" input in the top bar
  // with a search that matches across name, fqdn, IPs, description,
  // tags, attributes (incl. Model + OS), device type, agent version,
  // group, template. Off by default; operator opts in via popup
  // Settings -> "Replace FortiMonitor's Search Instances with FM TK
  // Search". When on, the native input is hidden; when off, our DOM
  // is removed and the native input is restored.
  const OMNI_AUG_ID = 'omni-search';
  const OMNI_CONTAINER_ID = 'fmn-omni-search-container';
  const OMNI_INPUT_ID = 'fmn-omni-search-input';
  const OMNI_DROPDOWN_ID = 'fmn-omni-search-dropdown';
  const OMNI_STYLE_ID = 'fmn-omni-search-styles';
  const OMNI_FM_SEARCH_SELECTOR = 'input[placeholder="Search Instances"]';
  const OMNI_DEBOUNCE_MS = 180;
  const OMNI_SEARCH_KEY = 'fm:omniSearchEnabled';
  const OMNI_NATIVE_HIDDEN_ATTR = 'data-fmn-omni-search-hidden';

  let omniSearchEnabled = false;
  let omniSearchFlagLoaded = false;

  const omniState = {
    debounceTimer: null,
    activeIndex: -1,
    lastResults: [],
    lastQuery: '',
    isOpen: false,
  };

  function ensureOmniStyles() {
    if (document.getElementById(OMNI_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = OMNI_STYLE_ID;
    style.textContent = `
      #${OMNI_CONTAINER_ID} {
        position: relative; display: inline-flex; align-items: center;
        margin-right: 8px; vertical-align: middle;
      }
      #${OMNI_CONTAINER_ID} .fmn-omni-chip {
        font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em;
        color: #ffffff; background: #3954BF; padding: 2px 5px;
        border-radius: 3px; margin-right: 6px; text-transform: uppercase;
        flex: 0 0 auto;
      }
      #${OMNI_INPUT_ID} {
        height: 32px; width: 220px; padding: 0 10px;
        border: 1px solid #D6D9DD; border-radius: 4px; background: #fff;
        font: inherit; font-size: 13px; color: #394449;
        outline: none;
      }
      #${OMNI_INPUT_ID}:focus {
        border-color: #3954BF; box-shadow: 0 0 0 2px rgba(57,84,191,0.12);
      }
      #${OMNI_DROPDOWN_ID} {
        position: absolute; top: 100%; left: 0;
        min-width: 380px; max-width: 480px; margin-top: 4px;
        background: #ffffff; border: 1px solid #D6D9DD; border-radius: 6px;
        box-shadow: 0 8px 24px rgba(15,23,42,0.12);
        z-index: 100000; max-height: 460px; overflow-y: auto;
        display: none;
      }
      #${OMNI_DROPDOWN_ID}.is-open { display: block; }
      .fmn-omni-row {
        display: grid; grid-template-columns: 1fr auto;
        align-items: center; gap: 10px;
        padding: 8px 12px; border-bottom: 1px solid #E4E7EB;
        cursor: pointer; font-size: 12.5px;
      }
      .fmn-omni-row:last-child { border-bottom: none; }
      .fmn-omni-row:hover, .fmn-omni-row.is-active {
        background: #F4F6FB;
      }
      .fmn-omni-row-name {
        font-weight: 600; color: #394449;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .fmn-omni-row-snippet {
        color: #6B7280; font-size: 11px; margin-top: 2px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .fmn-omni-badge {
        font-size: 10px; font-weight: 600; text-transform: uppercase;
        color: #3954BF; background: #E8ECF8; padding: 2px 6px;
        border-radius: 3px; letter-spacing: 0.04em;
      }
      .fmn-omni-empty, .fmn-omni-error, .fmn-omni-loading {
        padding: 10px 12px; color: #6B7280; font-size: 12px;
      }
      .fmn-omni-error { color: #B91C1C; }
      .fmn-omni-footer {
        display: flex; justify-content: space-between; align-items: center;
        padding: 6px 12px; background: #FAFBFC; border-top: 1px solid #E4E7EB;
        font-size: 10.5px; color: #6B7280;
      }
      .fmn-omni-refresh {
        background: transparent; border: none; color: #3954BF;
        font: inherit; font-size: 10.5px; cursor: pointer; padding: 0;
      }
      .fmn-omni-refresh:hover { text-decoration: underline; }
    `;
    document.head.appendChild(style);
  }

  function omniRequest(type, payload = {}) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response || !response.ok) {
            reject(new Error(response?.error ?? 'omni-search request failed'));
            return;
          }
          resolve(response.result);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function omniDetailPath(serverId) {
    if (serverId == null) return null;
    return `/report/Instance/${serverId}/details`;
  }

  function omniSnippetForRow(row) {
    const field = row.matched_field;
    if (field === 'name') return '';
    if (field === 'fqdn') return row.fqdn;
    if (field === 'ip') return (row.additional_fqdns || []).join(', ');
    if (field === 'description') return row.description;
    if (field === 'tag') return (row.tags || []).join(', ');
    if (field === 'attribute') {
      const a = (row.attributes || [])[0];
      return a ? `${a.name}: ${a.value}` : '';
    }
    if (field === 'device_type') return row.device_type || row.device_sub_type;
    if (field === 'agent_version') return row.agent_version;
    if (field === 'group') return row.group_name;
    if (field === 'template') return (row.template_names || []).join(', ');
    if (field === 'status') return row.status;
    return '';
  }

  function omniRenderResults(results, query) {
    const dropdown = document.getElementById(OMNI_DROPDOWN_ID);
    if (!dropdown) return;
    dropdown.innerHTML = '';
    omniState.lastResults = results.matches || [];
    omniState.lastQuery = query;
    omniState.activeIndex = -1;
    if (!results.matches || results.matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'fmn-omni-empty';
      empty.textContent = `No matches for "${query}".`;
      dropdown.appendChild(empty);
    } else {
      for (let i = 0; i < results.matches.length; i++) {
        const r = results.matches[i];
        const row = document.createElement('div');
        row.className = 'fmn-omni-row';
        row.setAttribute('data-index', String(i));
        const text = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'fmn-omni-row-name';
        name.textContent = r.name || `Server ${r.id}`;
        text.appendChild(name);
        const snippet = omniSnippetForRow(r);
        if (snippet) {
          const sn = document.createElement('div');
          sn.className = 'fmn-omni-row-snippet';
          sn.textContent = snippet;
          text.appendChild(sn);
        }
        const badge = document.createElement('span');
        badge.className = 'fmn-omni-badge';
        badge.textContent = r.matched_field || 'match';
        row.appendChild(text);
        row.appendChild(badge);
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          omniNavigateTo(r);
        });
        dropdown.appendChild(row);
      }
    }
    // Footer with refresh
    const footer = document.createElement('div');
    footer.className = 'fmn-omni-footer';
    const left = document.createElement('span');
    left.textContent = `${results.matches?.length ?? 0} matches`;
    footer.appendChild(left);
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'fmn-omni-refresh';
    refresh.textContent = 'Refresh cache';
    refresh.addEventListener('mousedown', async (e) => {
      e.preventDefault();
      await omniRefreshCache();
      omniRunSearch(query);
    });
    footer.appendChild(refresh);
    dropdown.appendChild(footer);
  }

  function omniRenderState(label, kind = 'loading') {
    const dropdown = document.getElementById(OMNI_DROPDOWN_ID);
    if (!dropdown) return;
    dropdown.innerHTML = '';
    const el = document.createElement('div');
    el.className = kind === 'error' ? 'fmn-omni-error' : 'fmn-omni-loading';
    el.textContent = label;
    dropdown.appendChild(el);
  }

  function omniOpen() {
    const dropdown = document.getElementById(OMNI_DROPDOWN_ID);
    if (!dropdown) return;
    dropdown.classList.add('is-open');
    omniState.isOpen = true;
  }

  function omniClose() {
    const dropdown = document.getElementById(OMNI_DROPDOWN_ID);
    if (!dropdown) return;
    dropdown.classList.remove('is-open');
    omniState.isOpen = false;
    omniState.activeIndex = -1;
  }

  function omniNavigateTo(row) {
    const path = omniDetailPath(row.id);
    if (!path) return;
    omniClose();
    const input = document.getElementById(OMNI_INPUT_ID);
    if (input) input.value = '';
    window.location.href = path;
  }

  async function omniRunSearch(query) {
    if (!query || !query.trim()) {
      omniClose();
      return;
    }
    omniRenderState('Searching...');
    omniOpen();
    try {
      const result = await omniRequest('omni-search:query', { query, max: 25 });
      omniRenderResults(result, query);
    } catch (e) {
      omniRenderState(e.message || 'Search failed', 'error');
    }
  }

  async function omniRefreshCache() {
    omniRenderState('Refreshing cache...');
    try {
      await omniRequest('omni-search:refresh', {});
    } catch (e) {
      omniRenderState(e.message || 'Refresh failed', 'error');
    }
  }

  function omniHighlightActive() {
    const dropdown = document.getElementById(OMNI_DROPDOWN_ID);
    if (!dropdown) return;
    const rows = dropdown.querySelectorAll('.fmn-omni-row');
    rows.forEach((r, i) => r.classList.toggle('is-active', i === omniState.activeIndex));
    if (omniState.activeIndex >= 0 && rows[omniState.activeIndex]) {
      rows[omniState.activeIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  function buildOmniContainer() {
    const container = document.createElement('div');
    container.id = OMNI_CONTAINER_ID;
    const chip = document.createElement('span');
    chip.className = 'fmn-omni-chip';
    chip.textContent = 'FM TK';
    const input = document.createElement('input');
    input.id = OMNI_INPUT_ID;
    input.type = 'search';
    input.placeholder = 'Search all fields';
    input.autocomplete = 'off';
    const dropdown = document.createElement('div');
    dropdown.id = OMNI_DROPDOWN_ID;

    input.addEventListener('input', (e) => {
      const q = e.target.value;
      if (omniState.debounceTimer) clearTimeout(omniState.debounceTimer);
      omniState.debounceTimer = setTimeout(() => omniRunSearch(q), OMNI_DEBOUNCE_MS);
    });
    input.addEventListener('focus', () => {
      if (omniState.lastResults.length > 0 && input.value) omniOpen();
    });
    input.addEventListener('keydown', (e) => {
      if (!omniState.isOpen) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        omniState.activeIndex = Math.min(
          omniState.activeIndex + 1,
          (omniState.lastResults?.length ?? 0) - 1
        );
        omniHighlightActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        omniState.activeIndex = Math.max(omniState.activeIndex - 1, -1);
        omniHighlightActive();
      } else if (e.key === 'Enter') {
        const row = omniState.lastResults[omniState.activeIndex];
        if (row) omniNavigateTo(row);
      } else if (e.key === 'Escape') {
        omniClose();
        input.blur();
      }
    });
    document.addEventListener('mousedown', (e) => {
      if (!container.contains(e.target)) omniClose();
    }, { capture: true });

    container.appendChild(chip);
    container.appendChild(input);
    container.appendChild(dropdown);
    return container;
  }

  function ensureNativeHiddenStyle() {
    const id = 'fmn-omni-search-native-hidden';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    // Use display:none on the search-form ancestor so the slot is fully
    // collapsed when our search is enabled. Scoped to the attribute so
    // nothing else inherits.
    style.textContent = `
      .search-form[${OMNI_NATIVE_HIDDEN_ATTR}] { display: none !important; }
    `;
    document.head.appendChild(style);
  }

  function hideNativeFortiMonitorSearch() {
    const fmInput = document.querySelector(OMNI_FM_SEARCH_SELECTOR);
    if (!fmInput) return null;
    const fmWrapper = fmInput.closest('.search-form');
    if (!fmWrapper) return null;
    fmWrapper.setAttribute(OMNI_NATIVE_HIDDEN_ATTR, '1');
    return fmWrapper;
  }

  function restoreNativeFortiMonitorSearch() {
    const hidden = document.querySelectorAll(`.search-form[${OMNI_NATIVE_HIDDEN_ATTR}]`);
    for (const el of hidden) el.removeAttribute(OMNI_NATIVE_HIDDEN_ATTR);
  }

  function teardownOmniSearch() {
    const c = document.getElementById(OMNI_CONTAINER_ID);
    if (c) c.remove();
    restoreNativeFortiMonitorSearch();
    if (omniState.debounceTimer) { clearTimeout(omniState.debounceTimer); omniState.debounceTimer = null; }
    omniState.lastResults = [];
    omniState.lastQuery = '';
    omniState.isOpen = false;
    omniState.activeIndex = -1;
  }

  async function loadOmniSearchFlag() {
    try {
      const data = await chrome.storage.local.get(OMNI_SEARCH_KEY);
      omniSearchEnabled = Boolean(data && data[OMNI_SEARCH_KEY]);
    } catch {
      omniSearchEnabled = false;
    }
    omniSearchFlagLoaded = true;
  }

  function subscribeOmniSearchFlag() {
    if (!chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName && areaName !== 'local') return;
      const change = changes && changes[OMNI_SEARCH_KEY];
      if (!change) return;
      const next = Boolean(change.newValue);
      if (next === omniSearchEnabled) return;
      omniSearchEnabled = next;
      if (!next) teardownOmniSearch();
      ensureAll();
    });
  }

  register({
    id: OMNI_AUG_ID,
    mount() {
      if (!omniSearchFlagLoaded) return;
      if (!omniSearchEnabled) {
        // Toggle was flipped off mid-session: ensure no leftover DOM.
        if (document.getElementById(OMNI_CONTAINER_ID)) teardownOmniSearch();
        return;
      }
      // Find FortiMonitor's "Search Instances" input. If it's not in the
      // DOM yet (SPA still hydrating), bail and the next mutation tick
      // will retry.
      const fmInput = document.querySelector(OMNI_FM_SEARCH_SELECTOR);
      if (!fmInput) return;
      const fmWrapper = fmInput.closest('.search-form') || fmInput.parentElement;
      if (!fmWrapper || !fmWrapper.parentElement) return;
      ensureOmniStyles();
      ensureNativeHiddenStyle();
      // Already injected? Make sure the native input is still hidden in
      // case FortiMonitor re-rendered the top bar and stripped our attr.
      if (document.getElementById(OMNI_CONTAINER_ID)) {
        hideNativeFortiMonitorSearch();
        return;
      }
      const container = buildOmniContainer();
      fmWrapper.parentElement.insertBefore(container, fmWrapper);
      hideNativeFortiMonitorSearch();
    },
  });

  function start() {
    // Attach storage listeners synchronously, before awaiting initial
    // loads. Otherwise a storage change that fires between content-script
    // load and Promise.all resolving has no listener to land on, and the
    // operator sees the change as a no-op until they reload the tab. Both
    // subscription helpers compare against module-level state that has a
    // safe default, so attaching before the initial load is safe.
    subscribeColumnOrder();
    subscribeNativeColumnOrder();
    subscribeSidebarLauncherFlag();
    subscribeOmniSearchFlag();

    // Load persisted column order and the sidebar-launcher flag before the
    // first ensureAll() so the initial mount paints in the operator's
    // preferred state rather than the default and then snapping. The
    // feature-badges flag is read here too so the FMN-86 attribution
    // ribbons respect the operator's setting on the very first paint.
    Promise.all([
      loadColumnOrder(),
      loadNativeColumnOrder(),
      loadSidebarLauncherFlag(),
      loadShowFeatureBadgesFlag(),
      loadOmniSearchFlag(),
    ]).finally(() => {
      ensureAll();
      const observer = new MutationObserver(() => ensureAll());
      observer.observe(document.documentElement, { childList: true, subtree: true });

      const origPush = history.pushState;
      const origReplace = history.replaceState;
      history.pushState = function () {
        const r = origPush.apply(this, arguments);
        queueMicrotask(ensureAll);
        return r;
      };
      history.replaceState = function () {
        const r = origReplace.apply(this, arguments);
        queueMicrotask(ensureAll);
        return r;
      };
      window.addEventListener('popstate', ensureAll);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // FMN-152 dev aid: ping the SW on every content-script injection so the
  // SW wakes promptly and Playwright probes via CDP can introspect its
  // state (the SW idles in MV3; Playwright cannot wake it from the
  // outside, only from a chrome.runtime context like this content script).
  // Cheap no-op; the SW dispatch returns 'Unknown message type' which
  // we ignore.
  try {
    chrome.runtime.sendMessage({ type: 'fm:noop-wake' }, () => void chrome.runtime.lastError);
  } catch { /* SW unreachable; nothing we can do here */ }
})();
