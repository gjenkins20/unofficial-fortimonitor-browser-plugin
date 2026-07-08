// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-280: Parent/Child Associations - a top-level tool for bulk device
// parent/child (dependency) associations. Two modes:
//   Set    - a child->parent mapping (parent: child, child per line). Supports
//            many-children->one-parent AND a different-parent-per-child topology.
//   Remove - a list of children whose parent is cleared.
// Instances may be referenced by NAME or numeric SERVER ID (operator ask).
// Set writes via v2; Remove via the session-auth editInstance path - both the
// verified FMN-277/279 methods, run per child by the parent-child:apply handler.

import { h, titleBar } from '../../lib/dom.js';
import { call, onEvent } from '../../lib/messaging.js';
import { parseMappingText, flattenGroups, isChangeStatus } from '../../lib/parent-child-mapping.js';

const root = document.getElementById('app-root');

const state = {
  mode: 'set',            // 'set' | 'remove'
  setText: '',
  removeText: '',
  preview: null,          // { mode, rows } from parent-child:resolve
  parseErrors: [],
  conflicts: [],
  busy: false,            // resolving
  applying: false,
  progress: null,         // { done, total }
  results: null,          // final apply results
  error: null,
};

const STATUS_META = {
  'set':          { label: 'will set',        cls: 'pc-pill-set' },
  'remove':       { label: 'will remove',     cls: 'pc-pill-remove' },
  'skip-already': { label: 'skip (already)',  cls: 'pc-pill-skip' },
  'skip-self':    { label: 'skip (self)',     cls: 'pc-pill-self' },
  'skip-none':    { label: 'skip (no parent)',cls: 'pc-pill-skip' },
  'error-child':  { label: 'error: child',    cls: 'pc-pill-error' },
  'error-parent': { label: 'error: parent',   cls: 'pc-pill-error' },
};

function label(entity, token, err) {
  if (entity && entity.id != null) return entity.name ? `${entity.name} (#${entity.id})` : `#${entity.id}`;
  return `${token || '?'} — ${err || 'unresolved'}`;
}

// ---- actions -------------------------------------------------------------

async function doPreview() {
  state.error = null; state.results = null; state.progress = null;
  let rows;
  if (state.mode === 'set') {
    const parsed = parseMappingText(state.setText);
    state.parseErrors = parsed.errors;
    const flat = flattenGroups(parsed.groups);
    state.conflicts = flat.conflicts;
    rows = flat.rows.map((r) => ({ childToken: r.childToken, parentToken: r.parentToken }));
  } else {
    state.parseErrors = []; state.conflicts = [];
    rows = String(state.removeText || '')
      .split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
      .map((t) => ({ childToken: t }));
  }
  if (rows.length === 0) { state.preview = null; render(); return; }
  state.busy = true; render();
  try {
    state.preview = await call('parent-child:resolve', { mode: state.mode, rows });
  } catch (err) {
    state.error = err?.message ?? String(err);
    state.preview = null;
  } finally {
    state.busy = false; render();
  }
}

async function doApply() {
  if (!state.preview) return;
  const changeRows = state.preview.rows.filter((r) => isChangeStatus(r.status));
  if (changeRows.length === 0) return;
  const rows = changeRows.map((r) => ({
    childId: r.child.id,
    childName: r.child.name,
    parentUrl: state.mode === 'set' ? r.parent.url : undefined,
  }));
  state.applying = true;
  state.progress = { done: 0, total: rows.length };
  render();
  const off = onEvent((event) => {
    if (event === 'parent-child:row-done' && state.progress) { state.progress.done += 1; render(); }
  });
  try {
    const out = await call('parent-child:apply', { mode: state.mode, rows });
    state.results = out.results || [];
  } catch (err) {
    state.error = err?.message ?? String(err);
  } finally {
    if (typeof off === 'function') off();
    state.applying = false;
    render();
    // NB: results stay on screen (per-row done/failed pills + summary). The
    // operator clicks Preview to re-resolve against the new live state - we do
    // NOT auto-re-preview here, since that would wipe the just-shown results.
  }
}

// ---- rendering -----------------------------------------------------------

function tabBar() {
  const mk = (mode, text) => h('button', {
    class: 'pc-tab' + (state.mode === mode ? ' active' : ''),
    'data-test': `pc-tab-${mode}`,
    onclick: () => { if (state.applying) return; state.mode = mode; state.preview = null; state.results = null; state.error = null; render(); }
  }, text);
  return h('div', { class: 'pc-tabs' }, mk('set', 'Set parents'), mk('remove', 'Remove parents'));
}

function inputPane() {
  if (state.mode === 'set') {
    return h('div', {},
      h('p', { class: 'pc-hint' }, 'One parent per line, then its children — by name or server ID. Many children can share a parent; add more lines for different parents.'),
      h('pre', { class: 'pc-example' }, 'core-router: switch-01, switch-02, 44218437\ndmz-fw: edge-01'),
      h('textarea', {
        class: 'pc-textarea', 'data-test': 'pc-set-input', rows: 7,
        placeholder: 'parent: child, child, …',
        oninput: (e) => { state.setText = e.target.value; },
      }, state.setText)
    );
  }
  return h('div', {},
    h('p', { class: 'pc-hint' }, 'One child instance per line (or comma-separated) — by name or server ID. Each listed instance has its parent cleared.'),
    h('textarea', {
      class: 'pc-textarea', 'data-test': 'pc-remove-input', rows: 7,
      placeholder: 'child\nchild\n…',
      oninput: (e) => { state.removeText = e.target.value; },
    }, state.removeText)
  );
}

function issuesPane() {
  const items = [];
  for (const e of state.parseErrors) items.push(h('li', {}, `Line ${e.line}: ${e.error} — "${e.text}"`));
  for (const c of state.conflicts) items.push(h('li', {}, `"${c.childToken}" listed under two parents ("${c.from}" then "${c.to}"); using "${c.to}".`));
  if (items.length === 0) return null;
  return h('ul', { class: 'pc-issues', 'data-test': 'pc-issues' }, ...items);
}

function previewTable() {
  if (state.busy) return h('p', { class: 'pc-muted', 'data-test': 'pc-resolving' }, 'Resolving instances…');
  if (!state.preview) return null;
  const rows = state.preview.rows;
  const changes = rows.filter((r) => isChangeStatus(r.status)).length;
  const skips = rows.length - changes;

  const resultById = new Map((state.results || []).map((r) => [String(r.childId), r]));

  const head = state.mode === 'set'
    ? h('tr', {}, h('th', {}, 'Child'), h('th', {}, 'Current parent'), h('th', {}, ''), h('th', {}, 'New parent'), h('th', {}, 'Status'))
    : h('tr', {}, h('th', {}, 'Child'), h('th', {}, 'Current parent'), h('th', {}, ''), h('th', {}, ''), h('th', {}, 'Status'));

  const body = rows.map((r) => {
    const meta = STATUS_META[r.status] || { label: r.status, cls: 'pc-pill-skip' };
    const applied = r.child ? resultById.get(String(r.child.id)) : null;
    let statusCell = h('span', { class: 'pc-pill ' + meta.cls }, meta.label);
    if (applied) {
      statusCell = applied.status === 'succeeded'
        ? h('span', { class: 'pc-pill pc-pill-done' }, applied.noop ? 'skipped' : 'done')
        : h('span', { class: 'pc-pill pc-pill-error', title: applied.error || '' }, 'failed');
    }
    return h('tr', { 'data-test': 'pc-preview-row' },
      h('td', {}, label(r.child, r.childToken, r.childError)),
      h('td', { class: 'pc-muted' }, r.currentParent ? label(r.currentParent, '', '') : '(none)'),
      h('td', { class: 'pc-arrow' }, '→'),
      h('td', {}, state.mode === 'set' ? label(r.parent, r.parentToken, r.parentError) : '(none)'),
      h('td', {}, statusCell),
    );
  });

  return h('div', {},
    h('h3', { class: 'pc-sub' }, `Preview — ${changes} will change · ${skips} skip`),
    h('table', { class: 'pc-table', 'data-test': 'pc-preview' }, h('thead', {}, head), h('tbody', {}, ...body)),
  );
}

function footer() {
  const changes = state.preview ? state.preview.rows.filter((r) => isChangeStatus(r.status)).length : 0;
  const applyLabel = state.applying
    ? `Applying… ${state.progress ? `${state.progress.done}/${state.progress.total}` : ''}`
    : (state.mode === 'set' ? `Set ${changes} parent${changes === 1 ? '' : 's'}` : `Remove ${changes} parent${changes === 1 ? '' : 's'}`);
  return h('div', { class: 'pc-footer' },
    h('span', { class: 'pc-summary', 'data-test': 'pc-summary' },
      state.results ? `Done: ${state.results.filter((r) => r.status === 'succeeded').length} ok · ${state.results.filter((r) => r.status === 'failed').length} failed`
        : (state.preview ? `${changes} change${changes === 1 ? '' : 's'} ready.` : '')),
    h('button', {
      class: 'pc-btn', 'data-test': 'pc-preview-btn',
      disabled: state.busy || state.applying, onclick: doPreview,
    }, 'Preview'),
    h('button', {
      class: 'pc-btn pc-btn-primary', 'data-test': 'pc-apply-btn',
      disabled: state.applying || changes === 0, onclick: doApply,
    }, applyLabel),
  );
}

function render() {
  root.textContent = '';
  const wrap = h('div', { class: 'pc-app' },
    titleBar('bulk set & remove device dependency parents', { toolName: 'Parent / Child Associations', beta: true }),
    tabBar(),
    h('div', { class: 'pc-body' },
      inputPane(),
      issuesPane(),
      state.error ? h('p', { class: 'pc-error', 'data-test': 'pc-error' }, state.error) : null,
      previewTable(),
    ),
    footer(),
  );
  root.appendChild(wrap);
  ensureStyles();
}

function ensureStyles() {
  if (document.getElementById('pc-styles')) return;
  const css = `
    .pc-app{max-width:840px;margin:0 auto}
    .pc-tabs{display:flex;gap:4px;padding:12px 18px 0}
    .pc-tab{padding:7px 14px;border:1px solid var(--border);border-bottom:none;border-radius:7px 7px 0 0;background:#fafbfc;color:var(--text-muted);cursor:pointer;font-size:12.5px;font-family:inherit}
    .pc-tab.active{background:var(--card);color:var(--text);font-weight:600;border-color:var(--border-strong)}
    .pc-body{padding:16px 18px;border-top:1px solid var(--border)}
    .pc-hint{color:var(--text-muted);font-size:12.5px;margin:0 0 8px}
    .pc-example{background:var(--muted-soft);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:11.5px;margin:0 0 10px;white-space:pre-wrap}
    .pc-textarea{width:100%;font-family:"SF Mono",Menlo,monospace;font-size:12px;border:1px solid var(--border-strong);border-radius:6px;padding:9px;box-sizing:border-box;resize:vertical}
    .pc-issues{margin:10px 0;padding:8px 12px 8px 26px;background:var(--warn-soft);border:1px solid #e6d38a;border-radius:6px;font-size:12px;color:var(--warn)}
    .pc-error{color:var(--danger);background:var(--danger-soft);border:1px solid #e0a9a0;border-radius:6px;padding:8px 10px;font-size:12.5px}
    .pc-sub{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin:18px 0 8px}
    .pc-table{width:100%;border-collapse:collapse;font-size:12.5px}
    .pc-table th{text-align:left;color:var(--text-muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:6px 8px;border-bottom:1px solid var(--border)}
    .pc-table td{padding:7px 8px;border-bottom:1px solid var(--border)}
    .pc-muted{color:var(--text-muted)}
    .pc-arrow{color:var(--text-muted)}
    .pc-pill{font-size:11px;padding:1px 8px;border-radius:10px;white-space:nowrap}
    .pc-pill-set,.pc-pill-remove{background:var(--muted-soft);color:var(--text)}
    .pc-pill-skip{background:#f1f1f1;color:var(--text-muted)}
    .pc-pill-self{background:var(--warn-soft);color:var(--warn)}
    .pc-pill-error{background:var(--danger-soft);color:var(--danger)}
    .pc-pill-done{background:var(--ok-soft);color:var(--ok)}
    .pc-footer{display:flex;align-items:center;gap:12px;padding:14px 18px;border-top:1px solid var(--border);background:#fafbfc}
    .pc-summary{color:var(--text-muted);font-size:12px;margin-right:auto}
    .pc-btn{border:1px solid var(--border-strong);background:#fff;border-radius:6px;padding:7px 13px;font-size:12.5px;cursor:pointer;font-family:inherit}
    .pc-btn:disabled{opacity:.5;cursor:default}
    .pc-btn-primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  `;
  const style = document.createElement('style');
  style.id = 'pc-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

render();
