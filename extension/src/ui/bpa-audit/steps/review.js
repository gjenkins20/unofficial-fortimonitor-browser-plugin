// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// BPA Audit - Step 4 (Review) - FMN-133.
//
// Hosts the 11-tab viewer. The viewer module owns its own rendering;
// this step only provides the title bar, breadcrumbs, and a "New audit"
// action.

import { h, titleBar } from '../../../lib/dom.js';
import { reportBreadcrumbs } from './start.js';
import { renderViewer } from '../viewer.js';

const TOOL_NAME = 'Best-Practice Assessment';

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Review', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    reportBreadcrumbs('review'),
    h('h2', {}, store.customerName
      ? `${store.customerName} - Best-Practice Assessment`
      : 'Best-Practice Assessment'),
    h('p', { class: 'muted' },
      '11 tabs - one per section of the report. Each tab has a "Download CSV" button. ',
      'User Activity has manual-entry columns; values you type there persist while this ',
      'tab is open and are included in that section\'s CSV download.'
    )
  ));

  const viewerHost = h('div', { class: 'body-section bpa-viewer-host' });
  frame.appendChild(viewerHost);

  const newRunBtn = h('button', { class: 'btn btn-secondary' }, 'New assessment');
  newRunBtn.addEventListener('click', () => {
    store.runResult = null;
    store.runError = null;
    store.runCancelled = false;
    store.annotations = {};
    navigate('/start');
  });
  frame.appendChild(h('div', { class: 'action-bar' },
    h('div', { class: 'left' }),
    h('div', { class: 'right' }, newRunBtn)
  ));
  container.appendChild(frame);

  const teardown = renderViewer({ root: viewerHost, store });
  return teardown;
}
