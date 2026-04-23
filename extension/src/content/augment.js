// FMN-69: FortiMonitor WebGUI augmentation framework + FM Toolkit sidebar
// entry. Runs as a content script on FortiMonitor domains. Survives SPA
// re-renders via MutationObserver and route changes via pushState/replaceState
// /popstate hooks. Clicking the FM Toolkit entry toggles an iframe overlay
// that embeds the existing popup.html, so the sidebar menu IS the popup with
// identical styling, search, settings, tool cards, and behavior.

(() => {
  const LAUNCHER_ID = 'toolkit-launcher';
  const OVERLAY_ID = 'fmn-toolkit-overlay';
  const ENTRY_ATTR = 'data-fmn-entry';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const POPUP_URL = chrome.runtime.getURL('src/popup/popup.html');

  const augmentations = [];
  const overlayState = { el: null, outsideHandler: null, keyHandler: null };

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
      if (document.querySelector(`[${ENTRY_ATTR}="${LAUNCHER_ID}"]`)) return;
      const anyTopLevel = document.querySelector('li.pa-side-nav__top-level-item');
      if (!anyTopLevel || !anyTopLevel.parentElement) return;
      anyTopLevel.parentElement.appendChild(buildLauncherEntry());
    },
  });

  // FMN-71: IP Address + DNS Name columns on /report/ListServers.
  // Source: /report/get_idp_data?server_id={id} -> pageData.instance.fqdn,
  // classified into IP vs. DNS by regex. Fetches are per-row with
  // concurrency 3 and cached in-memory for the session.
  const INSTANCES_PATH = '/report/ListServers';
  const SERVER_ID_RE = /^s-(\d+)$/;
  const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
  const IPV6_HINT_RE = /^[0-9a-fA-F:]+$/;
  const FETCH_CONCURRENCY = 3;
  const HEADER_AUG_ATTR = 'data-fmn-ip-augmented';
  const ROW_AUG_ATTR = 'data-fmn-ip-row-augmented';
  const IP_CELL_ATTR = 'data-fmn-ip-cell';
  const DNS_CELL_ATTR = 'data-fmn-dns-cell';

  const fetchCache = new Map();
  const fetchQueue = [];
  let activeFetches = 0;
  const sortState = { column: null, direction: null };

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
        min-width: 520px !important;
        padding-right: 12px !important;
      }
      .fmn-hdr-grid, .fmn-cell-grid {
        display: grid;
        grid-template-columns: minmax(120px, 1fr) minmax(110px, 130px) minmax(140px, 200px);
        gap: 14px;
        align-items: center;
      }
      .fmn-hdr-grid > * { min-width: 0; }
      .fmn-cell-grid > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .fmn-cell-ip { font-variant-numeric: tabular-nums; color: #394449; }
      .fmn-cell-dns { color: #394449; }
      .fmn-cell-ip.fmn-unresolved, .fmn-cell-dns.fmn-unresolved {
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
      .fmn-sub-hdr .fmn-chev {
        display: inline-block; width: 0; height: 0;
        border-left: 4px solid transparent; border-right: 4px solid transparent;
        border-top: 5px solid currentColor; opacity: 0.35;
        margin-left: 6px; vertical-align: middle;
        transition: transform 120ms ease, opacity 120ms ease;
      }
      .fmn-sub-hdr.fmn-sort-asc .fmn-chev { transform: rotate(180deg); opacity: 1; color: #1f6feb; }
      .fmn-sub-hdr.fmn-sort-desc .fmn-chev { opacity: 1; color: #1f6feb; }
      .fmn-sub-hdr.fmn-sort-asc, .fmn-sub-hdr.fmn-sort-desc { color: #1f6feb; }
      .fmn-hdr-instance-label { color: inherit; font-weight: inherit; }
    `;
    document.head.appendChild(style);
  }

  function augmentTable(table) {
    const thead = table.querySelector('thead');
    if (thead) {
      const headerRow = thead.querySelector('tr');
      if (headerRow && !headerRow.hasAttribute(HEADER_AUG_ATTR)) {
        const instanceTh = findInstanceCell(Array.from(headerRow.children));
        if (instanceTh) {
          augmentInstanceHeader(instanceTh);
          headerRow.setAttribute(HEADER_AUG_ATTR, '1');
          updateSortIndicators();
        }
      }
    }

    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    let addedAny = false;
    for (const row of tbody.querySelectorAll('tr')) {
      if (augmentRow(row)) addedAny = true;
    }
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
    // when the operator clicks "Instance". The wrapper is the first grid
    // slot; IP Address and DNS Name get their own slots next to it.
    th.classList.add('fmn-instance-merged');
    const originalChildren = Array.from(th.childNodes);
    th.textContent = '';

    const grid = document.createElement('div');
    grid.className = 'fmn-hdr-grid';

    const nameSlot = document.createElement('span');
    nameSlot.className = 'fmn-hdr-instance-label';
    if (originalChildren.length > 0) {
      for (const c of originalChildren) nameSlot.appendChild(c);
    } else {
      nameSlot.textContent = originalText;
    }
    grid.appendChild(nameSlot);

    grid.appendChild(buildSortableSubHeader('IP Address', 'ip'));
    grid.appendChild(buildSortableSubHeader('DNS Name', 'dns'));
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

    const nameSlot = document.createElement('span');
    nameSlot.className = 'fmn-cell-name';
    for (const c of originalChildren) nameSlot.appendChild(c);
    grid.appendChild(nameSlot);

    const ipSlot = document.createElement('span');
    ipSlot.className = 'fmn-cell-ip';
    if (serverId) ipSlot.setAttribute(IP_CELL_ATTR, serverId);
    grid.appendChild(ipSlot);

    const dnsSlot = document.createElement('span');
    dnsSlot.className = 'fmn-cell-dns';
    if (serverId) dnsSlot.setAttribute(DNS_CELL_ATTR, serverId);
    grid.appendChild(dnsSlot);

    instanceCell.appendChild(grid);
    row.setAttribute(ROW_AUG_ATTR, '1');

    if (serverId) {
      renderCell(ipSlot, fetchCache.get(serverId));
      renderCell(dnsSlot, fetchCache.get(serverId));
      enqueueFetch(serverId);
    } else {
      renderUnavailableCell(ipSlot, 'ip');
      renderUnavailableCell(dnsSlot, 'dns');
    }
    return true;
  }

  function renderUnavailableCell(cell, kind) {
    cell.classList.add('fmn-unresolved');
    cell.textContent = 'not captured';
    cell.title = kind === 'ip'
      ? 'IP address not captured for this row type'
      : 'DNS name not captured for this row type';
  }

  function buildSortableSubHeader(label, col) {
    const span = document.createElement('span');
    span.className = 'fmn-sub-hdr ' + (col === 'ip' ? 'fmn-ip-hdr' : 'fmn-dns-hdr');
    span.setAttribute('data-fmn-sort-col', col);
    span.setAttribute('title', 'Sort (client-side; within currently rendered rows)');
    span.textContent = label;
    const chev = document.createElement('span');
    chev.className = 'fmn-chev';
    span.appendChild(chev);
    span.addEventListener('click', (e) => {
      // Stop propagation so the Instance TH's own FortiMonitor sort doesn't
      // fire when the operator is sorting by IP or DNS.
      e.preventDefault();
      e.stopPropagation();
      onSortClick(col);
    });
    return span;
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

  function start() {
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
