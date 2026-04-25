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

  const augmentations = [];
  const overlayState = { el: null, outsideHandler: null, keyHandler: null };
  let sidebarLauncherEnabled = false;

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
  const COL_ATTR = 'data-fmn-col';
  const WEBGUI_COLUMNS_KEY = 'fm:webguiColumns';
  const AUG_ID = 'instances-ip-dns-columns';

  // Column metadata for the Instances list augmentation. Mirror of the
  // 'instances-ip-dns-columns' entry in src/lib/column-order.js.
  const COLUMNS = {
    instance: { label: 'Instance',   lockedVisible: true,  width: 'minmax(120px, 1fr)' },
    ip:       { label: 'IP Address', lockedVisible: false, width: 'minmax(110px, 130px)' },
    dns:      { label: 'DNS Name',   lockedVisible: false, width: 'minmax(140px, 200px)' },
    type:     { label: 'Type',       lockedVisible: false, width: 'minmax(110px, 150px)' },
  };
  const DEFAULT_COL_IDS = ['instance', 'ip', 'dns', 'type'];

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
      for (const table of document.querySelectorAll('table.pa-table_outage')) {
        augmentTable(table);
      }
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
        min-width: 640px !important;
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
      .fmn-cell-ip.fmn-unresolved, .fmn-cell-dns.fmn-unresolved,
      .fmn-cell-type.fmn-unresolved {
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
      } else {
        // id === 'type'. Populated synchronously from the checkbox-value prefix;
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
      }
      grid.appendChild(slot);
    }

    instanceCell.appendChild(grid);
    row.setAttribute(ROW_AUG_ATTR, '1');

    if (serverId) {
      renderCell(grid.querySelector('[' + IP_CELL_ATTR + ']'), fetchCache.get(serverId));
      renderCell(grid.querySelector('[' + DNS_CELL_ATTR + ']'), fetchCache.get(serverId));
      enqueueFetch(serverId);
    } else {
      renderUnavailableCell(grid.querySelector('.fmn-cell-ip'), 'ip');
      renderUnavailableCell(grid.querySelector('.fmn-cell-dns'), 'dns');
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
    cell.textContent = 'not captured';
    cell.title = kind === 'ip'
      ? 'IP address not captured for this row type'
      : 'DNS name not captured for this row type';
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
    const v = col === 'ip' ? cached.ip : cached.dns;
    return v || null;
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
      fetchServerAddress(id)
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

  async function fetchServerAddress(serverId) {
    const res = await fetch('/report/get_idp_data?server_id=' + encodeURIComponent(serverId), {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    const ct = res.headers.get('Content-Type') || '';
    if (!ct.includes('json')) return { state: 'failed' };
    let body;
    try { body = await res.json(); } catch { return { state: 'failed' }; }
    const fqdn = body && body.pageData && body.pageData.instance && body.pageData.instance.fqdn;
    const { ip, dns } = classifyFqdn(fqdn);
    return { state: 'resolved', ip, dns };
  }

  function paintCellsForServer(serverId) {
    const cached = fetchCache.get(serverId);
    for (const cell of document.querySelectorAll(
      '[' + IP_CELL_ATTR + '="' + serverId + '"], [' + DNS_CELL_ATTR + '="' + serverId + '"]'
    )) {
      renderCell(cell, cached);
    }
  }

  function renderCell(cell, cached) {
    if (!cell) return;
    const isIp = cell.hasAttribute(IP_CELL_ATTR);
    cell.textContent = '';
    cell.classList.remove('fmn-unresolved');
    cell.removeAttribute('title');
    if (!cached || cached.state === 'loading') {
      const skel = document.createElement('span');
      skel.className = 'fmn-skel';
      skel.style.width = isIp ? '90px' : '140px';
      cell.appendChild(skel);
      return;
    }
    const value = isIp ? cached.ip : cached.dns;
    if (value) {
      cell.textContent = value;
      cell.title = value;
      return;
    }
    cell.classList.add('fmn-unresolved');
    cell.textContent = 'not captured';
    cell.title = cached.state === 'failed'
      ? 'Unable to resolve address for this instance'
      : (isIp
        ? 'No IP address captured for this instance'
        : 'No DNS name captured for this instance');
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

  function start() {
    // Attach storage listeners synchronously, before awaiting initial
    // loads. Otherwise a storage change that fires between content-script
    // load and Promise.all resolving has no listener to land on, and the
    // operator sees the change as a no-op until they reload the tab. Both
    // subscription helpers compare against module-level state that has a
    // safe default, so attaching before the initial load is safe.
    subscribeColumnOrder();
    subscribeSidebarLauncherFlag();

    // Load persisted column order and the sidebar-launcher flag before the
    // first ensureAll() so the initial mount paints in the operator's
    // preferred state rather than the default and then snapping.
    Promise.all([loadColumnOrder(), loadSidebarLauncherFlag()]).finally(() => {
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
})();
