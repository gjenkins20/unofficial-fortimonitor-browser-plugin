// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155: shared breadcrumbs for the Bulk Action Composer steps.

import { h } from '../../../lib/dom.js';

const STEPS = [
  { id: 'pick',      label: '1. Pick instances' },
  { id: 'action',    label: '2. Pick action' },
  { id: 'configure', label: '3. Configure' },
  { id: 'commit',    label: '4. Preview & commit' }
];

export function bulkBreadcrumbs(active) {
  const order = STEPS.findIndex((s) => s.id === active);
  return h('div', { class: 'step-breadcrumbs' },
    STEPS.flatMap((s, i) => {
      const cls = i < order ? 'step done' : i === order ? 'step active' : 'step';
      const label = i < order ? `${s.label} ✓` : s.label;
      const item = h('span', { class: cls }, label);
      return i === 0 ? [item] : [h('span', { class: 'arrow' }, '›'), item];
    })
  );
}
