// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SSO Configuration - Step 4 (Results).
// Renders the runbook outcome, offers a download, and shows a Markdown
// preview. The runbook is the only artifact: SP metadata XML for Okta
// import is intentionally not generated because FortiMonitor's SP-side
// values (ACS URL, SP Entity ID) are determined per tenant and only
// surface after the operator saves the FortiMonitor SSO config.

import { h, titleBar } from '../../../lib/dom.js';
import { ssoBreadcrumbs } from './okta.js';

const TOOL_NAME = 'Generate SSO Configuration';

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Results', { toolName: TOOL_NAME }));

  const result = store.runResult || { ok: false, message: 'No run result.' };
  const headlineClass = result.ok ? 'banner banner-ok' : 'banner banner-error';
  const headlineText = result.ok ? 'Runbook ready' : 'Generation failed';

  frame.appendChild(h('div', { class: 'step-header' },
    ssoBreadcrumbs('results'),
    h('h2', {}, headlineText),
    h('div', { class: headlineClass }, result.message || '')
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  if (result.ok && result.runbookMd) {
    body.appendChild(h('h3', { class: 'subhead' }, 'Download'));
    body.appendChild(h('p', { class: 'help-text' },
      'Save the runbook for whoever sets up Okta + FortiMonitor; it covers all four passes (Okta-side create, FortiMonitor-side configure, Okta-side update, test).'
    ));

    const downloads = h('div', { class: 'download-row' });
    downloads.appendChild(downloadButton(
      'Download runbook (Markdown)',
      result.runbookMd,
      filenameFor(store, 'sso-setup-runbook.md')
    ));
    const copyBtn = h('button', { class: 'btn' }, 'Copy to clipboard');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(result.runbookMd).catch(() => {});
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy to clipboard'; }, 1200);
    });
    downloads.appendChild(copyBtn);
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
  // No /start route anymore; restart goes back to /okta.
  restartBtn.addEventListener('click', () => {
    store.runResult = null;
    navigate('/okta');
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

function filenameFor(store, suffix) {
  const base = (store.tenantLabel || store.urlFragment || 'fortimonitor')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base || 'fortimonitor'}-${suffix}`;
}
