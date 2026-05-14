// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Tenant Observations - Step 1 (Start) - FMN-133.
//
// Captures the customer/report name (used as report title and CSV
// filename prefix), an optional deep-mode toggle (per-server analysis),
// and an optional max-servers cap. The deep toggle is the most
// expensive option - clearly labelled as such.

import { h, titleBar } from '../../../lib/dom.js';
import {
  ALL_SECTION_ID,
  defaultSelection,
  nextSectionsSelection,
  sanitize as sanitizeSections
} from '../section-selection.js';

const TOOL_NAME = 'Tenant Observations';

const SECTION_PILLS = [
  { id: ALL_SECTION_ID, label: 'All' },
  { id: 'incidents', label: 'Incidents' },
  { id: 'user-activity', label: 'User Activity' },
  { id: 'instance-analysis', label: 'Instances' },
  { id: 'template-recommendations', label: 'Templates' },
  { id: 'monitoring-policy', label: 'Monitoring Policy' }
];

export function reportBreadcrumbs(active) {
  const steps = [
    { id: 'start', label: '1. Configure' },
    { id: 'collect', label: '2. Collect' },
    { id: 'analyze', label: '3. Analyze' },
    { id: 'review', label: '4. Review' }
  ];
  const order = steps.findIndex((s) => s.id === active);
  return h('div', { class: 'step-breadcrumbs' },
    steps.flatMap((s, i) => {
      const cls = i < order ? 'step done' : i === order ? 'step active' : 'step';
      const label = i < order ? `${s.label} ✓` : s.label;
      const item = h('span', { class: cls }, label);
      return i === 0 ? [item] : [h('span', { class: 'arrow' }, '›'), item];
    })
  );
}

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Configure', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    reportBreadcrumbs('start'),
    h('h2', {}, 'FortiMonitor Tenant Observations'),
    h('p', {},
      'Surveys the instance across five analyzer dimensions ',
      '(incidents, users, instances, templates, monitoring policy workflow) and ',
      'presents the findings as observations in a 10-tab in-browser viewer. Download a single ',
      'combined report or per-tab CSVs to hand-curate before delivery.'
    ),
    h('p', { class: 'muted' },
      'Read-only. Uses your FortiMonitor v2 API key from popup → Settings.'
    )
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // Customer / report name
  body.appendChild(h('h3', { class: 'subhead' }, 'Customer / report label'));
  body.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;margin:0 0 0.4rem;' },
    'Becomes the report title in the Executive Summary and the prefix for every CSV download. '
    + 'Example: "Acme Corp" exports as "acme-corp_executive-summary_20260501.csv".'
  ));
  const nameInput = h('input', {
    type: 'text', class: 'paste-area',
    placeholder: 'e.g. ACME Corp',
    style: 'min-height:0;height:auto;padding:0.5rem 0.7rem;font-family:inherit;'
  });
  nameInput.value = store.customerName ?? '';
  body.appendChild(nameInput);

  // Deep-mode toggle
  body.appendChild(h('h3', { class: 'subhead', style: 'margin-top:1rem;' }, 'Per-server deep dive'));
  body.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;margin:0 0 0.4rem;' },
    'Off by default. When on, the assessment walks each server\'s agent_resource, ',
    'agent_resource_threshold, network_service, and attribute endpoints. Required for ',
    'the Instance Analysis and Manual Threshold Patterns sections to populate. ',
    'Adds 4-5 v2 API calls per server; allow 5-15 minutes for tenants with hundreds of servers.'
  ));
  const deepInput = h('input', { type: 'checkbox' });
  deepInput.checked = Boolean(store.deep);
  body.appendChild(h('label', { class: 'toggle-row' }, deepInput, h('span', {}, 'Run per-server deep analysis')));

  // FortiMonitor UI data is now always-on (FMN-135 follow-up,
  // 2026-05-01). The opt-in toggle was original removed because the
  // v2-only path needs no FortiMonitor session, but the Tenant Observations' value
  // depends on last_login and the operator is by definition logged in
  // when running this tool. No checkbox is needed.

  // Section selector (FMN-146)
  body.appendChild(h('h3', { class: 'subhead', style: 'margin-top:1rem;' }, 'Sections'));
  body.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;margin:0 0 0.4rem;' },
    'Default is the full report. Click a single section to scope the run; ',
    'shift-click to combine sections. Cross-cutting sections (Executive Summary, ',
    'Feature Utilization, Quick Labs, Raw Counts) require ',
    'a full run and are not standalone-deliverable.'
  ));
  let selectedSections = sanitizeSections(store.sections ?? defaultSelection());
  const pillRow = h('div', {
    class: 'tenant-observations-section-pills',
    role: 'group',
    'aria-label': 'Sections',
    'data-test': 'tenant-observations-section-pills'
  });
  const pillButtons = new Map();
  for (const pill of SECTION_PILLS) {
    const btn = h('button', {
      type: 'button',
      class: 'tenant-observations-pill',
      'data-section': pill.id,
      'data-test': `tenant-observations-section-pill-${pill.id}`
    }, pill.label);
    btn.addEventListener('click', (event) => {
      selectedSections = nextSectionsSelection(selectedSections, pill.id, { shift: event.shiftKey });
      paintPills();
    });
    pillRow.appendChild(btn);
    pillButtons.set(pill.id, btn);
  }
  function paintPills() {
    const active = new Set(selectedSections);
    for (const [id, btn] of pillButtons) {
      const on = active.has(id);
      btn.classList.toggle('tenant-observations-pill-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  paintPills();
  body.appendChild(pillRow);

  // Max-servers cap
  body.appendChild(h('h3', { class: 'subhead', style: 'margin-top:1rem;' }, 'Max servers (optional)'));
  body.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;margin:0 0 0.4rem;' },
    'Useful for sampling a tenant before committing to a full deep assessment. Leave blank for no cap.'
  ));
  const maxInput = h('input', {
    type: 'number', min: '0', step: '1', class: 'paste-area',
    placeholder: 'no cap',
    style: 'min-height:0;height:auto;padding:0.5rem 0.7rem;font-family:inherit;width:8rem;'
  });
  if (store.maxServers > 0) maxInput.value = String(store.maxServers);
  body.appendChild(maxInput);

  // Action bar
  const stateLabel = h('span', { class: 'execute-state muted' }, '');
  const runBtn = h('button', { class: 'btn btn-primary' }, 'Run assessment');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, stateLabel),
    h('div', { class: 'right' }, runBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  runBtn.addEventListener('click', () => {
    store.customerName = nameInput.value.trim();
    store.deep = Boolean(deepInput.checked);
    store.includeFrontend = true;     // always-on (FMN-135 follow-up)
    store.sections = sanitizeSections(selectedSections);
    const m = Number(maxInput.value);
    store.maxServers = Number.isFinite(m) && m > 0 ? Math.floor(m) : 0;
    store.runResult = null;
    store.runError = null;
    store.runCancelled = false;
    navigate('/collect');
  });
}
