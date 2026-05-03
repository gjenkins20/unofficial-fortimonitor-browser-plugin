// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SSO Configuration - Step 4 (Results).
// Renders the run outcome and provides downloads for the Okta admin runbook
// (Markdown) and the SP metadata XML for one-shot Okta import.

import { h, titleBar } from '../../../lib/dom.js';
import { ssoBreadcrumbs } from './start.js';

const TOOL_NAME = 'SSO Configuration (Okta IdP)';

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Results', { toolName: TOOL_NAME }));

  const result = store.runResult || { ok: false, message: 'No run result.' };
  const headlineClass = result.ok ? 'banner banner-ok' : 'banner banner-error';
  const headlineText = result.ok
    ? (result.dryRun ? 'Dry run complete' : 'Configuration saved')
    : 'Run failed';

  frame.appendChild(h('div', { class: 'step-header' },
    ssoBreadcrumbs('results'),
    h('h2', {}, headlineText),
    h('div', { class: headlineClass }, result.message || '')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  if (result.ok && result.runbookMd) {
    body.appendChild(h('h3', { class: 'subhead' }, 'Downloads'));
    body.appendChild(h('p', { class: 'help-text' },
      'Save the runbook for whoever sets up Okta; import the SP metadata XML on the Okta side instead of pasting fields one by one.'
    ));

    const downloads = h('div', { class: 'download-row' });
    downloads.appendChild(downloadButton(
      'Download Okta admin runbook (Markdown)',
      result.runbookMd,
      filename('okta-admin-runbook.md', store)
    ));
    downloads.appendChild(downloadButton(
      'Download SP metadata XML (Okta import)',
      result.spMetadataXml,
      filename('sp-metadata.xml', store),
      'application/xml'
    ));
    body.appendChild(downloads);

    body.appendChild(h('h3', { class: 'subhead' }, 'Runbook preview'));
    const preview = h('pre', { class: 'runbook-preview' });
    preview.textContent = result.runbookMd;
    body.appendChild(preview);
  }

  const backBtn = h('button', { class: 'btn' }, 'Back to Review');
  const restartBtn = h('button', { class: 'btn' }, 'Start over');
  const footer = h('div', { class: 'step-footer' }, backBtn, restartBtn);
  frame.appendChild(footer);
  container.appendChild(frame);

  backBtn.addEventListener('click', () => navigate('/review'));
  restartBtn.addEventListener('click', () => {
    store.runResult = null;
    navigate('/start');
  });
}

function downloadButton(label, content, filename, mime = 'text/markdown') {
  const btn = h('button', { class: 'btn primary' }, label);
  btn.addEventListener('click', () => {
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return btn;
}

function filename(suffix, store) {
  const base = (store.tenantLabel || 'fortimonitor')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base || 'fortimonitor'}-${suffix}`;
}
