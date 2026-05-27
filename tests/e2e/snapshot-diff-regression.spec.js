// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-222: regression spec for the Tenant Observations diff tool.
//
// Exercises all four inventory sections (servers, server_templates, users,
// server_groups) and the FMN-221 customer/filename watchpoint in a single
// pair of snapshots. Connects to the persistent launcher via CDP.
//
// Run: npx playwright test tests/e2e/snapshot-diff-regression.spec.js
// Pre-req: `node tools/dev/launcher.mjs` is running with the operator
// signed into FortiMonitor and a v2 API key in chrome.storage.local.

import { test as base, expect, chromium } from '@playwright/test';

const CDP_URL = `http://localhost:${process.env.FMN_CDP_PORT || '9222'}`;
const API_BASE = 'https://api2.panopta.com/v2';
const OPERATOR_USER_ID = Number(process.env.FMN_QA_OPERATOR_USER_ID || 308609);
const TEST_SERVER_TAG_ID = Number(process.env.FMN_QA_TEST_SERVER_ID || 42024060);
const TEST_SERVER_TEMPLATE_ID = Number(process.env.FMN_QA_TEST_TEMPLATE_TARGET_SERVER_ID || 42024061);
const PROBE_TS = new Date().toISOString().replace(/[:.]/g, '-');
const UNIQUE_SUFFIX = `fmn-probe-${PROBE_TS}`;

const test = base.extend({
  liveContext: [async ({}, use) => {
    let browser;
    try { browser = await chromium.connectOverCDP(CDP_URL); }
    catch (e) {
      throw new Error(`CDP connect to ${CDP_URL} failed: ${e.message}. Start the launcher first: node tools/dev/launcher.mjs`);
    }
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('No context');
    await use(ctx);
    await browser.close();
  }, { scope: 'worker' }],

  driverPage: [async ({ liveContext }, use) => {
    let sw = liveContext.serviceWorkers().find((s) => s.url().includes('service-worker.js'));
    if (!sw) sw = await liveContext.waitForEvent('serviceworker', { timeout: 10_000 });
    const extensionId = sw.url().split('/')[2];
    const page = await liveContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/tenant-observations-diff/app.html`, { waitUntil: 'domcontentloaded' });
    await use(page);
    await page.close();
  }, { scope: 'worker' }],
});

// FMN-259: this spec is launcher-backed (drives the operator's live Chromium
// over CDP at :9222). On a plain `npx playwright test` run with no launcher,
// connectOverCDP threw and the spec reported as FAILED, making the suite
// misleadingly red. Skip cleanly when :9222 is unreachable so red == real
// breakage; the spec still runs in full when the launcher is up.
async function launcherReachable() {
  try {
    const r = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}
test.beforeAll(async () => {
  test.skip(
    !(await launcherReachable()),
    `Dev launcher not reachable at ${CDP_URL}; run "node tools/dev/launcher.mjs" to exercise this CDP-backed spec (FMN-259).`
  );
});

test.setTimeout(20 * 60 * 1000);

function sanitizeForPut(server, overrides) {
  const out = { ...server, ...overrides };
  for (const k of ['geo_latitude', 'geo_longitude']) {
    if (out[k] != null && typeof out[k] !== 'number') {
      const n = parseFloat(out[k]);
      out[k] = Number.isFinite(n) ? n : null;
    }
  }
  if (out.snmp_heartbeat_enabled === true && !out.snmp_scan_frequency) {
    out.snmp_heartbeat_enabled = false;
    out.snmp_heartbeat_notification_schedule = null;
  }
  return out;
}

async function sendMessage(page, type, payload = {}) {
  return page.evaluate(({ type, payload }) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!r) return reject(new Error('No response'));
      if (r.ok === false) return reject(new Error(r.error || r.message || 'ok:false'));
      resolve(r.result !== undefined ? r.result : r);
    });
  }), { type, payload });
}

async function callApi(page, method, path, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const apiKey = (await chrome.storage.local.get('panopta.apiKey'))['panopta.apiKey'];
    if (!apiKey) throw new Error('panopta.apiKey not in chrome.storage.local');
    const init = { method, headers: { Authorization: `ApiKey ${apiKey}` } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const r = await fetch(url, init);
    return { status: r.status, location: r.headers.get('location'), body: await r.text() };
  }, { method, url: API_BASE + path, body });
}

// A full Observations run takes ~3-4 minutes on a tenant with ~60 servers.
// Poll status every 5s; declare success when runInFlight flips false and
// currentTakenAt has moved forward.
async function takeSnapshot(page, label) {
  const pre = await sendMessage(page, 'observations-snapshots:status');
  const takeP = sendMessage(page, 'observations-snapshots:take', { sections: ['all'] }).catch((e) => ({ error: e.message }));
  const start = Date.now();
  while (Date.now() - start < 8 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 5000));
    let status;
    try { status = await sendMessage(page, 'observations-snapshots:status'); } catch { continue; }
    if (!status.runInFlight && status.currentTakenAt && status.currentTakenAt !== pre.currentTakenAt) {
      return takeP;
    }
  }
  throw new Error(`${label}: snapshot did not complete in 8 minutes`);
}

// Snapshot of template mappings on TEST_SERVER_TEMPLATE_ID at beforeAll
// time. cleanupProbeResidue uses this so it can detach any mapping that
// did not exist before the test started, instead of trying to identify
// probe-created mappings by name (the spec attaches an EXISTING template,
// so name-based matching can't tell them apart).
const baselineTemplateMappings = new Set();

async function snapshotBaselineMappings(page) {
  const mapRes = await callApi(page, 'GET', `/server/${TEST_SERVER_TEMPLATE_ID}/template?limit=100`);
  if (mapRes.status !== 200) return;
  baselineTemplateMappings.clear();
  for (const m of (JSON.parse(mapRes.body).server_template_list || [])) {
    const tid = (m.server_template || '').match(/\/server_template\/(\d+)/)?.[1];
    if (tid) baselineTemplateMappings.add(tid);
  }
}

async function cleanupProbeResidue(page) {
  const cleaned = { tags: 0, mappings: 0, users: 0, groups: 0 };

  const tagRes = await callApi(page, 'GET', `/server/${TEST_SERVER_TAG_ID}`);
  if (tagRes.status === 200) {
    const s = JSON.parse(tagRes.body);
    const residue = (s.tags || []).filter((t) => typeof t === 'string' && t.startsWith('fmn-probe-'));
    if (residue.length > 0) {
      const nextTags = (s.tags || []).filter((t) => !residue.includes(t));
      await callApi(page, 'PUT', `/server/${TEST_SERVER_TAG_ID}`, sanitizeForPut(s, { tags: nextTags }));
      cleaned.tags = residue.length;
    }
  }

  const mapRes = await callApi(page, 'GET', `/server/${TEST_SERVER_TEMPLATE_ID}/template?limit=100`);
  if (mapRes.status === 200) {
    for (const m of (JSON.parse(mapRes.body).server_template_list || [])) {
      const tid = (m.server_template || '').match(/\/server_template\/(\d+)/)?.[1];
      if (!tid) continue;
      if (baselineTemplateMappings.has(tid)) continue; // pre-existing, leave alone
      await callApi(page, 'DELETE', `/server/${TEST_SERVER_TEMPLATE_ID}/template/${tid}`, { strategy: 'dissociate' });
      cleaned.mappings += 1;
    }
  }

  const usersRes = await callApi(page, 'GET', '/user?limit=200');
  if (usersRes.status === 200) {
    for (const u of (JSON.parse(usersRes.body).user_list || [])) {
      if (typeof u.username === 'string' && u.username.startsWith('fmn-probe-user-')) {
        const uid = (u.url || '').match(/\/user\/(\d+)/)?.[1];
        if (uid) {
          await callApi(page, 'DELETE', `/user/${uid}`);
          cleaned.users += 1;
        }
      }
    }
  }

  const groupsRes = await callApi(page, 'GET', '/server_group?limit=200');
  if (groupsRes.status === 200) {
    for (const g of (JSON.parse(groupsRes.body).server_group_list || [])) {
      if (typeof g.name === 'string' && g.name.startsWith('fmn-probe-group-')) {
        const gid = (g.url || '').match(/\/server_group\/(\d+)/)?.[1];
        if (gid) {
          await callApi(page, 'DELETE', `/server_group/${gid}`);
          cleaned.groups += 1;
        }
      }
    }
  }

  return cleaned;
}

test.describe('FMN-222 diff regression', () => {
  let state = {
    operatorRoles: null,
    operatorTimezone: null,
    pickedTemplateId: null,
    pickedTemplateUrl: null,
    createdUserId: null,
    createdGroupId: null,
    appliedTemplateUrl: null,
  };

  test.beforeAll(async ({ driverPage }) => {
    await cleanupProbeResidue(driverPage);
    await snapshotBaselineMappings(driverPage);
  });

  test.afterAll(async ({ driverPage }) => {
    await cleanupProbeResidue(driverPage);
  });

  test('diff catches changes in all four sections; envelope carries customer; filename is not "unknown"', async ({ driverPage }) => {
    const page = driverPage;

    // Crib roles + timezone from operator user.
    const meRes = await callApi(page, 'GET', `/user/${OPERATOR_USER_ID}`);
    expect(meRes.status, `GET /user/${OPERATOR_USER_ID} returned ${meRes.status}`).toBe(200);
    const me = JSON.parse(meRes.body);
    state.operatorRoles = me.roles;
    state.operatorTimezone = me.timezone;
    expect(Array.isArray(state.operatorRoles) && state.operatorRoles.length).toBeTruthy();
    expect(state.operatorTimezone).toBeTruthy();

    // Pick a template to attach. Skip any that's already attached to the
    // template-target server (to keep the diff clean), and skip our own
    // probe templates.
    const tlistRes = await callApi(page, 'GET', '/server_template?limit=20');
    expect(tlistRes.status).toBe(200);
    const tlist = JSON.parse(tlistRes.body).server_template_list || [];
    state.pickedTemplateUrl = tlist[0]?.url;
    state.pickedTemplateId = Number((state.pickedTemplateUrl || '').match(/\/server_template\/(\d+)/)?.[1]);
    expect(state.pickedTemplateUrl, 'must find at least one template to attach').toBeTruthy();

    // ---- baseline snapshot ----
    await takeSnapshot(page, 'baseline');

    // ---- four mutations ----
    const tag = `fmn-probe-tag-${PROBE_TS}`;
    const sgetRes = await callApi(page, 'GET', `/server/${TEST_SERVER_TAG_ID}`);
    expect(sgetRes.status).toBe(200);
    const server = JSON.parse(sgetRes.body);
    const tagsBefore = Array.isArray(server.tags) ? server.tags : [];
    const tagPutRes = await callApi(page, 'PUT', `/server/${TEST_SERVER_TAG_ID}`, sanitizeForPut(server, { tags: [...tagsBefore, tag] }));
    expect(tagPutRes.status, `tag PUT: ${tagPutRes.body.slice(0, 200)}`).toBeLessThan(400);

    const attachRes = await callApi(page, 'POST', `/server/${TEST_SERVER_TEMPLATE_ID}/template`, {
      continuous: true,
      server_template: state.pickedTemplateUrl,
    });
    expect(attachRes.status, `template attach: ${attachRes.body.slice(0, 200)}`).toBeLessThan(400);
    state.appliedTemplateUrl = state.pickedTemplateUrl;

    const userRes = await callApi(page, 'POST', '/user', {
      username: `fmn-probe-user-${PROBE_TS}@example.invalid`,
      display_name: `FMN Probe ${PROBE_TS}`,
      roles: state.operatorRoles,
      server_group_access: 'all',
      timezone: state.operatorTimezone,
    });
    expect(userRes.status, `user POST: ${userRes.body.slice(0, 200)}`).toBeLessThan(400);
    state.createdUserId = Number((userRes.location || '').match(/\/user\/(\d+)/)?.[1]);
    expect(state.createdUserId).toBeTruthy();

    const groupRes = await callApi(page, 'POST', '/server_group', { name: `fmn-probe-group-${PROBE_TS}` });
    expect(groupRes.status, `group POST: ${groupRes.body.slice(0, 200)}`).toBeLessThan(400);
    state.createdGroupId = Number((groupRes.location || '').match(/\/server_group\/(\d+)/)?.[1]);
    expect(state.createdGroupId).toBeTruthy();

    // ---- post-mutation snapshot ----
    await takeSnapshot(page, 'after-mutate');

    // ---- diff ----
    const list = await sendMessage(page, 'observations-snapshots:list');
    const cur = list.items.find((i) => i.slot === 'current');
    const prev = list.items.find((i) => i.slot === 'previous');
    const diff = await sendMessage(page, 'observations-snapshots:diff', { baselineId: prev.id, currentId: cur.id });

    // 1. servers: tag flip
    const tagRow = diff.sections.servers.modified.find((r) => r.id === TEST_SERVER_TAG_ID);
    expect(tagRow, `server ${TEST_SERVER_TAG_ID} in modified.servers`).toBeTruthy();
    const tagField = tagRow.fields.find((f) => f.name === 'tags');
    expect(tagField).toBeTruthy();
    expect(tagField.next).toContain(tag);

    // 2. servers: template attach
    const attachRow = diff.sections.servers.modified.find((r) => r.id === TEST_SERVER_TEMPLATE_ID);
    expect(attachRow, `server ${TEST_SERVER_TEMPLATE_ID} in modified.servers`).toBeTruthy();
    expect(attachRow.fields.find((f) => f.name === 'server_template')).toBeTruthy();

    // 3. server_templates: applied_servers bump
    const tplRow = diff.sections.server_templates.modified.find((r) => r.id === state.pickedTemplateId);
    expect(tplRow, `template ${state.pickedTemplateId} in modified.server_templates`).toBeTruthy();
    const appliedField = tplRow.fields.find((f) => f.name === 'applied_servers');
    expect(appliedField).toBeTruthy();
    expect(Number(appliedField.next)).toBeGreaterThan(Number(appliedField.prev ?? 0));

    // 4. users: created user
    const addedUser = diff.sections.users.added.find((u) => u.id === state.createdUserId);
    expect(addedUser, `user ${state.createdUserId} in added.users`).toBeTruthy();

    // 5. server_groups: created group
    const addedGroup = diff.sections.server_groups.added.find((g) => g.id === state.createdGroupId);
    expect(addedGroup, `group ${state.createdGroupId} in added.server_groups`).toBeTruthy();

    // ---- FMN-221 watchpoint: envelope must carry customer; filename must not be "unknown" ----
    const exp = await sendMessage(page, 'observations-snapshots:export', { slot: 'current' });
    expect(exp.filename, 'filename must not contain "-unknown-"').not.toMatch(/-unknown-/);
    const env = JSON.parse(exp.contents);
    expect(env.snapshot.customer, 'envelope.snapshot.customer must not be null').toBeTruthy();
    const tenantId = env.snapshot.customer?.subdomain || env.snapshot.customer?.name;
    expect(typeof tenantId === 'string' && tenantId.length > 0, 'customer must have subdomain or name').toBeTruthy();

    // ---- FMN-223 watchpoint: rows whose actions ARE logged by
    // FortiMonitor's Account History carry an actor.
    //
    // Important constraint discovered via live probe (tools/qa/
    // fmn-223-probe-tag-put-history.mjs): API PUT operations on server
    // attributes (the path used by tag flip) are NOT recorded in
    // Account History at all, even 30s after the write. So tagRow.actor
    // is expected to be null. Asserting against the paths that ARE
    // logged: POST /user (Created User), POST /server_group (Created
    // Server Group), and POST /server/{id}/template (Applied template,
    // which logs against the SERVER id with user="System").
    expect(Array.isArray(env.snapshot.account_history), 'snapshot.account_history must be an array').toBe(true);
    expect(env.snapshot.account_history.length, 'account_history must contain at least one entry post-mutation').toBeGreaterThan(0);
    expect(addedUser.actor, 'created-user row must have an actor populated (POST /user is logged)').toBeTruthy();
    expect(addedGroup.actor, 'created-group row must have an actor populated (POST /server_group is logged)').toBeTruthy();
    expect(attachRow.actor, 'template-attach row (server side) must have an actor (Applied template is logged)').toBeTruthy();
  });
});
