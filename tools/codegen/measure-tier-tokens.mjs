#!/usr/bin/env node
// FMN-110 (Phase 2.2): in-extension token measurement for the three
// Ask Claude tool tiers.
//
// Loads buildToolDefinitions(tier) for each tier, JSON.stringify's the
// result, prints byte size, and (when ANTHROPIC_API_KEY is set) probes
// Anthropic's count_tokens endpoint for an authoritative tool-block
// token count. Output is plain text for ease of pasting into
// docs/ask-claude-tier-tokens.md.
//
// Usage:
//   node tools/codegen/measure-tier-tokens.mjs
//   ANTHROPIC_API_KEY=sk-ant-... node tools/codegen/measure-tier-tokens.mjs
//
// The script is offline-friendly. Without the API key it still reports
// byte sizes and tool counts so the operator gets a rough proxy without
// burning tokens.

import { buildToolDefinitions } from '../../extension/src/lib/claude-tools.js';

const TIERS = ['readonly', 'readwrite', 'all'];
const MODEL = 'claude-sonnet-4-6';

async function probeTokens(apiKey, tools) {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      tools
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`count_tokens HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return body?.input_tokens ?? null;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? null;
  console.log('Ask Claude tier token measurement');
  console.log(`model: ${MODEL}`);
  console.log(`token API: ${apiKey ? 'live (count_tokens)' : 'skipped (no ANTHROPIC_API_KEY)'}`);
  console.log('');
  console.log('| tier      | tools | bytes (stringified) | tokens |');
  console.log('|-----------|------:|--------------------:|-------:|');

  for (const tier of TIERS) {
    const tools = buildToolDefinitions(tier);
    const bytes = Buffer.byteLength(JSON.stringify(tools));
    let tokens = '-';
    if (apiKey) {
      try {
        const n = await probeTokens(apiKey, tools);
        tokens = n != null ? String(n) : '-';
      } catch (err) {
        tokens = `error: ${err.message}`;
      }
    }
    console.log(`| ${tier.padEnd(9)} | ${String(tools.length).padStart(5)} | ${fmtBytes(bytes).padStart(19)} | ${String(tokens).padStart(6)} |`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
