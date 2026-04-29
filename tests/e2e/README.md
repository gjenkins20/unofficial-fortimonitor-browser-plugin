# tests/e2e

Playwright end-to-end suite for the toolkit. Initial scope: Find Servers
(FMN-114). For full architectural context (why this exists, what claude-in-chrome
couldn't do, the cross-extension JS isolation that pushed us to Playwright),
see [`docs/playwright-e2e-runbook.md`](../../docs/playwright-e2e-runbook.md).

## Run

From the repo root:

```bash
npm install            # one-time, installs @playwright/test
npx playwright install chromium    # one-time, ~92 MiB
npm run test:e2e
```

A Chromium window briefly opens during the run. Headless does not work for
MV3 service workers; the runbook explains.

## Files

| File | Purpose |
|------|---------|
| `playwright.config.js` | Test runner config. `workers: 1`, `fullyParallel: false`, `headless: false` (set in fixtures). |
| `fixtures.js`          | Worker-scoped `context`, `extensionId`, `findServersUrl` fixtures. Launches Chromium with `--load-extension`, discovers the extension ID from the service worker. |
| `stubs.js`             | `findServersStubScript`: the `chrome.runtime.sendMessage` patch + canned tenant data. Same fixtures as the synthetic harness at `docs/harnesses/find-servers.html`. |
| `find-servers.spec.js` | Four scenarios: criteria-only AND, criteria-only OR with `has_active_outage`, identifiers-only, identifiers + filter intersection. |

## Adding a scenario

1. Drop the new test into `find-servers.spec.js` (or a sibling `.spec.js` if
   it covers a different tool).
2. Use the helpers (`openTool`, `fillCriterion`, `addCriterion`,
   `tickColumnByIndex`, `addAttributeColumn`, `runSearch`,
   `getResultRows`). Each test should `await page.close()` in `finally`.
3. If you need new canned data, add it to `stubs.js`. Keep the stub
   small and human-readable; deviating from the synthetic harness's data
   shape is fine when needed but document why.

## Adding a tool

When adding E2E for another tool (port-scope, manage-templates, etc.):

1. New `<tool-name>.spec.js` next to this README.
2. New stub script for that tool's `chrome.runtime.sendMessage` types.
3. New worker-scoped URL fixture in `fixtures.js` if the page lives at
   a different path. Reuse `context` and `extensionId`.

## Known limitations

- Headless does not work. The suite must run on a workstation with a
  display (or under Xvfb on CI when we wire it up).
- Chromium launch is the dominant cost (~3-5s). With `workers: 1` and
  worker-scoped fixtures the cost is paid once per run.
- The suite is fully stubbed; no FortiMonitor tenant is contacted. A
  real-tenant mode is intentionally out of scope for FMN-116; open a
  separate ticket if/when that's needed.
