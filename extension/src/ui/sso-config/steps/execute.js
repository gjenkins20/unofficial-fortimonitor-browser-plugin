// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// SSO Configuration - Step 3 (Execute).
// Dry-run path: assemble the runbook + SP metadata XML, store on the
// run result, navigate to Results.
// Real-run path: blocked until FMN-138 (Discovery) captures the
// FortiMonitor SSO save endpoint. Surfaces a clear error.

import { h, titleBar } from '../../../lib/dom.js';
import { generateSpMetadata } from '../../../lib/saml-metadata.js';
import { buildOktaRunbook } from '../../../lib/sso-runbook.js';
import { ssoBreadcrumbs } from './start.js';

const TOOL_NAME = 'SSO Configuration (Okta IdP)';

export function render({ container, store, navigate }) {
  const frame = h('div', { class: 'mockup-frame' });
  frame.appendChild(titleBar('Execute', { toolName: TOOL_NAME }));

  frame.appendChild(h('div', { class: 'step-header' },
    ssoBreadcrumbs('execute'),
    h('h2', {}, store.dryRun ? 'Dry run' : 'Real run'),
    h('p', {}, store.dryRun
      ? 'Building the runbook and SP metadata XML. No request is sent to FortiMonitor.'
      : 'Saving the SSO configuration to FortiMonitor.'
    )
  ));

  const body = h('div', { class: 'body-section' });
  frame.appendChild(body);

  const status = h('div', { class: 'parse-result' });
  body.appendChild(status);

  const backBtn = h('button', { class: 'btn' }, 'Back');
  const footer = h('div', { class: 'step-footer' }, backBtn);
  frame.appendChild(footer);
  container.appendChild(frame);

  backBtn.addEventListener('click', () => navigate('/review'));

  // Run on mount.
  setTimeout(() => run(), 0);

  async function run() {
    status.className = 'parse-result running';
    status.textContent = store.dryRun ? 'Assembling artifacts...' : 'Saving to FortiMonitor...';

    try {
      const runbookMd = buildOktaRunbook({
        spEntityId: store.spEntityId,
        acsUrl: store.acsUrl,
        nameIdFormat: store.nameIdFormat,
        testLoginUrl: store.testLoginUrl || null,
        attributes: store.attributes,
        roleMapping: store.roleMapping,
        ssoMode: store.ssoMode,
        tenantLabel: store.tenantLabel || null
      });
      const spMetadataXml = generateSpMetadata({
        entityId: store.spEntityId,
        acsUrl: store.acsUrl,
        nameIdFormat: store.nameIdFormat,
        organization: store.tenantLabel ? { name: store.tenantLabel } : null
      });

      if (store.dryRun) {
        store.runResult = {
          ok: true,
          dryRun: true,
          message: 'Dry run complete. Artifacts ready to download in Results.',
          runbookMd,
          spMetadataXml
        };
        navigate('/results');
        return;
      }

      // Real run: blocked pending Discovery (FMN-138).
      throw new Error(
        'FortiMonitor SSO save endpoint not yet wired up. Discovery (FMN-138) is the prerequisite; until it lands, run the wizard with dry-run on, then save the artifacts. See the runbook for paste-into-FortiMonitor instructions.'
      );
    } catch (err) {
      status.className = 'parse-result error';
      status.textContent = err.message || String(err);
      store.runResult = {
        ok: false,
        dryRun: store.dryRun,
        message: err.message || String(err),
        runbookMd: null,
        spMetadataXml: null
      };
    }
  }
}
