// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-120 Phase 1: Ollama daemon fixture for live matrix testing.
//
// Spawns `ollama serve` on a non-default port (11500 by default to avoid
// colliding with the operator's manually-running daemon), pulls each
// requested model on first call, tears down on test exit. Logs daemon
// stdout+stderr to tests/e2e/.artifacts/ so post-run analysis can scrape
// for OLLAMA_CONTEXT_LENGTH truncation warnings and model-load latency.
//
// Skip-mode: when process.env.OLLAMA_LIVE !== '1', startOllama() returns
// a no-op stub. Specs use this to gate `test.skip()` without needing to
// know the env var directly.
//
// Binary discovery order:
//   1. process.env.OLLAMA_BIN
//   2. /Applications/Ollama.app/Contents/Resources/ollama (operator's macOS install)
//   3. PATH `ollama`
//
// The fixture intentionally does NOT manage `ollama` cleanup of pulled
// models - large weights stay on disk between runs (operator's preference)
// and a future test invocation reuses them.

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARTIFACT_DIR = path.resolve(__dirname, '.artifacts');
const DEFAULT_BIN_CANDIDATES = [
  process.env.OLLAMA_BIN,
  '/Applications/Ollama.app/Contents/Resources/ollama',
  'ollama'
].filter(Boolean);

const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_INTERVAL_MS = 250;

/**
 * Public stub returned in skip mode (OLLAMA_LIVE != '1').
 * Spec-side: `if (!ollama.live) test.skip('OLLAMA_LIVE not set')`.
 */
function noOpHandle() {
  return {
    live: false,
    baseUrl: null,
    logFile: null,
    listModels: async () => [],
    ensureModel: async () => false,
    stop: async () => {}
  };
}

/**
 * Resolve the ollama binary to use. We prefer an explicit OLLAMA_BIN, then
 * the macOS app bundle path, then PATH. We do NOT verify executability
 * here; spawn() failures surface clearly enough.
 */
function resolveBinary() {
  for (const candidate of DEFAULT_BIN_CANDIDATES) {
    if (!candidate) continue;
    // Absolute paths must exist; PATH lookups can pass through.
    if (path.isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }
  throw new Error(
    'ollama-fixture: cannot find ollama binary. Set OLLAMA_BIN or install ollama.'
  );
}

/**
 * Start the daemon. Returns a handle exposing baseUrl + ensureModel + stop.
 * The handle is ALWAYS returned even on skip - call sites just check
 * handle.live before using it.
 *
 * @param {object} [opts]
 * @param {number} [opts.port=11500]
 * @param {string} [opts.host='127.0.0.1']
 * @param {string[]} [opts.models=[]] - models to pre-pull on startup
 * @returns {Promise<{
 *   live: boolean,
 *   baseUrl: string | null,
 *   logFile: string | null,
 *   listModels: () => Promise<string[]>,
 *   ensureModel: (model: string) => Promise<boolean>,
 *   stop: () => Promise<void>
 * }>}
 */
export async function startOllama(opts = {}) {
  if (process.env.OLLAMA_LIVE !== '1') return noOpHandle();

  const port = Number(process.env.OLLAMA_PORT ?? opts.port ?? 11500);
  const host = process.env.OLLAMA_HOST_OVERRIDE ?? opts.host ?? '127.0.0.1';
  const baseUrl = `http://${host}:${port}`;
  const binary = resolveBinary();
  const models = Array.isArray(opts.models) ? opts.models : [];

  // Open a log file so we can scrape Ollama's output later for
  // truncation warnings, model-load timings, and tool-call traces.
  if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(ARTIFACT_DIR, `ollama-${stamp}.log`);
  const logStream = createWriteStream(logFile, { flags: 'a' });
  logStream.write(`# ollama serve - started ${new Date().toISOString()} - port ${port}\n`);

  // Pin OLLAMA_MODELS to ~/.ollama/models so the spawned daemon shares
  // the user's existing model store (the operator's pre-pulled models
  // are visible immediately and we never re-download). Without this,
  // Ollama defaults to the daemon's cwd in some configurations and
  // silently drops a 5GB model directory into the repo.
  const ollamaModelsDir = process.env.OLLAMA_MODELS_DIR
    ?? path.join(process.env.HOME ?? '', '.ollama', 'models');
  const child = spawn(binary, ['serve'], {
    cwd: process.env.HOME ?? process.cwd(),
    env: {
      ...process.env,
      OLLAMA_HOST: `${host}:${port}`,
      OLLAMA_MODELS: ollamaModelsDir,
      // CORS allowlist is irrelevant here (we're hitting Ollama from
      // Node, not the browser extension), but set it just in case some
      // downstream hooks check Origin.
      OLLAMA_ORIGINS: '*'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (b) => logStream.write(b));
  child.stderr.on('data', (b) => logStream.write(b));

  let exitedEarly = null;
  child.on('exit', (code, signal) => {
    exitedEarly = { code, signal };
    logStream.write(`# exit code=${code} signal=${signal}\n`);
    logStream.end();
  });

  // Health-poll: GET /api/tags is cheap and returns 200 once the server
  // has bound the port.
  const start = Date.now();
  let healthy = false;
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    if (exitedEarly) {
      throw new Error(
        `ollama-fixture: daemon exited before becoming healthy (code=${exitedEarly.code}, signal=${exitedEarly.signal}). See ${logFile}`
      );
    }
    try {
      const r = await fetch(`${baseUrl}/api/tags`);
      if (r.ok) { healthy = true; break; }
    } catch { /* not yet */ }
    await sleep(HEALTH_INTERVAL_MS);
  }
  if (!healthy) {
    try { child.kill('SIGTERM'); } catch {}
    throw new Error(`ollama-fixture: daemon did not become healthy within ${HEALTH_TIMEOUT_MS}ms. See ${logFile}`);
  }

  // Pre-pull requested models so the matrix run is uninterrupted.
  for (const model of models) {
    await ensureModelImpl(baseUrl, model);
  }

  return {
    live: true,
    baseUrl,
    logFile,
    async listModels() {
      const r = await fetch(`${baseUrl}/api/tags`);
      if (!r.ok) return [];
      const body = await r.json();
      return Array.isArray(body?.models) ? body.models.map((m) => m.name) : [];
    },
    async ensureModel(model) {
      return ensureModelImpl(baseUrl, model);
    },
    async stop() {
      if (process.env.OLLAMA_KEEP_DAEMON === '1') {
        logStream.write('# OLLAMA_KEEP_DAEMON=1, leaving daemon running\n');
        return;
      }
      try { child.kill('SIGTERM'); } catch {}
      // Give it 5s to exit cleanly; SIGKILL otherwise.
      const exitDeadline = Date.now() + 5_000;
      while (!exitedEarly && Date.now() < exitDeadline) {
        await sleep(100);
      }
      if (!exitedEarly) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }
  };
}

/**
 * Ensure a model is present locally. Idempotent: if `ollama list` already
 * has it, returns true without re-pulling. Otherwise streams /api/pull
 * to completion. Pull progress is written to console because the model
 * weights can be multiple GB and a silent test run is unsettling.
 *
 * @returns {Promise<boolean>} true if the model is now available
 */
async function ensureModelImpl(baseUrl, model) {
  // Check if already pulled.
  const tags = await fetch(`${baseUrl}/api/tags`).then((r) => r.json()).catch(() => ({}));
  const installed = Array.isArray(tags?.models) ? tags.models.map((m) => m.name) : [];
  if (installed.includes(model)) return true;
  // Some Ollama versions report tags with the `:latest` suffix elided in
  // the "name" field; check the bare model name too.
  const bareModel = model.includes(':') ? model.split(':')[0] : model;
  if (installed.some((n) => n === bareModel || n.startsWith(`${bareModel}:`))) return true;

  console.log(`[ollama-fixture] pulling model: ${model} (this can take several minutes for fresh models)`);
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true })
  });
  if (!res.ok) {
    throw new Error(`ollama-fixture: /api/pull for ${model} failed with HTTP ${res.status}`);
  }
  // Stream the NDJSON pull progress.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let lastLogged = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.status === 'success') {
          console.log(`[ollama-fixture] pulled ${model}`);
          return true;
        }
        if (typeof evt.completed === 'number' && typeof evt.total === 'number') {
          const now = Date.now();
          if (now - lastLogged > 5000) {
            const pct = evt.total > 0 ? Math.floor((evt.completed / evt.total) * 100) : 0;
            console.log(`[ollama-fixture] pulling ${model}: ${pct}% (${formatBytes(evt.completed)}/${formatBytes(evt.total)})`);
            lastLogged = now;
          }
        } else if (evt.error) {
          throw new Error(`ollama-fixture: pull error for ${model}: ${evt.error}`);
        }
      } catch (e) {
        if (e.message?.includes('pull error')) throw e;
        // Ignore JSON parse failures for partial chunks
      }
    }
  }
  return true;
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/**
 * Default model matrix for the Phase 2 run. Spans 3B to 14B across
 * three families (Qwen, Llama, Mistral); deliberately not qwen2.5-only.
 * Override per-run with OLLAMA_MODELS=foo:7b,bar:14b.
 */
export const DEFAULT_MODELS = [
  'llama3.2:3b',
  'qwen2.5:7b',
  'llama3.1:8b',
  'qwen3:8b',
  'mistral-nemo:12b',
  'qwen2.5:14b'
];

export function parseModelsEnv() {
  const v = process.env.OLLAMA_MODELS;
  if (!v) return null;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}
