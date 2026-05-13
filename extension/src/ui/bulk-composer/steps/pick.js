// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155: Step 1 - pick a subset of instances.
//
// Reuses the FMN-152 omni-search corpus via the SW's omni-search:query
// handler. The corpus is denormalized server entries (name + fqdn +
// tags + attributes + template_names + etc.) so a single substring
// query covers every searchable field.
//
// Pickers:
//   - Type-to-search dropdown (debounced; click a row to add as a chip)
//   - "Load from clipboard CSV" - operator pastes a comma / newline list
//     of ids or names; we look each up against the cached corpus
//   - "Load from current page selection" - reads the most recent
//     selection stashed in chrome.storage.session by the augment.js
//     content script (Phase-2 will wire this end-to-end; v1 is a
//     best-effort read).

import { h, titleBar } from '../../../lib/dom.js';
import { bulkBreadcrumbs } from './breadcrumbs.js';

const TOOL_NAME = 'Bulk Action Composer';
const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 150;

export function render({ container, store, navigate, call }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Pick instances', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    bulkBreadcrumbs('pick'),
    h('h2', {}, 'Pick a subset of instances to operate on'),
    h('p', {}, 'Type to search across every server field (name, fqdn, ip, tags, attributes, template, group). Pick rows into the chip list below, or load a list from your clipboard. Step 2 picks an action; step 3 configures it; step 4 previews + commits with concurrency 3.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // ============================================================
  // Search input + dropdown
  // ============================================================
  body.appendChild(h('h3', { class: 'subhead' }, '1. Search'));
  const searchInput = h('input', {
    type: 'search',
    class: 'paste-area',
    placeholder: 'Type at least 2 characters...',
    style: 'min-height:0;height:auto;padding:0.5rem 0.7rem;font-family:inherit;'
  });
  const searchHint = h('div', { class: 'muted', style: 'font-size:0.8rem;margin-top:0.25rem;color:var(--text-muted);' },
    'Searches the FM TK Search corpus (cached for 5 min).');
  const dropdown = h('div', {
    class: 'bulk-search-dropdown',
    'data-test': 'bulk-search-dropdown',
    style: 'border:1px solid var(--border);border-radius:4px;margin-top:0.4rem;max-height:280px;overflow-y:auto;display:none;'
  });
  body.appendChild(searchInput);
  body.appendChild(searchHint);
  body.appendChild(dropdown);

  // ============================================================
  // Bulk loaders (CSV / current selection)
  // ============================================================
  body.appendChild(h('h3', { class: 'subhead', style: 'margin-top:1rem;' }, '2. Or load a list'));
  const csvBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Load from clipboard CSV');
  const selBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Load from current page selection');
  body.appendChild(h('div', { style: 'display:flex;gap:0.5rem;flex-wrap:wrap;' }, csvBtn, selBtn));
  const csvHint = h('div', { class: 'muted', style: 'font-size:0.8rem;margin-top:0.3rem;color:var(--text-muted);' },
    'Clipboard: paste server IDs or names, one per line or comma-separated. Page selection: read the last subset you ticked on /report/ListServers.');
  body.appendChild(csvHint);
  const loaderStatus = h('div', {
    class: 'loader-status',
    style: 'font-size:0.85rem;margin-top:0.4rem;color:var(--text-muted);min-height:1.2em;'
  });
  body.appendChild(loaderStatus);

  // ============================================================
  // Chip list of selected targets
  // ============================================================
  body.appendChild(h('h3', { class: 'subhead', style: 'margin-top:1rem;' }, '3. Selected instances'));
  const chipsHost = h('div', {
    class: 'bulk-chips',
    'data-test': 'bulk-chips',
    style: 'display:flex;flex-wrap:wrap;gap:0.4rem;min-height:2.2rem;padding:0.4rem;border:1px solid var(--border);border-radius:4px;'
  });
  body.appendChild(chipsHost);
  const chipsCount = h('div', {
    class: 'bulk-chips-count',
    'data-test': 'bulk-chips-count',
    style: 'font-size:0.85rem;margin-top:0.3rem;color:var(--text-muted);'
  });
  body.appendChild(chipsCount);

  // ============================================================
  // Action bar
  // ============================================================
  const clearBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Clear all');
  const nextBtn = h('button', {
    class: 'btn btn-primary',
    'data-test': 'pick-next',
    type: 'button',
    disabled: true
  }, 'Continue to action picker →');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, h('span', { class: 'execute-state muted', 'data-test': 'pick-state' }, '')),
    h('div', { class: 'right' }, clearBtn, nextBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  const stateLabel = actionBar.querySelector('[data-test="pick-state"]');

  // ============================================================
  // Wiring
  // ============================================================
  function renderChips() {
    chipsHost.innerHTML = '';
    if (store.targets.length === 0) {
      chipsHost.appendChild(h('div', { class: 'muted', style: 'font-size:0.85rem;color:var(--text-muted);font-style:italic;padding:0.3rem 0;' }, 'No instances selected.'));
    } else {
      for (const t of store.targets) {
        const removeBtn = h('button', {
          class: 'chip-x', type: 'button', title: 'Remove',
          style: 'border:none;background:none;cursor:pointer;padding:0 0.3rem;font-size:1rem;line-height:1;'
        }, '×');
        const idLabel = t.id != null ? h('span', { style: 'opacity:0.55;font-size:0.8rem;margin-left:0.25rem;' }, `#${t.id}`) : null;
        const chip = h('span', {
          class: 'chip',
          'data-test': 'bulk-chip',
          'data-id': String(t.id ?? ''),
          style: 'background:#eef2f7;border:1px solid #c4c8cf;border-radius:12px;padding:0.18rem 0.55rem;font-size:0.85rem;display:inline-flex;align-items:center;gap:0.25rem;max-width:320px;'
        },
          h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px;' }, t.name || `(no name)`),
          idLabel,
          removeBtn
        );
        removeBtn.addEventListener('click', () => {
          store.targets = store.targets.filter((x) => x.id !== t.id);
          renderChips();
        });
        chipsHost.appendChild(chip);
      }
    }
    chipsCount.textContent = store.targets.length === 0
      ? '0 instances selected.'
      : `${store.targets.length} instance${store.targets.length === 1 ? '' : 's'} selected.`;
    nextBtn.disabled = store.targets.length === 0;
  }
  renderChips();

  function addTarget(entry) {
    if (!entry || entry.id == null) return false;
    if (store.targets.some((t) => t.id === entry.id)) return false;
    store.targets.push(entry);
    return true;
  }

  function renderDropdown(matches, total, query) {
    dropdown.innerHTML = '';
    if (!matches.length) {
      dropdown.style.display = 'block';
      dropdown.appendChild(h('div', { style: 'padding:0.5rem 0.7rem;color:var(--text-muted);font-size:0.85rem;' },
        query.length < MIN_QUERY_LEN
          ? `Type at least ${MIN_QUERY_LEN} characters...`
          : `No matches for "${query}".`
      ));
      return;
    }
    dropdown.style.display = 'block';
    if (total > matches.length) {
      dropdown.appendChild(h('div', {
        style: 'padding:0.4rem 0.7rem;font-size:0.75rem;color:var(--text-muted);border-bottom:1px solid var(--border);'
      }, `${matches.length} shown of ${total} matches. Refine your query for fewer.`));
    }
    for (const m of matches) {
      const already = store.targets.some((t) => t.id === m.id);
      const row = h('div', {
        class: 'bulk-search-row',
        'data-test': 'bulk-search-row',
        'data-id': String(m.id ?? ''),
        style: `padding:0.4rem 0.7rem;cursor:${already ? 'default' : 'pointer'};display:flex;align-items:center;gap:0.5rem;border-bottom:1px solid var(--border);${already ? 'opacity:0.5;' : ''}`
      });
      row.appendChild(h('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, m.name || `(no name)`));
      if (m.fqdn) row.appendChild(h('span', { class: 'muted', style: 'font-size:0.75rem;color:var(--text-muted);' }, m.fqdn));
      if (already) row.appendChild(h('span', { class: 'muted', style: 'font-size:0.7rem;color:var(--text-muted);font-style:italic;' }, '(added)'));
      if (!already) {
        row.addEventListener('click', () => {
          addTarget(m);
          renderChips();
          renderDropdown(matches, total, query);
        });
      }
      dropdown.appendChild(row);
    }
  }

  // FMN-155 QA fix: outside-click closes the dropdown VISUALLY without
  // wiping the results, so when the operator clicks back into the search
  // box the previous matches are immediately visible. They no longer need
  // to retype or reload the page to recover a hidden result list.
  function hideDropdown() {
    dropdown.style.display = 'none';
  }
  function clearDropdown() {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
  }

  // FMN-155 QA fix: render a clear in-dropdown loading state during the
  // omni-search query. The prior implementation only updated a small
  // status label below the action bar - the operator could not tell the
  // search was in flight and assumed nothing was happening.
  function renderLoadingState(query) {
    dropdown.innerHTML = '';
    dropdown.style.display = 'block';
    const row = h('div', {
      style: 'padding:0.6rem 0.7rem;color:var(--text-muted);font-size:0.85rem;display:flex;align-items:center;gap:0.5rem;'
    });
    const spinner = h('span', {
      'aria-hidden': 'true',
      style: 'display:inline-block;width:12px;height:12px;border:2px solid var(--border);border-top-color:var(--accent,#1f6feb);border-radius:50%;animation:fmn-spin 0.8s linear infinite;'
    });
    row.appendChild(spinner);
    row.appendChild(h('span', {}, `Searching for "${query}"...`));
    dropdown.appendChild(row);
    ensureSpinnerKeyframes();
  }
  function ensureSpinnerKeyframes() {
    if (document.getElementById('fmn-bulk-spinner-style')) return;
    const style = document.createElement('style');
    style.id = 'fmn-bulk-spinner-style';
    style.textContent = '@keyframes fmn-spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }

  let debounceTimer = null;
  let lastQueryId = 0;
  let lastRenderedMatches = null;
  let lastRenderedTotal = 0;
  let lastRenderedQuery = '';
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (q.length < MIN_QUERY_LEN) {
      clearDropdown();
      lastRenderedMatches = null;
      stateLabel.textContent = '';
      return;
    }
    const queryId = ++lastQueryId;
    // Visible loading row immediately - no waiting for debounce to elapse
    // before the operator sees a signal.
    renderLoadingState(q);
    stateLabel.textContent = 'Searching...';
    debounceTimer = setTimeout(async () => {
      try {
        const result = await call('omni-search:query', { query: q, max: 50 });
        if (queryId !== lastQueryId) return; // stale
        const matches = Array.isArray(result?.matches) ? result.matches : [];
        const total = result?.total ?? matches.length;
        renderDropdown(matches, total, q);
        lastRenderedMatches = matches;
        lastRenderedTotal = total;
        lastRenderedQuery = q;
        stateLabel.textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'}`;
      } catch (err) {
        if (queryId !== lastQueryId) return;
        renderDropdown([], 0, q);
        lastRenderedMatches = [];
        lastRenderedTotal = 0;
        lastRenderedQuery = q;
        stateLabel.textContent = `Error: ${err?.message ?? err}`;
      }
    }, DEBOUNCE_MS);
  });

  // Hide on outside click; refocus re-shows the last results so the
  // operator can recover without retyping.
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && e.target !== searchInput) hideDropdown();
  });
  searchInput.addEventListener('focus', () => {
    if (lastRenderedMatches && searchInput.value.trim() === lastRenderedQuery) {
      // Restore prior results in place.
      renderDropdown(lastRenderedMatches, lastRenderedTotal, lastRenderedQuery);
    } else if (searchInput.value.trim().length >= MIN_QUERY_LEN) {
      dropdown.style.display = 'block';
    }
  });

  // ---- Clipboard CSV loader ----
  csvBtn.addEventListener('click', async () => {
    loaderStatus.textContent = 'Reading clipboard...';
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      loaderStatus.textContent = `Could not read clipboard: ${err?.message ?? err}. Paste directly into the search box instead.`;
      return;
    }
    const tokens = parseTokens(text);
    if (tokens.length === 0) {
      loaderStatus.textContent = 'Clipboard had no server IDs / names to load.';
      return;
    }
    loaderStatus.textContent = `Looking up ${tokens.length} token${tokens.length === 1 ? '' : 's'}...`;
    const { added, notFound } = await resolveTokens(tokens, call);
    for (const e of added) addTarget(e);
    renderChips();
    if (notFound.length === 0) {
      loaderStatus.textContent = `Loaded ${added.length} instance${added.length === 1 ? '' : 's'} from clipboard.`;
    } else {
      loaderStatus.textContent = `Loaded ${added.length}; ${notFound.length} not found in cache: ${notFound.slice(0, 5).join(', ')}${notFound.length > 5 ? '...' : ''}`;
    }
  });

  // ---- Current-page-selection loader (best-effort read) ----
  selBtn.addEventListener('click', async () => {
    loaderStatus.textContent = 'Reading last page selection...';
    try {
      const stash = await call('bulk-composer:current-selection', {});
      const ids = Array.isArray(stash?.ids) ? stash.ids : [];
      if (ids.length === 0) {
        loaderStatus.textContent = 'No saved page selection. Tick rows on FortiMonitor\'s All Instances page first, then return here (this loader is best-effort in v1).';
        return;
      }
      const { added, notFound } = await resolveTokens(ids.map(String), call);
      for (const e of added) addTarget(e);
      renderChips();
      loaderStatus.textContent = `Loaded ${added.length} from page selection${notFound.length ? ` (${notFound.length} not in cache)` : ''}.`;
    } catch (err) {
      loaderStatus.textContent = `Could not read page selection: ${err?.message ?? err}`;
    }
  });

  clearBtn.addEventListener('click', () => {
    store.targets = [];
    renderChips();
    loaderStatus.textContent = '';
  });

  nextBtn.addEventListener('click', () => {
    if (store.targets.length === 0) return;
    navigate('/action');
  });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}

// Parse a clipboard blob into discrete tokens. Accepts commas, semicolons,
// or any whitespace as separators. Drops empties.
function parseTokens(text) {
  return String(text || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Resolve a list of tokens (numeric ids or names) into omni-search-cache
// entries. Uses the SW's omni-search:query for each token; the cache is
// shared so resolution is fast. Tokens that look like a numeric id route
// to an exact-id query first.
async function resolveTokens(tokens, call) {
  const added = [];
  const notFound = [];
  const seenIds = new Set();
  for (const tok of tokens) {
    try {
      const result = await call('omni-search:query', { query: tok, max: 5 });
      const matches = Array.isArray(result?.matches) ? result.matches : [];
      // Prefer an id-exact, then name-exact, then the top score.
      let pick = null;
      if (/^\d+$/.test(tok)) {
        pick = matches.find((m) => String(m.id) === tok) || null;
      }
      if (!pick) {
        pick = matches.find((m) => (m.name || '').toLowerCase() === tok.toLowerCase()) || null;
      }
      if (!pick && matches.length === 1) pick = matches[0];
      if (pick && !seenIds.has(pick.id)) {
        seenIds.add(pick.id);
        added.push(pick);
      } else if (!pick) {
        notFound.push(tok);
      }
    } catch {
      notFound.push(tok);
    }
  }
  return { added, notFound };
}
