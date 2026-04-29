# Ask Claude Codegen Audit (FMN-95, Phase 0a)

**Status:** completed (codegen pipeline shipped in FMN-96).
**Date:** 2026-04-27 (decision recorded), 2026-04-28 (codegen output landed).
**Source spec:** `~/Projects/fortimonitor-schema-discovery/data/compiled/openapi.json`.
**Reference:** [FMN-94 tracker](../../docs/mcp-chat-prototype.md) for the parent epic.

---

## Question

Is the schema-discovery OpenAPI complete enough to drive automatic codegen of the Ask Claude tool catalog (~260 tool definitions from the Python MCP server's tool surface)?

## Answer

**Hybrid approach.** Codegen covers the ~80% of Python MCP tools that map 1:1 to a single REST endpoint; workflow modules with logic the OpenAPI doesn't carry stay hand-written.

## Coverage matrix

| Python MCP module category | Approach | Notes |
|---|---|---|
| Single-endpoint reads (servers, outages, fabric, templates, contacts, dashboards, ...) | **Codegen** | OpenAPI has params, response shape, and summary for each. |
| Single-endpoint writes (create/update/delete on resources) | **Codegen** | Request body schema is present; tier classification by HTTP method. |
| Public outage operations (`/public/outage/{HASH}/...`) | **Codegen** | 6 tools, niche; written-tier. Disambiguated by FMN-108. |
| Workflow modules: `bulk_operations`, `composite`, `compound_services`, `guided_sessions` | **Hand-port** | Each tool issues 3-6 GETs and aggregates/transforms client-side. The OpenAPI describes endpoints, not workflows. |
| Server / outage / template "_enhanced" / "_management" Python wrappers | **Skipped for now** | Their value-add (summaries, custom shapes) overlaps with the runtime's own response trimming. Re-evaluate if Phase 1.x exposes the gap. |

## Codegen output (FMN-96)

- 262 tool definitions across 33 OpenAPI domains.
- Per-domain modules under `extension/src/lib/claude-tools/codegen/<domain>.js`.
- Hand-written dispatcher at `extension/src/lib/claude-tools/codegen/dispatcher.js` converts each tool's `_spec` block into a PanoptaClient-backed handler.
- Output is byte-stable across runs (sorted keys, no timestamps); FMN-66 prompt cache stays warm when inputs are unchanged.

## Naming-heuristic gap (resolved by FMN-108)

First-pass codegen used `<verb>_<lastResource>` and silently dropped 47 tools to name collisions in the runtime dedup loop. FMN-108 added ancestor-prefix level escalation plus a POST-on-single-resource carve-out (`replace_<resource>` vs `create_<resource>`). Final result: **262 tools, 262 unique names, zero collisions**.

## Hand-port follow-ups

Filed alongside this audit:
- **FMN-111** - `bulk_operations` (5 tools): bulk_acknowledge_outages, bulk_add_tags, bulk_remove_tags, search_servers_advanced, get_servers_with_active_outages.
- **FMN-112** - `composite` (5 tools): investigate_server, compare_servers, audit_monitoring_coverage, generate_incident_timeline, find_flapping_servers.

These are the workflow modules that don't fit codegen. Both ship as hand-written modules that compose the codegen-emitted clients + PanoptaClient methods.

## Schema-discovery gaps observed

None blocking. Two minor caveats:
- A small number of operations have generic `body: object` request schemas where the field-by-field schema isn't introspectable; codegen falls back to a single `body` parameter for those. Operators using Ask Claude on these tools will need to supply a freeform JSON object. Acceptable for v1.
- The `/contact/{contact_id}/contact_info` and `/contact/{contact_id}/contact_info/{contact_info_id}` POST endpoints have identical OpenAPI summaries ("Create contact's contact info"). FMN-108's POST-on-single-resource heuristic disambiguates them at the tool-name layer (`create_contact_info` vs `replace_contact_info`).

## Decision

Proceed to Phase 0b (codegen pipeline, FMN-96), Phase 0c (tier toggle UI, FMN-97), and Phase 1.x (per-domain wire-up, FMN-98-107) with the hybrid approach above. No upstream changes needed in the schema-discovery project.
