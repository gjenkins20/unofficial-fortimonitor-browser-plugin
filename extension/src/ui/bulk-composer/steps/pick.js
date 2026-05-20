// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-163 original: pick step rebuilt as a 1:1 visual port of the Add to
// Port Scope (Fabric) "Load devices from CSV" step. Drop-zone + paste
// textarea + green format-hint card + parse-result preview table + single
// Continue button.
//
// FMN-224 (2026-05-20): added a second input mode - "Server groups". A
// tab strip at the top of the body switches between the paste/CSV pane
// (original behavior) and a searchable multi-select picker fed by the
// monitoring_tree endpoint. Both tabs write into the same store.targets
// shape so downstream steps don't care which input the operator chose.
//
// Operator-confirmed 2026-05-13 (FMN-163): the screenshot of Add to Port
// Scope's load step IS the whole step. No omni-search input. No loader
// buttons. No chips.
//
// Name resolution (paste tab): parseServerList accepts numeric server IDs
// only and warns on anything else. To match the operator's natural
// workflow (which starts from FortiMonitor's UI showing device names, not
// IDs), this step silently routes the non-numeric warning tokens through
// the omni-search SW handler. Resolved names land in the parse-result
// table alongside numeric IDs; genuinely unknown tokens stay as warnings.
//
// Downstream contract preserved: store.targets is an array of
//   { id: number, name: string | null }
// which is the same shape the action / configure / commit steps read.

import { h, titleBar } from '../../../lib/dom.js';
import { parseServerList } from '../../parse-csv.js';
import { call } from '../../../lib/messaging.js';
import { bulkBreadcrumbs } from './breadcrumbs.js';
import { unionMembers } from '../../../lib/monitoring-tree.js';

const TOOL_NAME = 'Bulk Action Composer';

// Pattern used by parseServerList's "not a numeric server ID" warning so we
// can pluck the non-numeric tokens back out and try them as names.
const NON_NUMERIC_WARNING_RE = /^Line \d+: "(.+?)" is not a numeric server ID/;

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Pick instances', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    bulkBreadcrumbs('pick'),
    h('h2', {}, 'Load instances by ID, name, or server group'),
    h('p', {}, 'Provide the list of FortiMonitor server IDs or device names you want to operate on, or pick one or more server groups to load their members. Names are resolved against the FM TK Search cache.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ----- Tab strip --------------------------------------------------
  const tabStrip = h('div', { class: 'pick-tab-strip', role: 'tablist' });
  const pasteTabBtn = h('button', {
    class: 'pick-tab-btn', role: 'tab', type: 'button',
    'data-tab': 'paste', 'data-test': 'pick-tab-paste'
  }, 'Paste or CSV');
  const groupsTabBtn = h('button', {
    class: 'pick-tab-btn', role: 'tab', type: 'button',
    'data-tab': 'groups', 'data-test': 'pick-tab-groups'
  }, 'Server groups');
  tabStrip.appendChild(pasteTabBtn);
  tabStrip.appendChild(groupsTabBtn);
  body.appendChild(tabStrip);

  // ----- Paste pane (original behavior) -----------------------------
  const pastePane = h('div', { class: 'pick-pane', 'data-pane': 'paste' });
  body.appendChild(pastePane);

  const fileInput = h('input', { type: 'file', accept: '.csv,.txt', hidden: true });
  const dropZone = h('label', { class: 'drop-zone' },
    h('div', { class: 'dz-icon' }, '↑'),
    h('div', { class: 'dz-primary' },
      'Drop CSV here, or ',
      h('span', { class: 'dz-link' }, 'click to browse')
    ),
    h('div', { class: 'dz-secondary' }, 'Accepts .csv or plain text · one server ID or device name per line'),
    fileInput
  );
  pastePane.appendChild(dropZone);

  pastePane.appendChild(h('div', { class: 'divider' }, 'or paste below'));

  const paste = h('textarea', {
    class: 'paste-area',
    placeholder: '42024060\nFGT-Branch-001\n42024075\n...'
  });
  pastePane.appendChild(paste);

  pastePane.appendChild(h('div', { class: 'format-hint', html:
    '<strong>Format:</strong> plain list of server IDs or device names (one per line) <em>or</em> a CSV with a <code>server_id</code> column. Device names are resolved against the cached FM TK Search corpus.' +
    '<pre># plain list (IDs or names mixed)\n42024060\nFGT-Branch-001\n42024075\n\n# or CSV\nserver_id,device_name\n42024060,FGT-Branch-001\n42024075,FGT-Branch-002</pre>'
  }));

  // ----- Groups pane (FMN-224) -------------------------------------
  const groupsPane = h('div', { class: 'pick-pane', 'data-pane': 'groups' });
  body.appendChild(groupsPane);

  const groupsToolbar = h('div', { class: 'pick-groups-toolbar' });
  const searchInput = h('input', {
    type: 'search',
    class: 'pick-groups-search',
    placeholder: 'Filter groups by name…',
    'data-test': 'pick-groups-search'
  });
  const sortTreeBtn = h('button', {
    class: 'pick-groups-sort-btn', type: 'button',
    'data-test': 'pick-groups-sort-tree',
    title: 'Match the order of groups in your FortiMonitor tenant'
  }, 'FortiMonitor order');
  const sortAlphaBtn = h('button', {
    class: 'pick-groups-sort-btn', type: 'button',
    'data-test': 'pick-groups-sort-alpha',
    title: 'Sort groups alphabetically'
  }, 'A → Z');
  const sortGroup = h('div', { class: 'pick-groups-sort', role: 'group', 'aria-label': 'Group sort order' },
    sortTreeBtn, sortAlphaBtn
  );
  const refreshBtn = h('button', {
    class: 'btn btn-secondary pick-groups-refresh', type: 'button',
    'data-test': 'pick-groups-refresh'
  }, 'Refresh tree');
  groupsToolbar.appendChild(searchInput);
  groupsToolbar.appendChild(sortGroup);
  groupsToolbar.appendChild(refreshBtn);
  groupsPane.appendChild(groupsToolbar);

  const groupsStatus = h('div', { class: 'pick-groups-status' }, 'Loading server groups…');
  groupsPane.appendChild(groupsStatus);

  const groupsList = h('div', {
    class: 'pick-groups-list',
    'data-test': 'pick-groups-list'
  });
  groupsPane.appendChild(groupsList);

  const groupsSummary = h('div', { class: 'pick-groups-summary' }, 'No groups selected.');
  groupsPane.appendChild(groupsSummary);

  // ----- Shared parse-result panel ---------------------------------
  const parseResult = h('div', { class: 'parse-result empty' });
  body.appendChild(parseResult);

  // ----- Action bar ------------------------------------------------
  const clearBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Clear');
  const nextBtn = h('button', {
    class: 'btn btn-primary',
    'data-test': 'pick-next',
    type: 'button',
    disabled: true
  }, 'Continue to action picker →');
  frame.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, 'Uses your active FortiMonitor session (cookies)'),
    h('div', { class: 'right' }, clearBtn, nextBtn)
  ));

  container.appendChild(frame);

  // ================================================================
  // State
  // ================================================================

  // Generation counter so a stale async resolution callback can't clobber
  // the result of a later updateParseResult() call (paste-fast scenarios).
  let resolveGen = 0;

  // Groups-pane state. Cached so re-renders don't refetch and tab
  // switches keep the operator's selection.
  let groupsCache = null;        // { groups, nameById } from parseMonitoringTree
  let pickedGroupIds = new Set(  // selected group ids (numeric)
    Array.isArray(store.pickedGroupIds) ? store.pickedGroupIds.map(Number) : []
  );
  let searchFilter = '';
  let sortMode = store.pickGroupSort === 'alpha' ? 'alpha' : 'tree';

  // Active mode persists across step navigation. 'paste' is the default
  // for back-compat (FMN-163 sessions had no concept of modes).
  let activeMode = store.pickMode === 'groups' ? 'groups' : 'paste';

  // ----- Paste-pane rebuild on revisit -----------------------------
  if (activeMode === 'paste' && Array.isArray(store.targets) && store.targets.length) {
    paste.value = store.targets.map((t) => t.name ? `${t.id},${t.name}` : String(t.id)).join('\n');
  }

  // ================================================================
  // Shared parse-result renderers (drive whatever the active mode writes)
  // ================================================================

  function renderEmpty(headline = 'No server IDs detected', sub = 'Paste a list above or drop a CSV file.') {
    parseResult.className = 'parse-result empty';
    parseResult.replaceChildren(
      h('div', { class: 'headline' }, headline),
      h('div', { class: 'sub' }, sub)
    );
    store.targets = [];
    nextBtn.disabled = true;
  }

  function renderValidating({ resolvingCount, partialServerIds = [], partialNameById = {} }) {
    parseResult.className = 'parse-result';
    const kids = [
      h('div', { class: 'headline' },
        `Validating ${resolvingCount} entr${resolvingCount === 1 ? 'y' : 'ies'}…`),
      h('div', { class: 'sub' },
        `Looking up device name${resolvingCount === 1 ? '' : 's'} in the FM TK Search cache.` +
        (partialServerIds.length ? ` ${partialServerIds.length} numeric ID${partialServerIds.length === 1 ? '' : 's'} already accepted.` : ''))
    ];
    if (partialServerIds.length > 0) {
      kids.push(renderSampleTable(partialServerIds, partialNameById));
    }
    parseResult.replaceChildren(...kids);

    store.targets = partialServerIds.map((id) => ({
      id: Number(id),
      name: partialNameById[id] ?? null
    }));
    nextBtn.disabled = true;
  }

  function renderParsed({ serverIds, nameById, totalLines, warnings }) {
    parseResult.className = 'parse-result';
    const namedCount = Object.keys(nameById).length;
    const hasUnnamedRows = namedCount < serverIds.length;

    // Sub-line only carries useful information for the paste tab and only
    // when there's something concrete to report. Groups tab passes
    // totalLines=null and always has full name coverage from the tree, so
    // the sub-line would just repeat the headline count.
    const subParts = [];
    if (totalLines !== undefined && totalLines !== null) {
      subParts.push(`${totalLines} line${totalLines === 1 ? '' : 's'} read`);
    }
    if (hasUnnamedRows) {
      subParts.push('unnamed rows will resolve by ID downstream');
    }

    const kids = [
      h('div', { class: 'headline' },
        `${serverIds.length} instance${serverIds.length === 1 ? '' : 's'} ready to operate on`)
    ];
    if (subParts.length) kids.push(h('div', { class: 'sub' }, subParts.join(' · ')));
    kids.push(renderSampleTable(serverIds, nameById));
    if (warnings && warnings.length) {
      kids.push(h('div', { class: 'warn-list' },
        h('strong', {}, `${warnings.length} warning${warnings.length === 1 ? '' : 's'}: `),
        h('ul', {}, ...warnings.map((w) => h('li', {}, w)))
      ));
    }
    parseResult.replaceChildren(...kids);

    store.targets = serverIds.map((id) => ({
      id: Number(id),
      name: nameById[id] ?? null
    }));
    nextBtn.disabled = serverIds.length === 0;
  }

  // ================================================================
  // Paste-pane logic (original FMN-163 behavior)
  // ================================================================

  async function updateParseResultFromPaste() {
    const myGen = ++resolveGen;
    const parsed = parseServerList(paste.value);

    const nameCandidates = [];
    const nonNameWarnings = [];
    for (const w of parsed.warnings) {
      const m = w.match(NON_NUMERIC_WARNING_RE);
      if (m && m[1]) nameCandidates.push({ token: m[1], originalWarning: w });
      else nonNameWarnings.push(w);
    }

    if (parsed.serverIds.length === 0 && nameCandidates.length === 0) {
      renderEmpty();
      return;
    }

    if (nameCandidates.length > 0) {
      renderValidating({
        resolvingCount: nameCandidates.length,
        partialServerIds: parsed.serverIds,
        partialNameById: parsed.nameById
      });
    } else {
      renderParsed({
        serverIds: parsed.serverIds,
        nameById: parsed.nameById,
        totalLines: parsed.totalLines,
        warnings: nonNameWarnings
      });
      return;
    }

    const lookups = await Promise.all(nameCandidates.map(async ({ token, originalWarning }) => {
      try {
        const result = await call('omni-search:query', { query: token, max: 10 });
        const matches = Array.isArray(result?.matches) ? result.matches : [];
        const pick = matches.find((m) => (m.name || '').toLowerCase() === token.toLowerCase()) || null;
        return { token, pick, originalWarning };
      } catch {
        return { token, pick: null, originalWarning };
      }
    }));

    if (myGen !== resolveGen) return;

    const serverIds = [...parsed.serverIds];
    const nameById = { ...parsed.nameById };
    const seen = new Set(serverIds);
    const finalWarnings = [...nonNameWarnings];

    for (const { token, pick, originalWarning } of lookups) {
      if (pick && pick.id != null) {
        const idStr = String(pick.id);
        if (!seen.has(idStr)) {
          seen.add(idStr);
          serverIds.push(idStr);
        }
        if (pick.name && !nameById[idStr]) nameById[idStr] = pick.name;
      } else {
        const lineMatch = originalWarning.match(/^(Line \d+):/);
        const linePrefix = lineMatch ? lineMatch[1] : 'Input';
        finalWarnings.push(`${linePrefix}: "${token}" - device name not found in the FM TK Search cache`);
      }
    }

    renderParsed({
      serverIds,
      nameById,
      totalLines: parsed.totalLines,
      warnings: finalWarnings
    });
  }

  paste.addEventListener('input', () => {
    if (activeMode !== 'paste') return;
    void updateParseResultFromPaste();
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    paste.value = text;
    void updateParseResultFromPaste();
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const text = await file.text();
    paste.value = text;
    void updateParseResultFromPaste();
  });

  // ================================================================
  // Groups-pane logic (FMN-224)
  // ================================================================

  async function loadGroupsTree({ force = false } = {}) {
    if (groupsCache && !force) {
      renderGroupsList();
      return;
    }
    groupsStatus.textContent = 'Loading server groups…';
    groupsStatus.className = 'pick-groups-status';
    groupsList.replaceChildren();
    try {
      const result = await call('bulk-composer:list-server-groups-tree');
      if (!result || !Array.isArray(result.groups)) {
        throw new Error(result?.error || 'Empty response');
      }
      if (result.error) {
        // Handler returned a soft failure: empty groups + error string.
        groupsCache = { groups: [], nameById: {} };
        groupsStatus.textContent = result.error.includes('login') || result.error.includes('auth')
          ? 'Could not load server groups - your FortiMonitor session may have expired. Open FortiMonitor in another tab, sign in, then click Refresh tree.'
          : `Could not load server groups: ${result.error}`;
        groupsStatus.className = 'pick-groups-status pick-groups-status-error';
        renderGroupsList();
        return;
      }
      groupsCache = {
        groups: result.groups,
        nameById: result.nameById || {}
      };
      groupsStatus.textContent = `${result.groups.length} group${result.groups.length === 1 ? '' : 's'} loaded.`;
      groupsStatus.className = 'pick-groups-status';
      renderGroupsList();
      // Carry forward any picks the operator made before tab switch /
      // revisit; the parse-result panel reflects them.
      if (activeMode === 'groups' && pickedGroupIds.size > 0) {
        updateFromGroupsPicks();
      }
    } catch (err) {
      groupsCache = { groups: [], nameById: {} };
      groupsStatus.textContent = `Could not load server groups: ${err?.message ?? String(err)}`;
      groupsStatus.className = 'pick-groups-status pick-groups-status-error';
      renderGroupsList();
    }
  }

  function renderGroupsList() {
    groupsList.replaceChildren();
    syncSortButtons();
    if (!groupsCache || groupsCache.groups.length === 0) return;
    const filter = searchFilter.trim().toLowerCase();
    let matches = filter
      ? groupsCache.groups.filter((g) => g.name.toLowerCase().includes(filter))
      : groupsCache.groups.slice();
    if (sortMode === 'alpha') {
      matches.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }
    if (matches.length === 0) {
      groupsList.appendChild(h('div', { class: 'pick-groups-empty' }, 'No groups match your filter.'));
      return;
    }
    for (const g of matches) {
      groupsList.appendChild(renderGroupRow(g));
    }
  }

  function syncSortButtons() {
    sortTreeBtn.classList.toggle('active', sortMode === 'tree');
    sortAlphaBtn.classList.toggle('active', sortMode === 'alpha');
    sortTreeBtn.setAttribute('aria-pressed', sortMode === 'tree' ? 'true' : 'false');
    sortAlphaBtn.setAttribute('aria-pressed', sortMode === 'alpha' ? 'true' : 'false');
  }

  function renderGroupRow(g) {
    const id = `pick-group-${g.id}`;
    const cb = h('input', {
      type: 'checkbox', id,
      'data-group-id': String(g.id),
      'data-test': `pick-group-checkbox-${g.id}`
    });
    cb.checked = pickedGroupIds.has(g.id);
    cb.addEventListener('change', () => {
      if (cb.checked) pickedGroupIds.add(g.id);
      else pickedGroupIds.delete(g.id);
      updateFromGroupsPicks();
    });
    const count = g.allMemberIds.length;
    const countText = count === 0
      ? '0 devices'
      : `${count} device${count === 1 ? '' : 's'}`;
    const label = h('label', { for: id, class: 'pick-group-row-label' },
      h('span', { class: 'pick-group-name' }, g.name || `(unnamed group ${g.id})`),
      h('span', { class: 'pick-group-count' }, countText)
    );
    return h('div', { class: 'pick-group-row' }, cb, label);
  }

  function updateFromGroupsPicks() {
    if (!groupsCache) return;
    store.pickedGroupIds = [...pickedGroupIds];
    const picked = [...pickedGroupIds];
    if (picked.length === 0) {
      groupsSummary.textContent = 'No groups selected.';
      renderEmpty('No groups selected', 'Tick one or more groups above to load their members.');
      return;
    }
    const { serverIds } = unionMembers(groupsCache.groups, picked);
    groupsSummary.textContent = picked.length === 1
      ? `1 group selected, ${serverIds.length} unique device${serverIds.length === 1 ? '' : 's'}`
      : `${picked.length} groups selected, ${serverIds.length} unique device${serverIds.length === 1 ? '' : 's'}`;
    if (serverIds.length === 0) {
      renderEmpty('Selected groups contain no devices', 'The picked group(s) have no real server members (templates, OnSight appliances, and compound services don\'t count). Pick a different group or use Paste / CSV.');
      return;
    }
    renderParsed({
      serverIds,
      nameById: groupsCache.nameById,
      totalLines: null,
      warnings: []
    });
  }

  searchInput.addEventListener('input', () => {
    searchFilter = searchInput.value;
    renderGroupsList();
  });

  sortTreeBtn.addEventListener('click', () => {
    if (sortMode === 'tree') return;
    sortMode = 'tree';
    store.pickGroupSort = 'tree';
    renderGroupsList();
  });
  sortAlphaBtn.addEventListener('click', () => {
    if (sortMode === 'alpha') return;
    sortMode = 'alpha';
    store.pickGroupSort = 'alpha';
    renderGroupsList();
  });

  refreshBtn.addEventListener('click', () => {
    void loadGroupsTree({ force: true });
  });

  // ================================================================
  // Tab activation
  // ================================================================

  function activate(mode) {
    activeMode = mode;
    store.pickMode = mode;
    pastePane.style.display = mode === 'paste' ? '' : 'none';
    groupsPane.style.display = mode === 'groups' ? '' : 'none';
    for (const btn of [pasteTabBtn, groupsTabBtn]) {
      const isActive = btn.dataset.tab === mode;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    if (mode === 'paste') {
      void updateParseResultFromPaste();
    } else {
      void loadGroupsTree();
    }
  }

  pasteTabBtn.addEventListener('click', () => activate('paste'));
  groupsTabBtn.addEventListener('click', () => activate('groups'));

  // ================================================================
  // Action bar
  // ================================================================

  clearBtn.addEventListener('click', () => {
    if (activeMode === 'paste') {
      paste.value = '';
      void updateParseResultFromPaste();
    } else {
      pickedGroupIds.clear();
      store.pickedGroupIds = [];
      // Uncheck visible boxes.
      for (const cb of groupsList.querySelectorAll('input[type="checkbox"]')) cb.checked = false;
      updateFromGroupsPicks();
    }
  });

  nextBtn.addEventListener('click', () => {
    if (!store.targets || store.targets.length === 0) return;
    navigate('/action');
  });

  // Always render the parse-result once on mount so the empty state shows
  // its "No server IDs detected" headline immediately (matches Port Scope).
  activate(activeMode);
}

// Two-column Name | Server ID preview, same shape as Port Scope's. Up to 25
// rows shown inline; anything beyond collapses into a "+N more" line.
function renderSampleTable(serverIds, nameById) {
  const PREVIEW_LIMIT = 25;
  const rows = serverIds.slice(0, PREVIEW_LIMIT).map((id) => {
    const name = nameById[id];
    return h('tr', {},
      h('td', { class: name ? 'name' : 'name missing' }, name ?? '-'),
      h('td', { class: 'id' }, id)
    );
  });
  const tbody = h('tbody', {}, ...rows);
  const overflow = serverIds.length > PREVIEW_LIMIT
    ? h('div', { class: 'sample-table-overflow' }, `… +${serverIds.length - PREVIEW_LIMIT} more`)
    : null;
  return h('div', { class: 'sample-table-wrap' },
    h('table', { class: 'sample-table' },
      h('thead', {}, h('tr', {},
        h('th', { class: 'name' }, 'Instance name'),
        h('th', { class: 'id' }, 'Server ID')
      )),
      tbody
    ),
    overflow
  );
}
