// Unofficial FortiMonitor Toolkit - Ask AI live matrix (FMN-120 Phase 2).
//
// Drives a real local Ollama daemon across a model x scenario matrix and
// writes docs/ask-ai-model-matrix.md so design decisions can be made on
// data. Skip-by-default: tests only run when OLLAMA_LIVE=1 AND
// FORTIMONITOR_API_KEY is set (the catalog tools talk to the real
// FortiMonitor tenant, otherwise tool calls would fail at the network
// layer and confound model-quality measurements).
//
// Tunable via env (see tests/e2e/.env.local):
//   OLLAMA_LIVE=1
//   OLLAMA_BIN=/path/to/ollama        (optional)
//   OLLAMA_PORT=11500                 (optional; non-default to avoid colliding with the user's daemon)
//   OLLAMA_MODELS=qwen2.5:7b,qwen3:8b (optional; override the matrix)
//   OLLAMA_KEEP_DAEMON=1              (optional; keep the daemon warm across runs)
//   ASK_AI_FILTER_CODEGEN=0           (optional; toggle commit 42cccc6's filter)
//   ASK_AI_PROMPT_HINTS=0             (optional; toggle commit 841247a's hint block)
//   FORTIMONITOR_API_KEY=...
//
// Run:
//   npm run test:e2e:ollama-live
//   OLLAMA_MODELS=qwen3:8b npm run test:e2e:ollama-live   # one-model run
//
// All test names are prefixed with `live - Ask AI` and tagged into
// describe blocks per model so per-model failures are easy to scan.

import { test, expect } from './fixtures.js';
import { startOllama, DEFAULT_MODELS, parseModelsEnv } from './ollama-fixture.js';
import {
  buildScenarios,
  writeMatrixReport,
  isGibberish,
  ollamaLoggedTruncation
} from './ask-ai-scenarios.js';
import { seedApiKey } from './seed-api-key.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Report path defaults to docs/ask-ai-model-matrix.md for the
// canonical run. Phase 3 ablations override via ASK_AI_REPORT_PATH so
// each toggle config has a separate artifact.
const REPORT_PATH = process.env.ASK_AI_REPORT_PATH
  ? path.resolve(__dirname, '../..', process.env.ASK_AI_REPORT_PATH)
  : path.resolve(__dirname, '../../docs/ask-ai-model-matrix.md');

const PANOPTA_BASE = 'https://api2.panopta.com/v2';

const OLLAMA_LIVE = process.env.OLLAMA_LIVE === '1';
const API_KEY = process.env.FORTIMONITOR_API_KEY;
const MODELS = parseModelsEnv() ?? DEFAULT_MODELS;
const TOGGLES = {
  filterCodegen: process.env.ASK_AI_FILTER_CODEGEN !== '0',
  promptHints: process.env.ASK_AI_PROMPT_HINTS !== '0'
};

// Single shared collector that survives across all describe blocks; the
// final after-all writes it out. Live test runs use workers:1, so this
// is safe.
const matrixRows = [];

test.describe('live - Ask AI [matrix]', () => {
  test.skip(!OLLAMA_LIVE, 'OLLAMA_LIVE=1 not set; see tests/e2e/.env.local and docs/ask-ai-local-providers.md');
  test.skip(!API_KEY, 'FORTIMONITOR_API_KEY not set; matrix tools call the real tenant.');

  let ollama;
  let tenantSample;

  test.beforeAll(async () => {
    ollama = await startOllama({ models: MODELS });
    expect(ollama.live, 'ollama fixture should be live in matrix mode').toBe(true);
    console.log(`[ask-ai-live] ollama running at ${ollama.baseUrl}, log=${ollama.logFile}`);

    // One-shot tenant discovery to fill in scenario placeholders.
    const headers = { 'Authorization': `ApiKey ${API_KEY}` };
    const r = await fetch(`${PANOPTA_BASE}/server?limit=50`, { headers });
    if (!r.ok) throw new Error(`tenant discovery: GET /server returned ${r.status}`);
    const body = await r.json();
    const servers = Array.isArray(body?.server_list) ? body.server_list : [];
    if (servers.length === 0) throw new Error('tenant has no servers; cannot discover scenario inputs.');

    const taggedServer = servers.find((s) => Array.isArray(s.tags) && s.tags.length > 0);
    const namedServer = servers.find((s) => typeof s.name === 'string' && s.name.length >= 3);
    tenantSample = {
      serverName: namedServer?.name ?? null,
      serverId: extractServerId(servers[0]),
      tag: taggedServer?.tags?.[0] ?? null
    };
    console.log('[ask-ai-live] tenant sample:', JSON.stringify(tenantSample));
  });

  test.afterAll(async () => {
    if (matrixRows.length > 0) {
      writeMatrixReport(matrixRows, REPORT_PATH);
      console.log(`[ask-ai-live] matrix report written: ${REPORT_PATH}`);
    }
    if (ollama && typeof ollama.stop === 'function') await ollama.stop();
  });

  for (const model of MODELS) {
    test.describe(`live - Ask AI [model=${model}]`, () => {
      test.beforeAll(async ({ extensionContext }) => {
        await seedApiKey(extensionContext, API_KEY);
        await seedAskAiConfig(extensionContext, {
          provider: 'ollama',
          url: ollama.baseUrl + '/v1',
          model,
          toggles: TOGGLES
        });
      });

      // Each scenario is a separate test so individual failures show up
      // in the test runner. The matrix-row collector still records every
      // outcome regardless of pass/fail.
      const scenariosForBoot = buildScenarios({}); // placeholder for naming
      for (const placeholder of scenariosForBoot) {
        test(`live - ${placeholder.id}`, async ({ extensionContext, extensionId }) => {
          // Re-build scenarios per test so the tenant sample is the one
          // discovered in beforeAll (which lives in the parent describe).
          const liveScenarios = buildScenarios(tenantSample);
          const scenario = liveScenarios.find((s) => s.id === placeholder.id);
          if (!scenario) throw new Error(`scenario ${placeholder.id} not built`);

          // Ground truth from the v2 API at scenario time. The chat's
          // response will be compared against this. Ground truth is
          // captured BEFORE the chat sends so the model's tool result
          // and our truth source see the same snapshot of the tenant
          // (close enough for assertion purposes - outages can land
          // between the two fetches but the volume is similar).
          const apiClient = makeApiFetcher(API_KEY);
          let groundTruth = null;
          if (typeof scenario.groundTruth === 'function') {
            try {
              groundTruth = await scenario.groundTruth(apiClient);
            } catch (err) {
              groundTruth = { __error: err?.message ?? String(err) };
            }
          }

          const startMs = Date.now();
          const result = await runChatScenario(extensionContext, extensionId, scenario);
          const endMs = Date.now();
          result.latencyMs = endMs - startMs;
          result.ollamaContextTruncationLogged = ollamaLoggedTruncation(ollama.logFile, startMs, endMs);
          result.gibberishHeuristic = isGibberish(result.responseText);

          // Verify is the new outcome-level assertion. Falls back to
          // the legacy `assert` for scenarios that haven't migrated.
          const verifyFn = scenario.verify ?? scenario.assert;
          const verdict = verifyFn(result, groundTruth);
          const row = {
            model,
            scenarioId: scenario.id,
            toolsCalled: result.toolsCalled,
            latencyMs: result.latencyMs,
            responseText: result.responseText,
            ollamaContextTruncationLogged: result.ollamaContextTruncationLogged,
            gibberishHeuristic: result.gibberishHeuristic,
            groundTruth: summarizeGroundTruth(groundTruth),
            passed: verdict.passed,
            reason: verdict.reason,
            observation: verdict.observation === true,
            toggles: TOGGLES
          };
          matrixRows.push(row);

          // Persist EVERY row to a JSONL file, then re-aggregate from
          // disk and rewrite the markdown report. Crucial detail:
          // Playwright restarts the worker process when a test fails
          // (observed empirically - each failed test starts a fresh
          // ollama daemon, fresh extension context, and resets
          // module-scoped matrixRows). So we cannot rely on the
          // in-memory array surviving across failures. JSONL on disk
          // does. Each row is keyed by (model, scenarioId); on
          // aggregate, the LATEST line wins.
          try {
            persistRow(row);
            const allRows = loadAllRowsDeduped();
            writeMatrixReport(allRows, REPORT_PATH);
          } catch (err) {
            console.warn(`[ask-ai-live] persist/report failed: ${err?.message ?? err}`);
          }

          // We deliberately do NOT call expect.soft / expect.hard on
          // scenario verdicts. Doing so causes Playwright to mark the
          // test as failed, which triggers worker recycling, which
          // resets module state, which breaks rev-loop reporting
          // across mixed pass/fail runs. The matrix report (markdown
          // table + JSONL artifact) is the authoritative source for
          // pass/fail, not the test runner's exit code. This means
          // `npm run test:e2e:ollama-live` always exits 0 - that is
          // intentional. Read the report.
          if (verdict.passed === false && !row.observation) {
            console.log(`[ask-ai-live] FAIL ${scenario.id}: ${verdict.reason}`);
          }
        });
      }
    });
  }
});

/**
 * Issue a chat:send via the service worker, capture chat:event broadcasts,
 * return tool-call sequence + final text.
 */
async function runChatScenario(extensionContext, extensionId, scenario) {
  const page = await extensionContext.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    // Drain runtime messages from the popup page for the duration of
    // this turn. The popup is the only context that listens to
    // 'chat:event' broadcasts; the service worker emits them.
    const eventScript = (prompt) => new Promise((resolve) => {
      const events = [];
      const listener = (msg) => {
        if (msg?.type === '__event__' && msg.event === 'chat:event') {
          events.push(msg.payload);
        }
      };
      chrome.runtime.onMessage.addListener(listener);
      chrome.runtime.sendMessage(
        { type: 'chat:send', payload: { messages: [{ role: 'user', content: prompt }] } },
        (resp) => {
          chrome.runtime.onMessage.removeListener(listener);
          resolve({ resp, events });
        }
      );
    });

    const { resp, events } = await page.evaluate(eventScript, scenario.prompt);

    const toolsCalled = events
      .filter((e) => e?.phase === 'tool_call_start')
      .map((e) => e.name);

    // Final assistant text: pull from the result messages if the loop
    // completed cleanly, else from the partial events.
    let responseText = '';
    if (resp?.ok && Array.isArray(resp.result?.messages)) {
      for (const msg of resp.result.messages) {
        if (msg.role !== 'assistant') continue;
        if (typeof msg.content === 'string') {
          responseText = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textBlocks = msg.content.filter((b) => b?.type === 'text').map((b) => b.text);
          if (textBlocks.length) responseText = textBlocks.join('\n');
        }
      }
    }
    if (!responseText) {
      responseText = events
        .filter((e) => e?.kind === 'text')
        .map((e) => e.text)
        .join('');
    }

    return {
      toolsCalled,
      responseText,
      events,
      resp
    };
  } finally {
    await page.close();
  }
}

/**
 * Seed Ask AI provider config + Phase 2 toggles into chrome.storage.local
 * via the service worker. Mirrors seedApiKey's pattern.
 */
async function seedAskAiConfig(extensionContext, { provider, url, model, toggles }) {
  let sw = extensionContext.serviceWorkers()[0];
  if (!sw) sw = await extensionContext.waitForEvent('serviceworker', { timeout: 10_000 });
  await sw.evaluate(async (cfg) => {
    const writes = {
      'fm:askClaudeProvider': cfg.provider,
      'fm:askClaudeEnabled': true,
      [`fm:askClaude${cfg.provider === 'ollama' ? 'Ollama' : 'LmStudio'}Url`]: cfg.url,
      [`fm:askClaude${cfg.provider === 'ollama' ? 'Ollama' : 'LmStudio'}Model`]: cfg.model,
      'fm:askAiFilterCodegen': cfg.toggles.filterCodegen,
      'fm:askAiPromptHints': cfg.toggles.promptHints
    };
    await chrome.storage.local.set(writes);
  }, { provider, url, model, toggles });
}

function extractServerId(server) {
  if (!server) return null;
  if (typeof server.id === 'number') return server.id;
  if (typeof server.url === 'string') {
    const m = server.url.match(/\/server\/(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Per-scenario ground-truth fetcher. Hits api2.panopta.com directly
 * with the operator's RW key so each scenario's verify() has an
 * authoritative snapshot to assert the chat response against.
 */
function makeApiFetcher(apiKey) {
  return {
    async fetch(pathAndQuery) {
      const url = `${PANOPTA_BASE}${pathAndQuery}`;
      const r = await fetch(url, { headers: { 'Authorization': `ApiKey ${apiKey}` } });
      if (!r.ok) throw new Error(`groundTruth ${pathAndQuery}: HTTP ${r.status}`);
      return await r.json();
    }
  };
}

/**
 * Compress the per-scenario groundTruth blob into a small summary
 * suitable for the matrix report's JSON section. We don't want the
 * full /outage/active payload baked into the report.
 */
/**
 * Cross-process row persistence. Worker recycling on test failure
 * resets the in-memory matrixRows array (observed: each failed test
 * spawns a fresh worker with fresh ollama daemon and fresh module
 * state). To survive that, we append every row as a JSONL line to a
 * file under tests/e2e/.artifacts/. The aggregate read dedupes by
 * (model, scenarioId) keeping the latest line, so a re-run of the
 * same scenario in a recycled worker overrides the prior row.
 *
 * The file lives outside docs/ so it doesn't pollute git status; it
 * is ignored via .gitignore's tests/e2e/.artifacts/ rule.
 */
const ROWS_JSONL_PATH = path.resolve(__dirname, '.artifacts/matrix-rows.jsonl');

function persistRow(row) {
  const dir = path.dirname(ROWS_JSONL_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(ROWS_JSONL_PATH, JSON.stringify(row) + '\n', 'utf8');
}

function loadAllRowsDeduped() {
  if (!fs.existsSync(ROWS_JSONL_PATH)) return [];
  const text = fs.readFileSync(ROWS_JSONL_PATH, 'utf8');
  const seen = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const key = `${r.model}|${r.scenarioId}`;
      // Latest write wins.
      seen.set(key, r);
    } catch { /* skip malformed lines */ }
  }
  return [...seen.values()];
}

// (clearMatrixRowsFile lives in global-setup.js so it fires once per
// `npm run test:e2e:ollama-live` invocation, before workers spawn.)

function summarizeGroundTruth(gt) {
  if (gt == null) return null;
  if (gt.__error) return { error: gt.__error };
  const out = {};
  if (typeof gt.count === 'number') out.count = gt.count;
  if (Array.isArray(gt.outages)) out.outageCount = gt.outages.length;
  if (Array.isArray(gt.fabrics)) out.fabricCount = gt.fabrics.length;
  if (Array.isArray(gt.templates)) out.templateCount = gt.templates.length;
  if (Array.isArray(gt.servers)) out.serverCount = gt.servers.length;
  if (typeof gt.name === 'string') out.serverName = gt.name;
  if (typeof gt.id === 'number') out.serverId = gt.id;
  return Object.keys(out).length > 0 ? out : { _shape: typeof gt };
}
