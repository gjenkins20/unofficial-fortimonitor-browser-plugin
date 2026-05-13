// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-163: pick step rebuilt as a 1:1 visual port of the Add to Port Scope
// (Fabric) "Load devices from CSV" step. Drop-zone + paste textarea + green
// format-hint card + parse-result preview table + single Continue button.
//
// Operator-confirmed 2026-05-13: the screenshot of Add to Port Scope's load
// step IS the whole step. No omni-search input. No loader buttons. No chips.
//
// Name resolution: parseServerList accepts numeric server IDs only and warns
// on anything else. To match the operator's natural workflow (which starts
// from FortiMonitor's UI showing device names, not IDs), this step silently
// routes the non-numeric warning tokens through the omni-search SW handler.
// Resolved names land in the parse-result table alongside numeric IDs;
// genuinely unknown tokens stay as warnings. The UI is unchanged either way -
// only the parser gets smarter.
//
// Downstream contract preserved: store.targets is an array of
//   { id: number, name: string | null }
// which is the same shape the action / configure / commit steps read.

import { h, titleBar } from '../../../lib/dom.js';
import { parseServerList } from '../../parse-csv.js';
import { call } from '../../../lib/messaging.js';
import { bulkBreadcrumbs } from './breadcrumbs.js';

const TOOL_NAME = 'Bulk Action Composer';

// Pattern used by parseServerList's "not a numeric server ID" warning so we
// can pluck the non-numeric tokens back out and try them as names.
const NON_NUMERIC_WARNING_RE = /^Line \d+: "(.+?)" is not a numeric server ID/;

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Pick instances', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    bulkBreadcrumbs('pick'),
    h('h2', {}, 'Load instances by ID or name'),
    h('p', {}, 'Provide the list of FortiMonitor server IDs or device names you want to operate on. Names are resolved against the FM TK Search cache. The Composer then takes you to the action picker.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

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
  body.appendChild(dropZone);

  body.appendChild(h('div', { class: 'divider' }, 'or paste below'));

  const paste = h('textarea', {
    class: 'paste-area',
    placeholder: '42024060\nFGT-Branch-001\n42024075\n...'
  });
  // If the operator already picked instances on a prior pass, rebuild the
  // paste value from the existing targets so the step is idempotent on revisit.
  if (Array.isArray(store.targets) && store.targets.length) {
    paste.value = store.targets.map((t) => t.name ? `${t.id},${t.name}` : String(t.id)).join('\n');
  }
  body.appendChild(paste);

  body.appendChild(h('div', { class: 'format-hint', html:
    '<strong>Format:</strong> plain list of server IDs or device names (one per line) <em>or</em> a CSV with a <code>server_id</code> column. Device names are resolved against the cached FM TK Search corpus.' +
    '<pre># plain list (IDs or names mixed)\n42024060\nFGT-Branch-001\n42024075\n\n# or CSV\nserver_id,device_name\n42024060,FGT-Branch-001\n42024061,FGT-Branch-002</pre>'
  }));

  const parseResult = h('div', { class: 'parse-result empty' });
  body.appendChild(parseResult);

  // Action bar - matches Port Scope's footer copy exactly so the chrome
  // reads as a sibling step.
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

  // Generation counter so a stale async resolution callback can't clobber
  // the result of a later updateParseResult() call (paste-fast scenarios).
  let resolveGen = 0;

  function renderEmpty() {
    parseResult.className = 'parse-result empty';
    parseResult.replaceChildren(
      h('div', { class: 'headline' }, 'No server IDs detected'),
      h('div', { class: 'sub' }, 'Paste a list above or drop a CSV file.')
    );
    store.targets = [];
    nextBtn.disabled = true;
  }

  // Render the parse-result panel from a merged set of {serverIds, nameById,
  // totalLines, warnings}. Pass resolvingCount > 0 to show a "resolving N
  // name(s)..." indicator and keep Continue disabled.
  function renderParsed({ serverIds, nameById, totalLines, warnings, resolvingCount = 0 }) {
    parseResult.className = 'parse-result';
    const namedCount = Object.keys(nameById).length;

    const subParts = [`${totalLines} line${totalLines === 1 ? '' : 's'} read`];
    subParts.push(`${namedCount} named from CSV / resolved`);
    if (namedCount < serverIds.length) subParts.push('(unnamed rows resolve by ID downstream)');
    if (resolvingCount > 0) subParts.push(`resolving ${resolvingCount} name${resolvingCount === 1 ? '' : 's'}…`);

    const kids = [
      h('div', { class: 'headline' },
        `${serverIds.length} instance${serverIds.length === 1 ? '' : 's'} ready to operate on`),
      h('div', { class: 'sub' }, subParts.join(' · ')),
      renderSampleTable(serverIds, nameById)
    ];
    if (warnings.length) {
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
    // Disable Continue while resolution is in-flight so the operator can't
    // press it before the table fills in.
    nextBtn.disabled = serverIds.length === 0 || resolvingCount > 0;
  }

  async function updateParseResult() {
    const myGen = ++resolveGen;
    const parsed = parseServerList(paste.value);

    // Pull non-numeric tokens out of the parser's warnings so we can try
    // them as names. Each warning maps 1:1 to one offending input line.
    const nonNumericTokens = [];
    for (const w of parsed.warnings) {
      const m = w.match(NON_NUMERIC_WARNING_RE);
      if (m && m[1]) nonNumericTokens.push(m[1]);
    }

    // Pure-empty input: render the placeholder and stop.
    if (parsed.serverIds.length === 0 && nonNumericTokens.length === 0) {
      renderEmpty();
      return;
    }

    // Initial render with whatever we have from parseServerList.
    renderParsed({
      serverIds: parsed.serverIds,
      nameById: parsed.nameById,
      totalLines: parsed.totalLines,
      warnings: parsed.warnings,
      resolvingCount: nonNumericTokens.length
    });

    if (nonNumericTokens.length === 0) return;

    // Resolve names against the omni-search cache in parallel. Each token
    // gets one query; we accept ONLY an exact case-insensitive name match.
    // Substring / single-result fallbacks are intentionally absent because
    // omni-search returns fuzzy matches and silently picking a near-match
    // would attach the operator's action to the wrong device.
    const lookups = await Promise.all(nonNumericTokens.map(async (token) => {
      try {
        const result = await call('omni-search:query', { query: token, max: 10 });
        const matches = Array.isArray(result?.matches) ? result.matches : [];
        const pick = matches.find((m) => (m.name || '').toLowerCase() === token.toLowerCase()) || null;
        return { token, pick };
      } catch {
        return { token, pick: null };
      }
    }));

    // If a newer update started while we were awaiting, drop this result.
    if (myGen !== resolveGen) return;

    const resolved = new Map(); // token (lowercased) -> { id: string, name: string|null }
    for (const { token, pick } of lookups) {
      if (pick && pick.id != null) {
        resolved.set(token.toLowerCase(), { id: String(pick.id), name: pick.name ?? null });
      }
    }

    // Merge: keep parser's numeric IDs, append resolved-by-name IDs (de-dup),
    // strip warnings whose token resolved, keep warnings whose token didn't.
    const serverIds = [...parsed.serverIds];
    const nameById = { ...parsed.nameById };
    const seen = new Set(serverIds);
    for (const { id, name } of resolved.values()) {
      if (seen.has(id)) continue;
      seen.add(id);
      serverIds.push(id);
      if (name) nameById[id] = name;
    }
    const finalWarnings = [];
    for (const w of parsed.warnings) {
      const m = w.match(NON_NUMERIC_WARNING_RE);
      if (m && resolved.has(m[1].toLowerCase())) continue;
      finalWarnings.push(w);
    }

    renderParsed({
      serverIds,
      nameById,
      totalLines: parsed.totalLines,
      warnings: finalWarnings,
      resolvingCount: 0
    });
  }

  paste.addEventListener('input', () => { void updateParseResult(); });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    paste.value = text;
    void updateParseResult();
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
    void updateParseResult();
  });

  clearBtn.addEventListener('click', () => {
    paste.value = '';
    store.targets = [];
    void updateParseResult();
  });

  nextBtn.addEventListener('click', () => {
    if (!store.targets || store.targets.length === 0) return;
    navigate('/action');
  });

  // Always render the parse-result once on mount so the empty state shows
  // its "No server IDs detected" headline immediately (matches Port Scope).
  void updateParseResult();
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
