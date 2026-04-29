# tests/e2e

Playwright end-to-end suite for the toolkit. Two flavours:

- **Stubbed** (FMN-116): UI plumbing verified against canned tenant data.
  Deterministic, ~5s wall time, no API key needed.
- **Live** (FMN-117): real-tenant scenarios. Behavioural assertions
  against your FortiMonitor v2 API. ~2.5min wall time. Skipped by
  default unless `FORTIMONITOR_API_KEY` is in env.

For full architectural context (why this exists, what claude-in-chrome
couldn't do, the cross-extension JS isolation that pushed us to
Playwright), see [`docs/playwright-e2e-runbook.md`](../../docs/playwright-e2e-runbook.md).

## Run

From the repo root:

```bash
npm install            # one-time, installs @playwright/test
npx playwright install chromium    # one-time, ~92 MiB

npm run test:e2e         # stubbed scenarios only (no tenant needed)
npm run test:e2e:live    # live tenant scenarios (FMN-117); requires API key
npm run test:e2e:all     # both suites
```

A Chromium window briefly opens during the run. Headless does not work
for MV3 service workers; the runbook explains.

To debug a single live scenario, narrow with the standard Playwright
`--grep`:

```bash
npm run test:e2e:live -- --grep='Tag query'
```

## Live-tenant API key

The live suite reads `FORTIMONITOR_API_KEY` from `process.env`. Simplest
setup: drop the key into `tests/e2e/.env.local` (gitignored):

```
# tests/e2e/.env.local
<your-fortimonitor-v2-api-key>
```

The file may be either a bare value (treated as `FORTIMONITOR_API_KEY`)
or `KEY=VALUE` per line. `playwright.config.js` runs `loadEnv()` at
startup. When the key is missing, the live suite calls `test.skip()`
with a clear reason and the stubbed suite runs as normal.

When the live suite runs, the seeded key is written into the launched
extension's `chrome.storage.local` (under `panopta.apiKey`) via the
service worker, so the toolkit calls `api2.panopta.com` exactly as your
browser would.

Live tests are **behavioural**, not count-pinned: every Status=active
result row has `status === 'active'`; every Tag=X result row carries X
in `tags[]`; identifier inputs round-trip; identifiers + filter
intersection contains only ids that pass both gates. Tests that need a
tenant feature you don't have (no tags, no active outages, etc.) skip
themselves rather than fail.

## Files

| File | Purpose |
|------|---------|
| `playwright.config.js` | Test runner config. `workers: 1`, `fullyParallel: false`. `loadEnv()` runs at startup so the live key is available. |
| `fixtures.js`          | Worker-scoped `extensionContext`, `extensionId`, `findServersUrl` fixtures. Launches Chromium with `--load-extension`, discovers the extension ID from the service worker. |
| `load-env.js`          | Tiny dotenv-style loader. Reads `tests/e2e/.env.local` into `process.env`. |
| `seed-api-key.js`      | Reusable helper. Writes the API key into the launched extension's `chrome.storage.local` via the service worker. |
| `stubs.js`             | `findServersStubScript`: stubbed `chrome.runtime.sendMessage` + canned tenant data. Same fixtures as the synthetic harness at `docs/harnesses/find-servers.html`. |
| `find-servers.spec.js` | Stubbed scenarios. |
| `find-servers-live.spec.js` | Live-tenant scenarios. Skipped without `FORTIMONITOR_API_KEY`. |

## Adding a scenario

### Stubbed

1. Drop the new test into `find-servers.spec.js` (or a sibling
   `<tool>.spec.js` if it covers a different tool).
2. Use the helpers in the file: `openTool`, `fillCriterion`,
   `addCriterion`, `tickColumnByIndex`, `addAttributeColumn`,
   `runSearch`, `getResultRows`. Each test should `await page.close()`
   in `finally`.
3. If you need new canned data, add it to `stubs.js`. Keep the stub
   small and human-readable.

### Live

1. Drop the new test into `find-servers-live.spec.js` (or a sibling
   `<tool>-live.spec.js`).
2. Use the helpers there: `fillCriterion`, `tickColumn`,
   `addAttributeColumn`, `runSearch`, `getRows`. Wait for attribute
   suggestions via `waitForAttrSuggestionsReady` before filling
   attribute criteria.
3. Use `sample.*` from `beforeAll` for tenant-dependent values; if a
   value isn't available in your tenant, call `test.skip()` rather than
   pinning a synthetic count.
4. Always frame assertions as "every returned row satisfies the
   criterion" rather than "exactly N rows", so the test stays robust to
   tenant changes.

## Adding a tool

For each new tool:

1. New `<tool-name>.spec.js` and `<tool-name>-live.spec.js` next to
   this README.
2. New stub script in `<tool-name>-stubs.js` for that tool's
   `chrome.runtime.sendMessage` types.
3. New worker-scoped URL fixture in `fixtures.js` if the page lives at
   a different path. Reuse `extensionContext` and `extensionId`.
4. Reuse `seedApiKey` for live mode.

See FMN-119 for the cross-tool rollout plan.

## Known limitations

- Headless does not work. The suite must run on a workstation with a
  display (or under Xvfb on CI; see FMN-118).
- Chromium launch is the dominant cost (~3-5s). With `workers: 1` and
  worker-scoped fixtures, the cost is paid once per run.
- Live runs hit `api2.panopta.com`. Slower than stubbed; rate-limit
  caveats apply if you run frequently.
