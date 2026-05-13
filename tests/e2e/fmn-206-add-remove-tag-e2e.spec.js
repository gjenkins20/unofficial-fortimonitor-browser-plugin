// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-206 follow-up: end-to-end exercise of Add Tag + Remove Tag through
// the Bulk Composer wizard using the operator's actual 50-line paste from
// the live QA session.
//
// The spec stubs the three SW handlers the wizard hits along the way:
//   - omni-search:query      (pick step: name -> {id, tags, ...})
//   - bulk-composer:list-tags-batch (configure step: live tag refresh)
//   - bulk-composer:commit   (commit step: returns final result + emits
//                             per-row events that drive the UI)
//
// Stubs model the real tenant from the 17:50 / 18:09 / 18:27 HARs:
// 17 real instance IDs resolved by omni-search, 5 bogus numeric IDs (404),
// a deduped duplicate, plus a sea of synthetic / template / OS-label
// entries that the resolver correctly silently drops.
//
// Run: npx playwright test tests/e2e/fmn-206-add-remove-tag-e2e.spec.js

import { test, expect } from './fixtures.js';

// ---------- the operator's 50-line paste ----------
const PASTE = [
  '41954598', 'yahoo.com', 'redhat_lab_01', 'Phantom-FGT-Alpha', 'Linux',
  '41954597', 'Linux', '12345', 'ubuntu_custom_metric_lab-01', 'Windows',
  'Windows', 'Test-Decoy-2026', 'server', 'Server_template',
  'ip-172-31-15-241.us-east-2.compute.internal', 'Test_Network_Device_Template',
  'Bogus-Server-77', 'ubuntu_bastion-01', 'ProjectY-DashboardTemplate',
  'ProjectY-Template01', '88888888', 'Google_DNS_Secondary', 'www.slack.com',
  'Ghost-Probe-13', 'OnSight', 'test_instance_for_moving',
  'ip-10-0-0-164.us-east-2.compute.internal',
  'ip-172-31-9-170.us-east-2.compute.internal', 'NotReal-Switch-9',
  'unknown-router-77', 'ubuntu_bastion-01',
  'ip-172-31-15-137.us-east-2.compute.internal', 'ubuntu_onsight_permanent-01',
  '42157265', 'fake.example.local', 'SQL_Server_01', 'teams.microsoft.com',
  'Test_Fabric_Template', '99999999', 'Lost-Cause-VM',
  'Test_Template_for_Compound_Metric', 'FGT-Branch-Z',
  'ip-172-31-2-137.us-east-2.compute.internal', '41621101', 'mixed-CASE-Fake',
  '42157266', 'TestFabricTemplate', 'www.office.com', 'TYPO-FGVM01TM2400684',
  'FAKE-Device-001'
].join('\n');

// ---------- the resolver's view of the world ----------
// 17 names that resolve in the omni-search cache, modeled after the
// operator's tenant (each with their pre-test tag list).
const RESOLVED_NAMES = {
  'yahoo.com': { id: 41621101, tags: ['network device'] },
  'redhat_lab_01': { id: 41913986, tags: ['10.0', 'Linux', 'Red Hat Enterprise Linux', 'nginx'] },
  'ubuntu_custom_metric_lab-01': { id: 41914149, tags: ['24.04', 'Linux', 'Ubuntu'] },
  'server': { id: 43859419, tags: ['26.04', 'Linux', 'Ubuntu'] },
  'ip-172-31-15-241.us-east-2.compute.internal': { id: 40234478, tags: ['Linux'] },
  'ubuntu_bastion-01': { id: 41837377, tags: ['EC2', 'aws', 'ec2', 't2.micro', 'ubuntu_bastion-01', 'us-east-2', 'us-east-2a'] },
  'Google_DNS_Secondary': { id: 42780332, tags: ['DEM', 'DNS', 'Google', 'mass-application-test', 'network device'] },
  'www.slack.com': { id: 42157266, tags: ['Application', 'DEM'] },
  'test_instance_for_moving': { id: 41515418, tags: ['network device'] },
  'ip-10-0-0-164.us-east-2.compute.internal': { id: 41961014, tags: ['EC2', 'aws', 'ec2', 't2.large', 'us-east-2', 'us-east-2a'] },
  'ip-172-31-9-170.us-east-2.compute.internal': { id: 40234446, tags: ['Linux'] },
  'ip-172-31-15-137.us-east-2.compute.internal': { id: 40234449, tags: ['Linux'] },
  'ubuntu_onsight_permanent-01': { id: 41915254, tags: ['EC2', 'aws', 'ec2', 't2.micro', 'ubuntu_onsight_permanent-01', 'us-east-2', 'us-east-2a'] },
  'SQL_Server_01': { id: 41954251, tags: ['network device'] },
  'teams.microsoft.com': { id: 42157267, tags: ['Application', 'DEM'] },
  'ip-172-31-2-137.us-east-2.compute.internal': { id: 40234471, tags: ['Linux', 'aws', 't2.micro', 'us-east-2', 'us-east-2a'] },
  'www.office.com': { id: 42157265, tags: ['Application', 'DEM'] }
};

// 3 numeric IDs that already exist in the paste as numeric and should
// resolve to real instances via /v2/server (NOT the omni-search cache;
// numeric IDs skip name resolution).
const NUMERIC_REAL = {
  41621101: { tags: ['network device'] },
  42157265: { tags: ['Application', 'DEM'] },
  42157266: { tags: ['Application', 'DEM'] }
};

// 5 numeric IDs that don't exist on the tenant -> 404.
const BOGUS_IDS = new Set([41954598, 41954597, 12345, 88888888, 99999999]);

const EXPECTED_PROCESSED_IDS = [
  ...Object.values(RESOLVED_NAMES).map((v) => v.id),
  ...BOGUS_IDS
];
// dedupe (yahoo.com, 41621101 both map to the same id, etc.)
const EXPECTED_UNIQUE_IDS = Array.from(new Set(EXPECTED_PROCESSED_IDS));

// ---------- stub installer ----------

async function installStubs(page, { mode, testTag, removedCount }) {
  await page.addInitScript(() => {
    window.__fmn206E2EListeners = [];
    const installListenerWrap = () => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return false;
      const orig = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
      chrome.runtime.onMessage.addListener = (cb) => {
        window.__fmn206E2EListeners.push(cb);
        return orig(cb);
      };
      return true;
    };
    if (!installListenerWrap()) {
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        set(v) {
          Object.defineProperty(window, 'chrome', { configurable: true, writable: true, value: v });
          installListenerWrap();
        }
      });
    }
  });
}

async function installSendMessageStub(page, { resolvedByLower, numericReal, bogusIds, testTag, mode }) {
  await page.evaluate(({ resolvedByLower, numericReal, bogusIds, testTag, mode }) => {
    window.__fmn206E2EState = { resolvedByLower, numericReal, bogusIds, testTag, mode };

    const original = chrome.runtime.sendMessage.bind(chrome.runtime);

    chrome.runtime.sendMessage = function (msg, cb) {
      const type = msg && msg.type;
      const payload = msg && msg.payload;
      const state = window.__fmn206E2EState;

      // ---- pick step: name resolution
      if (type === 'omni-search:query') {
        const q = String(payload?.query ?? '').toLowerCase();
        const hit = state.resolvedByLower[q];
        const matches = hit ? [{
          id: hit.id,
          name: hit.name,
          tags: hit.tags
        }] : [];
        if (typeof cb === 'function') cb({ ok: true, result: { query: q, total: matches.length, matches } });
        return undefined;
      }

      // ---- configure step: live tag refresh
      if (type === 'bulk-composer:list-tags-batch') {
        const ids = Array.isArray(payload?.serverIds) ? payload.serverIds : [];
        const byServerId = {};
        for (const id of ids) {
          const n = Number(id);
          if (state.bogusIds.includes(n)) {
            byServerId[n] = null;
            continue;
          }
          if (state.numericReal[n]) {
            byServerId[n] = state.numericReal[n].tags.slice();
            continue;
          }
          // For IDs resolved-from-name: find their tag list
          const match = Object.values(state.resolvedByLower).find((v) => v.id === n);
          byServerId[n] = match ? match.tags.slice() : null;
        }
        if (typeof cb === 'function') cb({ ok: true, result: { byServerId } });
        return undefined;
      }

      // ---- commit step: synthesize per-row results
      if (type === 'bulk-composer:commit') {
        const targets = Array.isArray(payload?.targets) ? payload.targets : [];
        const actionId = payload?.actionId;
        const tag = payload?.params?.tag ?? state.testTag;
        const rows = [];
        let succeeded = 0, failed = 0, noops = 0;

        // Fire row-start + row-done events through the captured listeners.
        // The wizard's commit step listens for these and paints rows in real time.
        const fire = (event, data) => {
          for (const lcb of window.__fmn206E2EListeners) {
            lcb({ type: '__event__', event, payload: data });
          }
        };

        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          const id = Number(t.id);
          fire('bulk-composer:row-start', { index: i, id: t.id, name: t.name });

          // FMN-207: chip-fetch returned null tags for bogus IDs ->
          // action.commit short-circuits to skipped without an API call.
          // The SW emits succeeded + noop = "skip" in the UI.
          if (t.tags === null || t.tags === undefined) {
            const skipPayload = {
              index: i, id: t.id, name: t.name,
              status: 'succeeded', noop: true,
              detail: { skipped: true, status: 0 }
            };
            fire('bulk-composer:row-done', skipPayload);
            rows.push(skipPayload);
            noops++;
            continue;
          }

          // Real instance: determine if Add/Remove would be a no-op.
          const tagsBefore = (state.numericReal[id]?.tags
            || Object.values(state.resolvedByLower).find((v) => v.id === id)?.tags
            || []).slice();
          const has = tagsBefore.includes(tag);

          let tagsAfter, noop;
          if (actionId === 'add-tag') {
            noop = has;
            tagsAfter = noop ? tagsBefore : tagsBefore.concat([tag]);
          } else {
            // remove-tag
            noop = !has;
            tagsAfter = noop ? tagsBefore : tagsBefore.filter((t) => t !== tag);
          }

          const donePayload = {
            index: i, id: t.id, name: t.name,
            status: 'succeeded',
            noop,
            detail: { tagsBefore, tagsAfter, noop, status: 200 }
          };
          fire('bulk-composer:row-done', donePayload);
          rows.push(donePayload);
          if (noop) noops++; else succeeded++;
        }

        const result = {
          actionId,
          params: payload?.params,
          rows,
          startedAt: new Date(Date.now() - 2000).toISOString(),
          finishedAt: new Date().toISOString(),
          aborted: false,
          succeeded, failed, noops
        };
        if (typeof cb === 'function') cb({ ok: true, result });
        return undefined;
      }

      return original(msg, cb);
    };
  }, { resolvedByLower, numericReal, bogusIds, testTag, mode });
}

// ---------- spec ----------

const TEST_TAG = 'fmn-206-e2e';

test.describe('FMN-206 e2e: Add Tag then Remove Tag with the operator 50-line paste', () => {
  test('Add Tag run produces correct row counts and clean error wording', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();

    await installStubs(page, { mode: 'add' });
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    // Build the lower-cased name map matching pick.js's exact-case-insensitive matcher.
    const resolvedByLower = {};
    for (const [name, info] of Object.entries(RESOLVED_NAMES)) {
      resolvedByLower[name.toLowerCase()] = { id: info.id, name, tags: info.tags };
    }
    await installSendMessageStub(page, {
      resolvedByLower,
      numericReal: NUMERIC_REAL,
      bogusIds: Array.from(BOGUS_IDS),
      testTag: TEST_TAG,
      mode: 'add'
    });

    // ---- Pick step: paste the 50 lines.
    await page.locator('textarea.paste-area').fill(PASTE);

    // Parse + resolve runs async; wait for the parse-result to land. After
    // resolution the headline says "N instances ready". Expected N is 22
    // (17 unique resolved names + 5 bogus numerics; numeric duplicates of
    // resolved names collapse).
    await expect(page.locator('.parse-result .headline')).toContainText('instances ready', { timeout: 15_000 });
    const headline = await page.locator('.parse-result .headline').textContent();
    const headlineCount = Number(headline.match(/^(\d+)/)?.[1] ?? 0);
    // Expect 22 (the same row count the operator saw on the live tenant).
    expect(headlineCount).toBe(22);

    await page.locator('[data-test="pick-next"]').click();
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('2. Pick action', { timeout: 5000 });

    // ---- Action step: Add Tag.
    await page.locator('[data-test="action-card"][data-action-id="add-tag"]').click();
    await page.locator('[data-test="action-next"]').click();
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('3. Configure', { timeout: 5000 });

    // ---- Configure step: type the test tag.
    await page.locator('[data-test="configure-tag-input"]').fill(TEST_TAG);
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();
    await page.locator('[data-test="configure-next"]').click();
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('4. Preview', { timeout: 5000 });

    // ---- Commit: 22 rows queued; 17 should commit, 5 should fail with 404.
    await expect(page.locator('[data-test="bulk-preview-row"]')).toHaveCount(22);
    await page.locator('[data-test="apply-btn"]').click();

    await expect(page.locator('[data-test="bulk-run-summary"]')).toContainText('22/22 complete', { timeout: 10_000 });
    await expect(page.locator('[data-test="bulk-run-summary"]')).toContainText('17 committed');
    await expect(page.locator('[data-test="bulk-run-summary"]')).toContainText('0 failed');
    await expect(page.locator('[data-test="bulk-run-summary"]')).toContainText('5 skipped');

    // Bogus IDs render as "skip" in the preview (FMN-207), not WILL CHANGE.
    // Check one of them carries the "Instance not found" preview note.
    const skipDetail = page.locator('[data-test="bulk-preview-detail-text"]').filter({ hasText: 'Instance not found' }).first();
    await expect(skipDetail).toContainText('Instance not found on this tenant; will skip.');

    await page.close();
  });

  test('Remove Tag run cleans up the tag we just added; bogus IDs skip', async ({ extensionContext, extensionId }) => {
    const page = await extensionContext.newPage();

    await installStubs(page, { mode: 'remove' });
    await page.goto(`chrome-extension://${extensionId}/src/ui/bulk-composer/app.html#/pick`);

    // Build the resolver map BUT with the test tag pre-applied to every
    // resolved instance, simulating the post-Add-Tag state.
    const resolvedByLower = {};
    for (const [name, info] of Object.entries(RESOLVED_NAMES)) {
      resolvedByLower[name.toLowerCase()] = {
        id: info.id, name,
        tags: [...info.tags, TEST_TAG]
      };
    }
    const numericRealWithTag = {};
    for (const [id, info] of Object.entries(NUMERIC_REAL)) {
      numericRealWithTag[id] = { tags: [...info.tags, TEST_TAG] };
    }

    await installSendMessageStub(page, {
      resolvedByLower,
      numericReal: numericRealWithTag,
      bogusIds: Array.from(BOGUS_IDS),
      testTag: TEST_TAG,
      mode: 'remove'
    });

    await page.locator('textarea.paste-area').fill(PASTE);
    await expect(page.locator('.parse-result .headline')).toContainText('instances ready', { timeout: 15_000 });

    await page.locator('[data-test="pick-next"]').click();
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('2. Pick action', { timeout: 5000 });

    await page.locator('[data-test="action-card"][data-action-id="remove-tag"]').click();
    await page.locator('[data-test="action-next"]').click();
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('3. Configure', { timeout: 5000 });

    // ---- Chip-fetch + render: the test tag should appear with count == 17
    // (every resolved instance has it; bogus IDs failed list-tags-batch and
    // don't contribute).
    const testTagChip = page.locator(`[data-test="existing-tag-chip"][data-tag="${TEST_TAG}"]`);
    await expect(testTagChip).toBeVisible({ timeout: 10_000 });
    await expect(testTagChip).toContainText(`×17`);

    await testTagChip.click();
    await expect(page.locator('[data-test="configure-tag-input"]')).toHaveValue(TEST_TAG);
    await expect(page.locator('[data-test="configure-next"]')).toBeEnabled();
    await page.locator('[data-test="configure-next"]').click();
    await expect(page.locator('.step-breadcrumbs .step.active')).toContainText('4. Preview', { timeout: 5000 });

    await expect(page.locator('[data-test="bulk-preview-row"]')).toHaveCount(22);
    await page.locator('[data-test="apply-btn"]').click();

    await expect(page.locator('[data-test="bulk-run-summary"]')).toContainText('22/22 complete', { timeout: 10_000 });
    await expect(page.locator('[data-test="bulk-run-summary"]')).toContainText('17 committed');
    await expect(page.locator('[data-test="bulk-run-summary"]')).toContainText('0 failed');
    await expect(page.locator('[data-test="bulk-run-summary"]')).toContainText('5 skipped');

    // Bogus IDs surface as skips with the "Instance not found" preview note.
    const skipDetail = page.locator('[data-test="bulk-preview-detail-text"]').filter({ hasText: 'Instance not found' }).first();
    await expect(skipDetail).toContainText('Instance not found on this tenant; will skip.');

    await page.close();
  });
});
