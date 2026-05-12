// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-155: Step 2 - pick the action card.
//
// v1 ships three actions: Add Tag, Remove Tag, Apply Template. Other
// actions in the FMN-155 ticket body (port scope, parent group,
// agent_resource status, maintenance) are phase-2 follow-ups.

import { h, titleBar } from '../../../lib/dom.js';
import { bulkBreadcrumbs } from './breadcrumbs.js';
import { listActions } from '../../../lib/bulk-actions/index.js';

const TOOL_NAME = 'Bulk Action Composer';

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Pick action', { toolName: TOOL_NAME, beta: true }));

  frame.appendChild(h('div', { class: 'step-header' },
    bulkBreadcrumbs('action'),
    h('h2', {}, `Pick an action to apply to ${store.targets.length} instance${store.targets.length === 1 ? '' : 's'}`),
    h('p', {}, 'v1 supports Add Tag, Remove Tag, and Apply Template. Each action requires a configured FortiMonitor v2 API key.')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const cards = h('div', {
    class: 'action-cards',
    'data-test': 'action-cards',
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:0.6rem;'
  });
  body.appendChild(cards);

  let chosenId = store.actionId;

  function renderCards() {
    cards.innerHTML = '';
    for (const action of listActions()) {
      const isChosen = action.id === chosenId;
      const card = h('button', {
        class: 'action-card',
        type: 'button',
        'data-test': 'action-card',
        'data-action-id': action.id,
        'aria-pressed': isChosen ? 'true' : 'false',
        style: `text-align:left;background:${isChosen ? 'var(--accent-soft, #fde9e0)' : 'white'};border:2px solid ${isChosen ? 'var(--accent)' : 'var(--border)'};border-radius:6px;padding:0.7rem 0.8rem;cursor:pointer;font-family:inherit;display:flex;flex-direction:column;gap:0.3rem;`
      },
        h('div', { style: 'font-weight:600;font-size:0.95rem;' }, action.label),
        h('div', { class: 'muted', style: 'font-size:0.8rem;color:var(--text-muted);line-height:1.3;' }, action.description),
        h('div', { class: 'muted', style: 'font-size:0.72rem;color:var(--text-muted);font-family:"SF Mono",Menlo,monospace;' }, `requires: ${action.requires} · ${action.writeMethod}`)
      );
      card.addEventListener('click', () => {
        chosenId = action.id;
        // If switching action, drop incompatible params.
        if (store.actionId !== action.id) store.params = {};
        store.actionId = action.id;
        renderCards();
        nextBtn.disabled = false;
      });
      cards.appendChild(card);
    }
  }
  renderCards();

  const backBtn = h('button', { class: 'btn btn-secondary', type: 'button' }, '← Back');
  const nextBtn = h('button', {
    class: 'btn btn-primary',
    'data-test': 'action-next',
    type: 'button',
    disabled: !chosenId
  }, 'Configure →');

  const actionBar = h('div', { class: 'action-bar' },
    h('div', { class: 'left' }, h('span', { class: 'execute-state muted' }, `${store.targets.length} instance${store.targets.length === 1 ? '' : 's'} chosen.`)),
    h('div', { class: 'right' }, backBtn, nextBtn)
  );
  frame.appendChild(actionBar);
  container.appendChild(frame);

  backBtn.addEventListener('click', () => navigate('/pick'));
  nextBtn.addEventListener('click', () => {
    if (!chosenId) return;
    navigate('/configure');
  });
}
