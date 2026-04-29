// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// FMN-120 Phase 1: canonical chat scenarios + matrix-report writer for
// the live Ollama suite.
//
// Scenarios are intentionally narrow and behavioral. Each describes
// what tool the operator would expect the model to call when given
// the prompt. We never assert on the natural-language reply (that's
// model-specific). We assert on tool-call behavior because that is
// the contract the extension provides.
//
// Soft assertions: `assert(result)` returns `{ passed: bool, reason: string|null }`.
// A failing scenario does NOT abort the rest of the run; the matrix
// needs every cell so the operator can compare across models.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Tenant-discovery placeholders that scenario prompts can interpolate.
 * Filled in by the spec before each model's run.
 *
 * @typedef {object} TenantSample
 * @property {string|null} serverName    - a known server name substring
 * @property {number|null} serverId      - a known server id
 * @property {string|null} tag           - a tag known to be in use
 * @property {string|null} fabricServerId - a server id with a fabric_connection
 */

/**
 * Build the scenario list given a tenant sample. Some prompts depend
 * on real tenant values; we substitute them at runtime.
 *
 * Each scenario carries:
 *   prompt:       the user turn sent to the chat
 *   expectedTool: tool name(s) the model should call
 *   maxToolCalls: max number of tool calls in the loop (catches re-fetch
 *                 storms - the model fact-finding by calling get_outage on
 *                 every list element)
 *   groundTruth(api): async fetch of the API state at scenario time, used
 *                 by verify() to assert the response references real data
 *   verify(result, gt): final pass/fail. Combines:
 *                   1. assertFirstTool  (right tool name)
 *                   2. assertCallBudget (no fetch storm)
 *                   3. assertNotGibberish (hard fail, not observation)
 *                   4. assertResponseReferencesData (the model's prose
 *                      must surface at least one piece of real data the
 *                      tool actually returned - kills the "the JSON
 *                      appears to represent..." failure mode)
 */
export function buildScenarios(tenant) {
  const sample = tenant ?? {};
  const serverName = sample.serverName ?? 'fgt';
  const serverId = sample.serverId ?? null;
  const tag = sample.tag ?? null;

  return [
    {
      id: 'active-outages-direct',
      prompt: 'What active outages are happening right now?',
      expectedTool: 'list_active_outages',
      maxToolCalls: 2,
      groundTruth: async (api) => {
        const r = await api.fetch('/outage/active?limit=100');
        return {
          count: r?.meta?.total_count ?? (r?.outage_list?.length ?? 0),
          outages: r?.outage_list ?? []
        };
      },
      verify: (result, gt) => combineVerdicts(
        assertFirstTool(result, 'list_active_outages'),
        assertCallBudget(result, 2),
        assertNotGibberish(result),
        assertResponseSurfacesOutages(result, gt)
      )
    },
    {
      id: 'active-outages-paraphrase',
      prompt: 'Anything broken? Show me ongoing incidents.',
      expectedTool: 'list_active_outages',
      maxToolCalls: 2,
      groundTruth: async (api) => {
        const r = await api.fetch('/outage/active?limit=100');
        return {
          count: r?.meta?.total_count ?? (r?.outage_list?.length ?? 0),
          outages: r?.outage_list ?? []
        };
      },
      verify: (result, gt) => combineVerdicts(
        assertFirstTool(result, 'list_active_outages'),
        assertCallBudget(result, 2),
        assertNotGibberish(result),
        assertResponseSurfacesOutages(result, gt)
      )
    },
    {
      id: 'server-by-name',
      prompt: `Find the server named "${serverName}".`,
      expectedTool: 'search_servers',
      maxToolCalls: 2,
      groundTruth: async (api) => {
        if (!serverName) return { servers: [] };
        const r = await api.fetch(`/server?name=${encodeURIComponent(serverName)}&limit=10`);
        return { servers: r?.server_list ?? [] };
      },
      verify: (result, gt) => combineVerdicts(
        assertFirstTool(result, ['search_servers', 'list_servers']),
        assertCallBudget(result, 2),
        assertNotGibberish(result),
        assertResponseContainsAny(result, [serverName].filter(Boolean), 'server name')
      )
    },
    {
      id: 'server-details',
      prompt: serverId
        ? `Get details for server id ${serverId}.`
        : `Get details for server id 1.`,
      expectedTool: 'get_server',
      maxToolCalls: 2,
      groundTruth: async (api) => {
        if (!serverId) return null;
        return await api.fetch(`/server/${serverId}`);
      },
      verify: (result, gt) => combineVerdicts(
        assertFirstTool(result, 'get_server'),
        assertCallBudget(result, 2),
        assertNotGibberish(result),
        gt && gt.name
          ? assertResponseContainsAny(result, [gt.name, String(serverId)], 'server identity')
          : { passed: true, reason: null }
      )
    },
    {
      id: 'fabric-connections',
      prompt: 'List all fabric connections.',
      expectedTool: 'list_fabric_connections',
      maxToolCalls: 2,
      groundTruth: async (api) => {
        const r = await api.fetch('/fabric_connection?limit=50');
        return {
          count: r?.meta?.total_count ?? (r?.fabric_connection_list?.length ?? 0),
          fabrics: r?.fabric_connection_list ?? []
        };
      },
      verify: (result, gt) => combineVerdicts(
        assertFirstTool(result, 'list_fabric_connections'),
        assertCallBudget(result, 2),
        assertNotGibberish(result),
        assertResponseSurfacesFabrics(result, gt)
      )
    },
    {
      id: 'templates-list',
      prompt: 'List the monitoring templates.',
      expectedTool: 'list_templates',
      maxToolCalls: 2,
      groundTruth: async (api) => {
        // Real v2 endpoint is /server_template; the body field is
        // server_template_list. (See panopta-client.js listTemplates.)
        const r = await api.fetch('/server_template?limit=100');
        return {
          count: r?.meta?.total_count ?? (r?.server_template_list?.length ?? 0),
          templates: r?.server_template_list ?? []
        };
      },
      verify: (result, gt) => combineVerdicts(
        assertFirstTool(result, 'list_templates'),
        assertCallBudget(result, 2),
        assertNotGibberish(result),
        assertResponseSurfacesTemplates(result, gt)
      )
    },
    {
      id: 'ambiguous-tool',
      // A prompt that could plausibly route multiple ways. Records what
      // the model picks so the matrix shows behavioral patterns. Not
      // asserted because the prompt is genuinely ambiguous - asking
      // for clarification IS an acceptable response.
      prompt: 'Show me outages on the servers.',
      expectedTool: null,
      maxToolCalls: 4,
      groundTruth: async () => null,
      verify: (result) => ({
        passed: true,
        reason: null,
        observation: true,
        toolsCalled: result.toolsCalled
      })
    },
    {
      id: 'multi-step',
      prompt: tag
        ? `Find any server tagged "${tag}" that is currently in an active outage.`
        : `Find any server in an active outage and tell me its name.`,
      expectedTool: [
        'list_active_outages', 'search_servers', 'list_servers',
        'search_servers_advanced', 'get_servers_with_active_outages'
      ],
      // Multi-step legitimately may chain: list outages, then search. So
      // a budget of 4 is generous but still catches storms.
      maxToolCalls: 4,
      groundTruth: async (api) => {
        const r = await api.fetch('/outage/active?limit=100');
        const outages = r?.outage_list ?? [];
        return { activeOutageCount: outages.length, outages };
      },
      verify: (result, gt) => combineVerdicts(
        assertAnyTool(result, [
          'list_active_outages', 'search_servers', 'list_servers',
          'search_servers_advanced', 'get_servers_with_active_outages'
        ]),
        assertCallBudget(result, 4),
        assertNotGibberish(result)
      )
    }
  ];
}

/**
 * Soft assertion helpers. Each returns `{ passed: bool, reason: string|null }`.
 * combineVerdicts merges several into a single verdict; first failure wins.
 */
function combineVerdicts(...verdicts) {
  for (const v of verdicts) {
    if (!v) continue;
    if (v.observation) return v;
    if (!v.passed) return v;
  }
  return { passed: true, reason: null };
}

function assertFirstTool(result, expected) {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  const first = result.toolsCalled[0];
  if (!first) {
    return { passed: false, reason: 'no tool called; model produced prose only' };
  }
  if (!expectedList.includes(first)) {
    return {
      passed: false,
      reason: `first tool was ${first}, expected one of [${expectedList.join(', ')}]`
    };
  }
  return { passed: true, reason: null };
}

function assertAnyTool(result, expectedList) {
  const calls = new Set(result.toolsCalled);
  for (const e of expectedList) if (calls.has(e)) return { passed: true, reason: null };
  return {
    passed: false,
    reason: `none of [${expectedList.join(', ')}] called; got [${[...calls].join(', ') || 'none'}]`
  };
}

function assertCallBudget(result, budget) {
  const n = result.toolsCalled.length;
  if (n > budget) {
    return {
      passed: false,
      reason: `tool-call storm: ${n} calls > budget ${budget}; the model is fact-finding instead of presenting [${result.toolsCalled.join(', ')}]`
    };
  }
  return { passed: true, reason: null };
}

function assertNotGibberish(result) {
  if (result.gibberishHeuristic) {
    return { passed: false, reason: 'response prose tripped the gibberish heuristic (non-Latin script ratio > 0.3)' };
  }
  return { passed: true, reason: null };
}

/**
 * Verify the response surfaces actual outage data, not meta-analysis.
 * Passes if the response text contains:
 *   - the count (as a digit substring) when count > 0, OR
 *   - at least one server name from the outage list (when populated)
 *   - account-empty case (count=0) passes if response acknowledges that
 */
function assertResponseSurfacesOutages(result, gt) {
  const text = (result.responseText ?? '').toLowerCase();
  if (!text) {
    return { passed: false, reason: 'response is empty' };
  }
  if (gt?.count === 0) {
    if (/no (active )?outages?|none|0 outages|nothing/.test(text)) {
      return { passed: true, reason: null };
    }
    return { passed: false, reason: 'tenant has 0 active outages but response did not say so' };
  }
  // Count match (most robust signal across paraphrases)
  if (gt?.count != null && text.includes(String(gt.count))) {
    return { passed: true, reason: null };
  }
  // Server-name match (next most robust)
  const serverNames = (gt?.outages ?? [])
    .map((o) => o?.server?.name)
    .filter((n) => typeof n === 'string' && n.length >= 4);
  for (const n of serverNames) {
    if (text.includes(n.toLowerCase())) return { passed: true, reason: null };
  }
  return {
    passed: false,
    reason: `response did not surface any real outage data (count=${gt?.count}, expected the count or a server name in the prose)`
  };
}

function assertResponseSurfacesFabrics(result, gt) {
  const text = (result.responseText ?? '').toLowerCase();
  if (!text) return { passed: false, reason: 'response is empty' };
  if (gt?.count === 0) {
    if (/no fabric|none|0 (connections|fabrics)|nothing/.test(text)) {
      return { passed: true, reason: null };
    }
    return { passed: false, reason: 'tenant has 0 fabric connections but response did not say so' };
  }
  // Count match
  if (gt?.count != null && text.includes(String(gt.count))) {
    return { passed: true, reason: null };
  }
  // Match any upstream host or serial number
  for (const f of (gt?.fabrics ?? [])) {
    const sn = typeof f?.fortigate_serial_number === 'string' ? f.fortigate_serial_number.toLowerCase() : null;
    const uh = typeof f?.upstream_host === 'string' ? f.upstream_host.toLowerCase() : null;
    if (sn && text.includes(sn)) return { passed: true, reason: null };
    if (uh && text.includes(uh)) return { passed: true, reason: null };
  }
  return {
    passed: false,
    reason: `response did not surface any fabric-connection data (count=${gt?.count}, expected the count or a serial/host in the prose)`
  };
}

function assertResponseSurfacesTemplates(result, gt) {
  const text = (result.responseText ?? '').toLowerCase();
  if (!text) return { passed: false, reason: 'response is empty' };
  if (gt?.count === 0) {
    if (/no templates|none|0 templates|nothing/.test(text)) {
      return { passed: true, reason: null };
    }
    return { passed: false, reason: 'tenant has 0 templates but response did not say so' };
  }
  if (gt?.count != null && text.includes(String(gt.count))) {
    return { passed: true, reason: null };
  }
  // Match at least one real template name (use names >= 4 chars to avoid spurious hits like "API")
  const names = (gt?.templates ?? [])
    .map((t) => typeof t?.name === 'string' ? t.name : null)
    .filter((n) => n && n.length >= 4);
  for (const n of names) {
    if (text.includes(n.toLowerCase())) return { passed: true, reason: null };
  }
  return {
    passed: false,
    reason: `response did not name any real template (count=${gt?.count}, expected the count or a template name in the prose)`
  };
}

/**
 * Pass if any of `needles` appears in result.responseText (case-insensitive
 * substring). Used for scenarios where the response should contain a known
 * specific identifier (server id, server name, etc.).
 */
function assertResponseContainsAny(result, needles, label) {
  const text = (result.responseText ?? '').toLowerCase();
  if (!text) return { passed: false, reason: 'response is empty' };
  for (const needle of needles) {
    if (typeof needle === 'string' && needle.length > 0 && text.includes(needle.toLowerCase())) {
      return { passed: true, reason: null };
    }
  }
  return {
    passed: false,
    reason: `response did not include the ${label}; expected one of [${needles.join(', ')}]`
  };
}

/**
 * Heuristic gibberish detector. Counts the share of characters outside
 * basic ASCII / common Latin extension. The Thai-script crash we saw
 * with qwen2.5:14b would score ~1.0; a normal English reply scores ~0.0.
 * Threshold of 0.3 is conservative.
 */
export function isGibberish(text) {
  if (!text || typeof text !== 'string') return false;
  const total = text.length;
  if (total < 20) return false; // too short to judge
  let nonAscii = 0;
  for (let i = 0; i < total; i++) {
    const code = text.charCodeAt(i);
    // Allow ASCII printable + common whitespace + Latin-1 supplement.
    if (code < 0x80) continue;
    if (code >= 0x80 && code < 0x180) continue;
    nonAscii++;
  }
  return nonAscii / total > 0.3;
}

/**
 * Scrape the Ollama daemon log file for the truncation warning that
 * accompanies prompts exceeding `num_ctx`. Filter to lines that fall
 * within the [start, end] timestamp window so we attribute warnings
 * to the right run.
 *
 * @param {string|null} logFile
 * @param {number} startMs - timestamp before the chat call
 * @param {number} endMs   - timestamp after the chat call
 * @returns {boolean} true if a truncation warning fired during the window
 */
export function ollamaLoggedTruncation(logFile, startMs, endMs) {
  if (!logFile || !existsSync(logFile)) return false;
  let text;
  try { text = readFileSync(logFile, 'utf8'); } catch { return false; }
  // Ollama log lines look like: time=2026-04-29T10:21:15.939-07:00 level=WARN ... msg="truncating input prompt"
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.includes('truncating input prompt')) continue;
    const m = line.match(/time=(\S+)/);
    if (!m) return true; // can't parse time; conservative pass
    const t = Date.parse(m[1]);
    if (Number.isNaN(t)) return true;
    if (t >= startMs && t <= endMs) return true;
  }
  return false;
}

/**
 * Markdown matrix-report writer. Consumes the array of result rows
 * collected during the spec run and emits a navigable table.
 *
 * @param {Array<{
 *   model: string,
 *   scenarioId: string,
 *   passed: boolean,
 *   reason: string|null,
 *   toolsCalled: string[],
 *   latencyMs: number,
 *   responseText: string,
 *   gibberishHeuristic: boolean,
 *   ollamaContextTruncationLogged: boolean,
 *   observation?: boolean,
 *   toggles?: { filterCodegen: boolean, promptHints: boolean }
 * }>} rows
 * @param {string} outPath
 */
export function writeMatrixReport(rows, outPath) {
  const dir = path.dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const models = unique(rows.map((r) => r.model));
  const scenarios = unique(rows.map((r) => r.scenarioId));

  const header = `# Ask AI - Local-LLM Model Matrix

> Generated by \`tests/e2e/ask-ai-live.spec.js\` (FMN-120 Phase 2).
> Each cell shows whether the model called the expected tool first.
> Cells flagged \`!ctx\` had Ollama log a truncation warning during the run.
> Cells flagged \`!gib\` produced output that tripped the gibberish heuristic.
> Cells with \`obs\` are observation-only (never fail).

| Run metadata | Value |
|---|---|
| Date | ${new Date().toISOString()} |
| Host | ${process.platform} ${process.arch} |
| Node | ${process.version} |
| Git SHA | ${gitSha()} |
| Models | ${models.join(', ')} |
| Toggles | ${describeToggles(rows)} |

## Pass/fail matrix

| Scenario | ${models.join(' | ')} |
|---|${models.map(() => '---').join('|')}|
${scenarios.map((sid) => buildRow(sid, models, rows)).join('\n')}

## Per-failure detail
${buildFailureDetail(rows)}

## Per-cell raw

<details><summary>Expand JSON for all cells</summary>

\`\`\`json
${JSON.stringify(rows.map(stripVerboseFields), null, 2)}
\`\`\`

</details>
`;
  writeFileSync(outPath, header, 'utf8');
}

function buildRow(scenarioId, models, rows) {
  const cells = models.map((model) => {
    const row = rows.find((r) => r.model === model && r.scenarioId === scenarioId);
    if (!row) return '_no run_';
    if (row.observation) {
      const tool = row.toolsCalled[0] ?? 'none';
      return `obs: \`${tool}\``;
    }
    const flags = [];
    if (row.ollamaContextTruncationLogged) flags.push('!ctx');
    if (row.gibberishHeuristic) flags.push('!gib');
    const flagSuffix = flags.length ? ` ${flags.join(' ')}` : '';
    if (row.passed) {
      return `PASS ${formatLatency(row.latencyMs)}${flagSuffix}`;
    }
    return `FAIL: ${row.reason ?? 'unknown'}${flagSuffix}`;
  });
  return `| \`${scenarioId}\` | ${cells.join(' | ')} |`;
}

function buildFailureDetail(rows) {
  const failed = rows.filter((r) => !r.passed && !r.observation);
  if (failed.length === 0) return '\n_All scenarios passed across all models._';
  const sections = failed.map((row) => {
    const tools = row.toolsCalled.length ? row.toolsCalled.join(' -> ') : 'none';
    const text = (row.responseText ?? '').slice(0, 500);
    return `### \`${row.scenarioId}\` on \`${row.model}\`
- Reason: ${row.reason}
- Tools called: ${tools}
- Latency: ${formatLatency(row.latencyMs)}
- Truncation logged: ${row.ollamaContextTruncationLogged}
- Gibberish heuristic: ${row.gibberishHeuristic}
- Response (first 500 chars):
\`\`\`
${text}
\`\`\`
`;
  });
  return '\n' + sections.join('\n');
}

function describeToggles(rows) {
  // All rows in a single run share the same toggle set.
  const t = rows.find((r) => r.toggles)?.toggles;
  if (!t) return 'defaults (filterCodegen=on, promptHints=on)';
  return `filterCodegen=${t.filterCodegen ? 'on' : 'OFF'}, promptHints=${t.promptHints ? 'on' : 'OFF'}`;
}

function formatLatency(ms) {
  if (ms == null) return '?s';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function unique(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'),
      encoding: 'utf8'
    }).trim();
  } catch { return 'unknown'; }
}

function stripVerboseFields(row) {
  const { responseText, ...rest } = row;
  return {
    ...rest,
    responseTextPreview: typeof responseText === 'string'
      ? responseText.slice(0, 200)
      : null
  };
}
