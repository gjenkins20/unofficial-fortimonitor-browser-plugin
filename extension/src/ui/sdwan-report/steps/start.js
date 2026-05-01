// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SD-WAN Report - Step 1 (Start) - FMN-129.
//
// Confirms the API key is configured, captures an optional report name,
// exposes the regex pattern lists in a collapsible "Advanced" section
// (read-only by default - the operator can override per-run if a tenant's
// naming convention diverges from the FortiGate defaults).

import { h, titleBar } from '../../../lib/dom.js';
import {
  SDWAN_OVERLAY_PATTERNS,
  SDWAN_UNDERLAY_PATTERNS,
  SDWAN_GENERIC_PATTERNS
} from '../../../lib/sdwan-classifier.js';

const TOOL_NAME = 'SD-WAN Report';

export function reportBreadcrumbs(active) {
  const steps = [
    { id: 'start', label: '1. Configure' },
    { id: 'run', label: '2. Collect' },
    { id: 'results', label: '3. Results' }
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

function patternsTextarea(label, defaults, initialOverride) {
  const ta = h('textarea', {
    class: 'paste-area',
    style: 'min-height:5rem;font-family:monospace;font-size:0.85rem;',
    placeholder: defaults.join('\n')
  });
  ta.value = (initialOverride ?? []).join('\n');
  return { label, ta, defaults };
}

function readPatternList(ta, defaults) {
  const lines = ta.value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
  if (lines.length === 0) return null;       // empty -> use defaults
  if (sameSet(lines, defaults)) return null; // operator pasted the defaults verbatim
  return lines;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const A = a.slice().sort();
  const B = b.slice().sort();
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return false;
  return true;
}

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Configure', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    reportBreadcrumbs('start'),
    h('h2', {}, 'SD-WAN interface metric report'),
    h('p', {},
      'Crawls every monitored server\'s SNMP, agent, and network-service resources, ',
      'classifies each metric against the SD-WAN regex patterns, and emits a ',
      'CSV (customer-facing) plus a JSON file (machine-readable, consumed by the ',
      'Tag Applier tool).'
    ),
    h('p', { class: 'muted' },
      'Read-only. Uses your FortiMonitor v2 API key from popup → Settings.'
    )
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  // Optional report name
  body.appendChild(h('h3', { class: 'subhead' }, 'Report label (optional)'));
  body.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;margin:0 0 0.4rem;' },
    'Free-text label embedded in the JSON output and used as the default download filename. Useful when running for multiple customers in one session.'
  ));
  const nameInput = h('input', {
    type: 'text', class: 'paste-area',
    placeholder: 'e.g. ACME Corp - 2026-Q2',
    style: 'min-height:0;height:auto;padding:0.5rem 0.7rem;font-family:inherit;'
  });
  nameInput.value = store.reportName ?? '';
  body.appendChild(nameInput);

  // Advanced: pattern overrides
  const advWrap = h('details', {
    class: 'settings-details',
    style: 'margin-top:1rem;'
  });
  const advSummary = h('summary', { class: 'subhead', style: 'cursor:pointer;' },
    'Advanced: pattern overrides'
  );
  advWrap.appendChild(advSummary);
  advWrap.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;margin-top:0.4rem;' },
    'One regex per line. Leave a list blank to use the defaults shown as the placeholder. ',
    'Patterns are case-insensitive. The defaults match FortiGate naming; only override if your ',
    'tenant has a customer-specific convention.'
  ));

  const overlayCfg = patternsTextarea('Overlay (encrypted SD-WAN tunnels)', SDWAN_OVERLAY_PATTERNS, store.patterns?.overlay);
  const underlayCfg = patternsTextarea('Underlay (physical WAN links)', SDWAN_UNDERLAY_PATTERNS, store.patterns?.underlay);
  const genericCfg = patternsTextarea('Generic (named SD-WAN metrics)', SDWAN_GENERIC_PATTERNS, store.patterns?.generic);

  for (const cfg of [overlayCfg, underlayCfg, genericCfg]) {
    advWrap.appendChild(h('label', {
      class: 'settings-sublabel',
      style: 'display:block;margin-top:0.6rem;font-weight:600;'
    }, cfg.label));
    advWrap.appendChild(cfg.ta);
  }
  body.appendChild(advWrap);

  // Action bar
  const stateLabel = h('span', { class: 'execute-state muted' }, '');
  const runBtn = h('button', { class: 'btn btn-primary' }, 'Run report');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, stateLabel),
    h('div', { class: 'right' }, runBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  runBtn.addEventListener('click', () => {
    const overlay = readPatternList(overlayCfg.ta, overlayCfg.defaults);
    const underlay = readPatternList(underlayCfg.ta, underlayCfg.defaults);
    const generic = readPatternList(genericCfg.ta, genericCfg.defaults);
    const anyOverride = overlay || underlay || generic;
    store.reportName = nameInput.value.trim();
    store.patterns = anyOverride ? { overlay, underlay, generic } : null;
    store.runResult = null;
    store.runError = null;
    store.runCancelled = false;
    navigate('/run');
  });
}
