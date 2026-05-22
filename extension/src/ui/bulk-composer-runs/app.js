// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-237: Rollback Changes UI.
//
// Single-page tool. Reads the journal via bulk-composer:list-runs, renders
// one card per run, and exposes a Rollback button that calls
// bulk-composer:rollback-run and re-renders the card with the outcome.

import { call } from '../../lib/messaging.js';

document.documentElement.dataset.toolMode = 'bulk-composer-runs';

const listEl = document.getElementById('runs-list');
const refreshBtn = document.getElementById('refresh-btn');

refreshBtn.addEventListener('click', () => { void load(); });

function fmtTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function renderEmpty() {
  listEl.innerHTML = `
    <div class="empty">
      No changes recorded yet. Commit a Bulk Action Composer action that
      creates a template, monitoring-policy workflow, server group,
      attribute, or tag, and it will appear here.
    </div>
  `;
}

function fullyRolledBack(run) {
  if (!run.rollback || !run.rollback.finishedAt) return false;
  const steps = Array.isArray(run.rollback.steps) ? run.rollback.steps : [];
  if (steps.length === 0) return false;
  return steps.every((s) => s.status === 'succeeded' || s.status === 'already-gone');
}

function countResources(run) {
  const c = run.created || {};
  const a = run.attached || {};
  return {
    templates: (c.templates || []).length,
    mpws: (c.mpws || []).length,
    server_groups: (c.server_groups || []).length,
    attributes: (c.attributes || []).length,
    tags: (c.tags || []).length,
    attached: (a.templateAttachments || []).length
  };
}

function renderResourceList(run) {
  const counts = countResources(run);
  const entries = [];
  if (counts.templates) entries.push(['Templates created', counts.templates]);
  if (counts.mpws) entries.push(['Monitoring-policy workflows created', counts.mpws]);
  if (counts.server_groups) entries.push(['Server groups created', counts.server_groups]);
  if (counts.attached) entries.push(['Template attachments', counts.attached]);
  if (counts.attributes) entries.push(['Attributes set', counts.attributes]);
  if (counts.tags) entries.push(['Tags added', counts.tags]);
  if (entries.length === 0) return '';
  return entries.map(([label, n]) =>
    `<div><span class="label">${label}:</span> ${n}</div>`
  ).join('');
}

function renderRollbackOutcome(run) {
  if (!run.rollback) return '';
  const steps = Array.isArray(run.rollback.steps) ? run.rollback.steps : [];
  if (steps.length === 0) {
    return `<div class="rollback-outcome"><em>Rollback ran but recorded no steps.</em></div>`;
  }
  const stepLines = steps.map((s) => {
    const status = s.status || 'unknown';
    const label = s.label || s.identity || s.kind;
    const errorBit = s.error ? ` <span style="color:#b00020;">— ${escapeHtml(s.error)}</span>` : '';
    return `<div class="step"><span class="status ${status}">${escapeHtml(status)}</span><span>${escapeHtml(String(label))}${errorBit}</span></div>`;
  }).join('');
  const startedAt = fmtTimestamp(run.rollback.startedAt);
  return `
    <div class="rollback-outcome">
      <div style="margin-bottom:6px;"><strong>Rollback ${escapeHtml(startedAt)}</strong></div>
      ${stepLines}
    </div>
  `;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderRun(run) {
  const counts = countResources(run);
  const totalResources = counts.templates + counts.mpws + counts.server_groups
    + counts.attached + counts.attributes + counts.tags;
  const finished = fmtTimestamp(run.finishedAt || run.startedAt);
  const targetCount = Array.isArray(run.targetIds) ? run.targetIds.length : 0;
  const done = fullyRolledBack(run);
  const rollbackDisabled = totalResources === 0 || done;
  const rollbackLabel = done ? 'Rolled back' : 'Rollback';

  return `
    <div class="run-card" data-run-id="${escapeHtml(run.runId)}">
      <h3>${escapeHtml(run.actionLabel || run.actionId)}</h3>
      <div class="meta">
        ${escapeHtml(finished)} · ${targetCount} target${targetCount === 1 ? '' : 's'} · run ${escapeHtml(run.runId)}
      </div>
      <div class="resource-list">${renderResourceList(run)}</div>
      <div class="run-actions">
        <button type="button" class="rollback-btn" ${rollbackDisabled ? 'disabled' : ''} data-run-id="${escapeHtml(run.runId)}">
          ${rollbackLabel}
        </button>
        <span class="rollback-status" data-status-for="${escapeHtml(run.runId)}"></span>
      </div>
      ${renderRollbackOutcome(run)}
    </div>
  `;
}

function render(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    renderEmpty();
    return;
  }
  listEl.innerHTML = runs.map(renderRun).join('');
  for (const btn of listEl.querySelectorAll('.rollback-btn:not([disabled])')) {
    btn.addEventListener('click', onRollbackClick);
  }
}

async function load() {
  refreshBtn.disabled = true;
  try {
    const result = await call('bulk-composer:list-runs');
    render(result?.runs || []);
  } catch (err) {
    listEl.innerHTML = `<div class="empty" style="color:#b00020;">Failed to load runs: ${escapeHtml(err?.message ?? String(err))}</div>`;
  } finally {
    refreshBtn.disabled = false;
  }
}

async function onRollbackClick(e) {
  const btn = e.currentTarget;
  const runId = btn.getAttribute('data-run-id');
  if (!runId) return;
  if (!confirm('Roll back this run? The created resources will be deleted from FortiMonitor (and template attachments removed).')) {
    return;
  }
  btn.disabled = true;
  const statusEl = listEl.querySelector(`[data-status-for="${cssEscape(runId)}"]`);
  if (statusEl) statusEl.textContent = ' running…';
  try {
    await call('bulk-composer:rollback-run', { runId });
    await load();
  } catch (err) {
    if (statusEl) statusEl.textContent = ` failed: ${err?.message ?? err}`;
    btn.disabled = false;
  }
}

function cssEscape(s) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

void load();
