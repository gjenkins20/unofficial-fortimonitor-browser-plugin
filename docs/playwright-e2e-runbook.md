# Playwright E2E Runbook (FMN-116)

Handoff doc for setting up Playwright-based end-to-end testing of the
toolkit extension. Initial scope: Find Servers (FMN-114). Pattern should
generalise so other tools can be added incrementally.

This doc is **self-contained** so a fresh Claude session can drive the
work without prior chat context. Read it top to bottom before touching
any code.

---

## TL;DR

1. Playwright launches Chromium with `--load-extension=PATH/extension`.
2. The launched Chromium is not "another extension," so Chrome's
   cross-extension JS isolation does not apply. Tests can drive the
   toolkit's `chrome-extension://<id>/...` pages directly.
3. `page.addInitScript` stubs `chrome.runtime.sendMessage` before the
   tool's `app.js` loads, so tests are deterministic and do not need
   a real FortiMonitor tenant.
4. Tests live at `tests/e2e/` (repo root, NOT under `extension/`).
5. Plane ticket: **FMN-116**. Branch off
   `feature/fmn-114-search-servers-compound-filter` (NOT off `github/main`)
   because the unified Find Servers tool that the suite tests was
   introduced on FMN-114 and is not yet merged. When FMN-114 lands,
   rebase or merge FMN-116 forward. Push gated on operator approval.

---

## Why this work exists

`claude-in-chrome` (the MCP that lets a chat agent drive Chrome) cannot
inject JS into pages owned by a *different* extension. Chrome enforces
this at the browser level for security; it is not a flag-toggle. Live
E2E of our own extension via that MCP is therefore impossible.

Playwright sidesteps the rule because Playwright **is** the browser
controller, not a peer extension. It can drive any page Chrome can
load, including `chrome-extension://<our-id>/...`, by talking to
Chromium over the DevTools Protocol.

This rules out one approach (claude-in-chrome) and unblocks another
(Playwright). The synthetic-harness verification at
`docs/harnesses/find-servers.html` is unchanged: it covers logic but
not the live extension-host integration (real service worker, real
`chrome.runtime.sendMessage` plumbing, real popup wiring). Playwright
covers that gap with stubbed FortiMonitor data.

---

## Repository orientation (read these first)

- `CLAUDE.md` (project root): project conventions, Plane integration
  rules, verification-discipline rules. **Read in full before editing
  code.** Especially the verification-discipline section.
- `extension/`: the Manifest V3 extension code.
  - `extension/src/ui/server-search/`: the Find Servers tool (FMN-114).
    Three sections on `app.html`: identifiers paste, filter criteria
    stack, output column picker.
  - `extension/src/background/server-search-handlers.js`: the
    `search:servers` message handler with field-type dispatch and
    AND/OR mode.
- `docs/harnesses/find-servers.html`: synthetic harness with canned
  tenant fixtures. Port the canned data forward into Playwright tests.
- `docs/live-e2e-runbook.md`: pre-existing live E2E runbook for the
  Port Scope tool (older, manual). Different shape from this one;
  not a template.

---

## Plane / git conventions

- Plane workspace: `myrug`, project `FortiMonitor` (prefix `FMN`).
- Plane MCP tools available; this ticket is **FMN-116**.
- Required label on every ticket: `browser-plugin` (already on FMN-116).
- Branch naming: `feature/fmn-116-playwright-e2e-find-servers`.
- Branch off `github/main`. Two remotes exist (`github` is truth,
  `origin` is a NAS mirror) but for feature-branch pushes only `github`
  matters.
- Commit-then-QA workflow. Operator approves push explicitly per ticket.
  Push approval does not carry across tickets.
- **No em-dashes** (U+2014) anywhere: code, comments, docs, commit
  messages, PR descriptions. Use hyphens or restructure.
- Plane ticket stays In Progress until pushed. Move to Done only after
  operator approves a push. See the global rule in
  `~/.claude/projects/-Users-gregorijenkins-Projects-unofficial-fortimonitor-browser-plugin/memory/plane_done_requires_push.md`.

---

## Architecture: how the launched browser sees the extension

When Playwright launches Chromium with `--load-extension=PATH`, Chrome
generates an extension ID **per launch** based on a key derived from
the extension's directory. Two consequences:

1. The extension ID is not stable across machines or even sessions.
   Tests must discover it at runtime, not hard-code it.
2. The toolkit's service worker IS available in the launched browser,
   and `chrome.runtime.sendMessage` works as in production. We choose
   to stub it anyway for determinism.

### Discovering the extension ID at runtime

The launched Chromium starts a service worker for our extension. That
service worker's URL contains the extension ID. Playwright's
`browserContext.serviceWorkers()` (or waiting on `serviceworker` event)
exposes it.

```js
const sw = context.serviceWorkers()[0]
  ?? await context.waitForEvent('serviceworker');
const extensionId = sw.url().split('/')[2];
// "chrome-extension://EXT_ID/background/service-worker.js" -> EXT_ID
```

---

## Setting up Playwright

### Project structure

```
unofficial-fortimonitor-browser-plugin/
├── extension/            (existing extension code; do not move)
├── tests/
│   └── e2e/              (NEW)
│       ├── fixtures.js   (launch helper + canned tenant data)
│       ├── stubs.js      (chrome.runtime.sendMessage stub source)
│       ├── find-servers.spec.js
│       └── playwright.config.js
├── package.json          (NEW at repo root - see below)
└── ...
```

The repo currently has no `package.json` at the root; `extension/`
has one for the extension's own dev tooling. Adding a root-level
`package.json` for Playwright is fine. Do not move or alter the
existing `extension/package.json`.

### Initial setup commands

From the repo root:

```bash
npm init -y
npm i -D @playwright/test
npx playwright install chromium
```

### Launch helper (`tests/e2e/fixtures.js`)

The key trick is `chromium.launchPersistentContext` (not `launch`),
which is the only Playwright launcher that supports `--load-extension`.
You must use a real user-data-dir; pass a temp dir.

```js
import { test as base, chromium, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const EXTENSION_PATH = path.resolve(__dirname, '../../extension');

export const test = base.extend({
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmtoolkit-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,                 // MV3 service workers do not run headless reliably
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`
      ]
    });
    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const id = sw.url().split('/')[2];
    await use(id);
  }
});

export { expect };
```

Notes:
- **Headless does not work** for MV3 extensions in current Chromium
  builds. Run headed. CI will need an Xvfb-style display when we
  eventually wire it up.
- The temp `userDataDir` is critical: Playwright's default in-memory
  context cannot host extensions.
- `serviceWorkers()` may be empty on first read if the worker has not
  yet woken up; the `waitForEvent` fallback covers that race.

### Stub script (`tests/e2e/stubs.js`)

Same structure as `docs/harnesses/find-servers.html` but exported as
a string for `page.addInitScript`. Port the canned tenant data
verbatim, then export as:

```js
export const findServersStubScript = `
  (function () {
    const SUGGESTIONS = [/* ... port from harness ... */];
    const DEVICE_TYPES = [/* ... */];
    const SERVERS = [/* ... */];
    const ACTIVE_OUTAGE_IDS = new Set([1003]);

    // matchOne, matchesByCriteria, shape, classifyId helpers
    // (port verbatim from harness STUBS block; the harness has them inline)

    const messageListeners = new Set();
    const _origRuntime = window.chrome?.runtime;
    window.chrome = window.chrome || {};
    window.chrome.runtime = {
      ..._origRuntime,
      id: 'harness-extension-id',
      sendMessage: function (message, callback) {
        // ... same dispatch as harness ...
      },
      onMessage: {
        addListener: (fn) => messageListeners.add(fn),
        removeListener: (fn) => messageListeners.delete(fn)
      }
    };
  })();
`;
```

The stub script must run **before** the tool's `app.js` module loads.
Use `page.addInitScript` for that ordering guarantee.

### Test file (`tests/e2e/find-servers.spec.js`)

```js
import { test, expect } from './fixtures.js';
import { findServersStubScript } from './stubs.js';

test.describe('Find Servers (FMN-114) E2E', () => {
  test('Scenario 1: criteria-only AND - tag=production AND OS contains Windows', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.addInitScript(findServersStubScript);
    await page.goto(`chrome-extension://${extensionId}/src/ui/server-search/app.html#/start`);

    // Drive the UI: pick fieldType=tag in row 1, type "production", exact ON.
    // Click "+ Add criterion". Pick fieldType=attribute in row 2, type
    // "Operating System", value "Windows", exact OFF. Click Run search.
    // Assert the results table has 2 rows with ids 1001 and 1002.

    // (Implementation: prefer page.getByRole / page.getByLabel; fall back
    //  to specific selectors only when role-based queries are
    //  unavailable. See start.js for the actual DOM structure.)

    await expect(page.locator('.body-section table tbody tr')).toHaveCount(2);
  });

  // Scenario 2: OR mode with has_active_outage
  // Scenario 3: identifiers-only
  // Scenario 4: identifiers + filter intersection
});
```

### Playwright config (`tests/e2e/playwright.config.js`)

```js
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,    // extension launches are heavy; serialize
  retries: 0,
  reporter: [['list']],
  use: {
    actionTimeout: 5_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
```

### npm script

In root `package.json`:

```json
"scripts": {
  "test:e2e": "playwright test --config tests/e2e/playwright.config.js"
}
```

---

## The four scenarios to implement

Mirror the synthetic harness scenarios. Canned tenant data lives in
`docs/harnesses/find-servers.html` (the `STUBS` block; port forward).

| # | Scenario | Inputs | Expected matches |
|---|----------|--------|------------------|
| 1 | criteria-only AND | Tag = production (exact), OS contains Windows | 1001, 1002 |
| 2 | criteria-only OR with `has_active_outage` | Tag = production OR has_active_outage = true | 1001, 1002, 1003, 1004 |
| 3 | identifiers-only | identifiers `1001\n1002` | 1001, 1002 |
| 4 | identifiers + filter intersection | ids `1001\n1002\n1003`, filter Tag = production | 1001, 1002 (1003 excluded) |

Each scenario also exercises a piece of the column picker. Suggested:

- Scenario 1 ticks Status + Tags
- Scenario 2 ticks Tags + Source
- Scenario 4 adds an attribute column (e.g. `Operating System`)

CSV download verification: capture the `download` event with
`page.on('download', ...)` and assert the saved file contents have the
expected header row and per-row data.

---

## Common pitfalls and how to handle them

1. **Headless = false is mandatory.** MV3 service workers do not
   register reliably under headless Chromium. Tests will hang on
   `waitForEvent('serviceworker')`. Run headed; if CI needs it, wrap
   with Xvfb.

2. **`addInitScript` must be set BEFORE `goto`.** Setting it after the
   page navigates is too late: the tool's app.js has already imported
   `messaging.js` and captured the original `chrome.runtime`.

3. **The tool's `app.js` is an ES module.** Playwright's
   `addInitScript` runs in a non-module context. The stub still works
   because it patches `window.chrome` before any module evaluates.

4. **Service worker may go to sleep.** MV3 service workers idle out
   after about 30 seconds. If a test pauses too long, the next message
   dispatch may need to wake the worker. Either keep tests fast or fire
   a no-op message on resume.

5. **Cross-test isolation.** Each test should `context.newPage()` and
   close it. Do not share pages between tests; the extension's
   `chrome.storage.session` carries state that can leak.

6. **Don't share the launched context across worker processes.** The
   Playwright config above forces `fullyParallel: false`. Each test
   runs in series in one worker. If you must parallelise later,
   give each worker its own user-data-dir.

7. **Operator's actual extension ID is not yours.** Anything in this
   project that mentions a specific `chrome-extension://...` URL
   (e.g. earlier QA notes) is from the operator's installation, not
   yours. Always discover the ID at runtime.

---

## Verification discipline

This project takes the verification rules in `CLAUDE.md` seriously.
Specifically:

- "Complete" is a reserved word; do not use it until tests are green
  and you have evidence to show.
- UI changes need either live verification, synthetic-harness
  verification, or an explicit `NOT VERIFIED IN BROWSER` disclosure.
  Playwright counts as live verification once the suite passes.
- Flaky MCP tools require **three retries** before being declared
  unavailable. The same applies to Playwright launches if you see
  spurious failures.

---

## Deliverables for FMN-116

1. `tests/e2e/` directory with `fixtures.js`, `stubs.js`,
   `find-servers.spec.js`, and `playwright.config.js`.
2. Root `package.json` with `playwright` dev-dep and `test:e2e` script.
3. Four scenarios passing on a clean checkout.
4. Brief README at `tests/e2e/README.md` (or a section in this doc)
   noting any deviations and how to add a new scenario.
5. Plane comment on FMN-116 with the commit hash + test output.

---

## Out of scope for FMN-116

- Tests for tools other than Find Servers (port-scope, manage-templates,
  manage-attributes, server-lookup, etc.). Add coverage incrementally
  as each tool needs it.
- Real-tenant E2E. The default suite is stubbed; if/when a real-tenant
  mode is needed, open a separate ticket.
- CI wiring. Open a separate ticket once the suite is stable and the
  repo adopts CI.

---

## Operator handoff prompt (paste into a fresh Claude session)

> The repo `~/Projects/unofficial-fortimonitor-browser-plugin` has a
> handoff doc at `docs/playwright-e2e-runbook.md` describing FMN-116, a
> Playwright E2E setup for the toolkit's Find Servers tool. Read that
> doc, then `CLAUDE.md` and `MEMORY.md`, then start the work. Branch
> off `feature/fmn-114-search-servers-compound-filter` (the Find
> Servers tool lives there, not yet on main) as
> `feature/fmn-116-playwright-e2e-find-servers`. Move FMN-116 to In
> Progress in Plane before you start. Push only on my explicit approval.
