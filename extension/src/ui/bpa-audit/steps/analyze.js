// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// BPA Audit - Step 3 (Analyze) - FMN-133.
//
// Trivial transition step. The analyzers already ran in the background
// during the bpa:run-audit handler call (FMN-132 modules are pure and
// fast in-process); this step exists so the breadcrumbs read sensibly
// to the operator and so we can show a brief summary before they enter
// the viewer.

import { h, titleBar } from '../../../lib/dom.js';
import { reportBreadcrumbs } from './start.js';

const TOOL_NAME = 'BPA Audit';

export function render({ container, store, navigate }) {
  const result = store.runResult ?? {};
  const inv = result.inventory ?? {};
  const analysis = result.analysis ?? {};

  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Analyze', { toolName: TOOL_NAME }));

  const arr = (v) => Array.isArray(v) ? v.length : 0;
  const counts = {
    servers: arr(inv.servers),
    groups: arr(inv.server_groups),
    templates: arr(inv.server_templates),
    activeIncidents: analysis?.incidents?.active_count ?? 0,
    users: analysis?.users?.total ?? 0
  };

  frame.appendChild(h('div', { class: 'step-header' },
    reportBreadcrumbs('analyze'),
    h('h2', {}, 'Analysis ready'),
    h('p', { class: 'muted' },
      'The five analyzers (Incidents, Users, Instances, Templates, Monitoring Policy) ',
      'completed in-process. Continue to the 11-tab viewer to review and export.'
    )
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  body.appendChild(h('h3', { class: 'subhead' }, 'Inventory snapshot'));
  const ul = h('ul', { class: 'plain-list', style: 'list-style:none;padding-left:0;font-size:0.95rem;' });
  for (const [label, n] of Object.entries({
    'Servers': counts.servers,
    'Server groups': counts.groups,
    'Server templates': counts.templates,
    'Active incidents': counts.activeIncidents,
    'Users': counts.users
  })) {
    ul.appendChild(h('li', { style: 'padding:0.2rem 0;' },
      h('strong', {}, `${label}: `),
      String(n)
    ));
  }
  body.appendChild(ul);

  if (result.deep) {
    body.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;margin-top:0.6rem;' },
      'Deep dive enabled - Instance Analysis and Manual Threshold Patterns sections '
      + 'will be populated.'
    ));
  } else {
    body.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;margin-top:0.6rem;' },
      'Deep dive was off. Some sections (Instance Analysis, Manual Threshold Patterns) '
      + 'will say "Run with deep mode for full analysis." Re-run with deep mode on to populate them.'
    ));
  }

  const reviewBtn = h('button', { class: 'btn btn-primary' }, 'Open viewer');
  const restartBtn = h('button', { class: 'btn btn-secondary' }, 'New audit');
  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }),
    h('div', { class: 'right' }, restartBtn, reviewBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  reviewBtn.addEventListener('click', () => navigate('/review'));
  restartBtn.addEventListener('click', () => {
    store.runResult = null;
    store.runError = null;
    store.runCancelled = false;
    store.annotations = {};
    navigate('/start');
  });
}
