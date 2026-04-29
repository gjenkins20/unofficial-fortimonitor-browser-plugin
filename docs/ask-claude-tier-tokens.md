# Ask Claude tier token measurement (FMN-110, Phase 2.2)

Validation of the three Ask Claude tool tiers per FMN-94's Phase 2 polish goal: confirm that the catalog token cost stays in a reasonable range across the tiers so the tier toggle actually shifts cost meaningfully.

## How to run

```sh
# Offline: byte sizes + tool counts only
node tools/codegen/measure-tier-tokens.mjs

# With Anthropic count_tokens probe (authoritative token count):
ANTHROPIC_API_KEY=sk-ant-... node tools/codegen/measure-tier-tokens.mjs
```

The script lives at [`tools/codegen/measure-tier-tokens.mjs`](../tools/codegen/measure-tier-tokens.mjs). It loads `buildToolDefinitions(tier)` for each tier, stringifies, and (with the env var) probes `https://api.anthropic.com/v1/messages/count_tokens` for the input-token count of a turn that includes the full tools array.

## Snapshot (2026-04-28, post-FMN-94 epic merge)

| tier      | tools | bytes (stringified) | tokens (count_tokens) |
|-----------|------:|--------------------:|----------------------:|
| readonly  |   148 |             51.1 KB |     pending live run  |
| readwrite |   276 |             89.4 KB |     pending live run  |
| all       |   276 |             89.4 KB |     pending live run  |

Notes on the snapshot:
- `readwrite` and `all` are currently identical because no codegen or hand-port tool carries the `all` tier today. The `all` slot is reserved for future explicit-opt-in tools (e.g., the aggressive multi-server destroys mentioned in the FMN-94 risk section). Until such a tool lands the two tiers serve the same catalog.
- The `readonly` tier is roughly 57% of the `readwrite` byte size. As a token-count proxy that is encouraging - the tier toggle actually shifts cost.
- A 89.4 KB tools blob translates very approximately to 20-25k input tokens at typical English compression ratios. The FMN-94 ticket flagged 30k as the "sane budget" threshold for the `all` tier; the snapshot is below it. Re-run with `ANTHROPIC_API_KEY` set to confirm.

## Action thresholds

Per FMN-94: if `all` exceeds 30k input tokens just for tools, file a follow-up to scope tier-by-domain refinement (e.g., per-domain on-demand loading). The current bytes-based estimate is well under that threshold; no follow-up needed pending the live count_tokens probe.

## Cache stability

FMN-66 prompt cache: the tools block is marked `cache_control: ephemeral` on the last entry per turn, so the catalog reuses cache across turns within the 5-minute TTL. Cache busts when any tool definition's bytes change. FMN-108's level escalation renamed 47 codegen tools and the FMN-94 epic introduced 10 hand-port tools; first turn after upgrade pays a one-time cache miss, then subsequent turns hit. This is documented for completeness; no action item.

## Future work

- Run `count_tokens` against a live key to fill in the table above.
- Re-measure after each Phase 1 wire-up batch in the future (currently the wire-up is complete in one merge so this is a one-shot snapshot).
- If domain-level token shaping becomes necessary, consider a per-domain toggle in Settings rather than a fourth global tier.
