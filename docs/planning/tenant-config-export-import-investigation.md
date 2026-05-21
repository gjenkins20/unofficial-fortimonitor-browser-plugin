# Tenant configuration export and import - feasibility catalog

FMN-227 investigation. **No implementation work in this ticket** - this doc enumerates per configuration class what it would take to snapshot a FortiMonitor tenant's full configuration and re-apply it under two import modes (restore: same tenant, replicate: different tenant). The output drives subsequent implementation tickets.

> Terminology: throughout this doc "ID space" = the integer + URL identifier space scoped to one tenant. A `server_template/100` in tenant A and `server_template/100` in tenant B are different resources. Replicate mode must remap; restore mode must NOT remap (the IDs still belong to the same tenant after a deletion-and-restore).

---

## TL;DR

| Class | Read | Write | Restore difficulty | Replicate difficulty |
|---|---|---|---|---|
| Server groups | v2 GET (paged) | v2 POST | easy | medium (parent URL rewrites) |
| Server templates - metadata | v2 GET | v2 PUT (metadata only) | medium | hard (URLs in template_resources) |
| Server templates - metrics + thresholds | session-auth `get_monitoring_config_data` | session-auth `editAgentMetric` (per-metric) + `createServerTemplate` for clone-from-device | hard | hard |
| Default-template mappings per server group | v2 GET `/server_group/{id}/templates` | v2 POST + DELETE | easy | medium |
| Monitoring-policy workflows | session-auth `monitoring_policy/get_page_data` | session-auth `addRuleset` + `editRuleset` (whole-config replace) | medium | hard (action values + clauses carry URLs/IDs) |
| Notification schedules | v2 GET | v2 POST/PUT | medium | hard (contact URL rewrites) |
| Users, teams, contacts | v2 GET | v2 POST/PUT | medium | hard (cascade of URL rewrites) |
| Escalation chains | v2 GET | v2 POST/PUT | medium | hard (contact + schedule URL rewrites) |
| SSO configuration | session-auth admin form | session-auth admin form (per-field POST) | medium | high effort - no IdP-side automation |
| Integrations (Slack / webhook) | v2 GET (metadata) | v2 POST | hard (secrets not exportable) | hard (secrets re-entry mandatory) |
| Custom server_attribute types | v2 GET | v2 POST | easy | easy |
| Server attributes (values) | v2 GET `/server/{id}/server_attribute` | v2 POST | easy | medium (typeUrl + serverUrl rewrites) |
| Tag assignments | v2 GET (inline on server) | v2 PUT (sanitized) | easy | medium (per-server PUT) |
| Status pages | v2 GET (HTTP 405 on some tenants) | v2 POST (likely; unverified) | unknown | unknown |
| Dashboards | unknown - no documented v2 endpoint | unknown | gap | gap |
| Scheduled reports | unknown - session-auth UI only | unknown | gap | gap |

Bottom line: a competent v1 covers the green-zone classes (server groups, attribute types, attribute values, tags, default-template mappings) and the medium-difficulty session-auth classes that are already well-captured (templates, MPWs). The hard classes (users + contacts + escalation + notification + integrations) need a separate phase because cross-tenant identity rewrites cascade. SSO + status pages + dashboards are out of scope for a first cut.

---

## Per-class catalog

### 1. Server groups + nesting

**Read.** `GET /v2/server_group?limit=100&offset=N` paged. Response carries `{ id, name, parent (URL), description }`. Already implemented as `PanoptaClient.listServerGroups()`.

**Write (create).** `POST /v2/server_group` body `{ name }`. Per CLAUDE.md FMN-65 notes, only `name` is accepted on POST; other fields (parent, description) must be set via subsequent PUT. Return body is empty; Location header carries the new URL.

**Write (update).** `PUT /v2/server_group/{id}` for parent + description.

**Identity rewrite (replicate).** `parent` is a URL; remap source-tenant URL to destination-tenant URL of the equivalent (name-matched) group. Create groups in dependency order (root first, then children) so the parent URL exists before the child references it.

**Restore-mode semantics.** Same-tenant IDs are stable. If a deleted group is recreated, the destination URL is NOT the same as before; any other resource that referenced the deleted group via URL becomes broken. Restore should re-create deleted groups AND re-stitch references that used them (templates with `server_group`, default-template mappings, servers' `server_group` field, MPWs that target group-id predicates).

**Dependency order.** Create groups before: templates, servers, default-template mappings, MPWs that reference groups.

**Gaps.** None obvious.

---

### 2. Server templates

This class splits into TWO write surfaces because v2 is incomplete.

**Read - metadata.** `GET /v2/server_template/{id}` - returns `{ name, server_group, tags, template_type, applied_servers }`. **No metrics, no thresholds.** This is sufficient for the "default templates per server group" mapping table but not for template content.

**Read - metrics + thresholds.** `GET /report/get_monitoring_config_data?server_id={template_id}` (session-auth, undocumented). Returns categories[] with metrics[] + alert_items[]. Templates and servers share the id namespace - same endpoint works for both.

**Write - create.** `POST /v2/server_template` is clone-only (`copy_from` URL required). True from-scratch creation requires the session-auth `POST /config/createServerTemplate` endpoint captured in FMN-203. Body: `{ server_id, template_name, template_type, select_options, instance_grp_name, notification_schedule, element_ids }`. Requires `X-XSRF-Token`.

**Write - populate metrics.** `POST /config/monitoring/editAgentMetric` (lowercase 'e') per-metric. Form-urlencoded. Memory `fortimonitor_template_and_metric_write_endpoints.md` documents the load-bearing fields.

**Write - update metadata.** `PUT /v2/server_template/{id}` accepts metadata-only fields (name, server_group, tags).

**Identity rewrite (replicate).** Multi-axis:
- `server_group` URL on the template -> destination URL of equivalent group
- `applied_servers` URLs -> destination server URLs (or skip; attach in the post-template apply step)
- Inside metrics: `alert_items` may carry contact / schedule URLs for escalation overrides; need rewrite too (verification needed)
- `template_type` is a string ("fabric_template" / "network_device_template" / others); stable cross-tenant

**Restore-mode semantics.** Re-creation via `createServerTemplate` from a non-FortiMonitor sample device requires picking some seed device. Restore should clone-from-the-original-source if the source still exists, otherwise create empty + per-metric populate (which the toolkit already does in FMN-200's profile-and-create-templates path).

**Dependency order.** Server groups must exist first. If `select_options: "yes"` clone is used, the source server must exist first too.

**Gaps.**
- Templates seeded by FortiMonitor's own discovery (the 8 catalog-hidden Fabric categories per FMN-204) are not addable via `editAgentMetric`. Restore of those is a no-op; the underlying device's feature being configured is what triggers them.
- `applied_servers` is read-only via this endpoint - attach is via the per-server template mapping endpoints, see class 3 / per-server.

---

### 3. Default-template mappings per server group

**Read.** `GET /v2/server_group/{id}/templates` - returns `[{ apply_order, continuous, server_template (URL) }]`. No `id` / `mapping_id` field; keyed by `(group_id, template_id)`.

**Write.** `POST /v2/server_group/{id}/templates` body `{ server_template, continuous }`. Returns 201 empty body. `DELETE /v2/server_group/{id}/templates/{template_id}` (second segment is the **template_id**, not a mapping id).

**Identity rewrite (replicate).** `server_template` URL.

**Restore-mode semantics.** No-op-friendly: a re-POST of an existing mapping is silently idempotent (verified live in FMN-202 Phase 1).

**Dependency order.** Server groups + templates must exist first.

**Gaps.** Retroactive-apply does NOT propagate (FMN-202 Phase 1). Attaching a template to a group is a forward-only setting that affects future new-member onboards. Replicate mode honors this; existing members are not affected by mapping replays alone.

---

### 4. Monitoring-policy workflows (MPWs / rulesets)

**Read.** `POST /monitoring_policy/get_page_data` returns `{ rulesets[], nounOptions, defaultServerGroup }`. The full ruleset config_json comes via `getRuleset`.

**Write - create.** `POST /monitoring_policy/addRuleset` with `{ index, name, description }`.

**Write - rules.** `POST /monitoring_policy/editRuleset` with `{ ruleset_id, config_json }`. Whole-config-replace.

**Write - metadata.** `POST /monitoring_policy/editRulesetMetadata` with `{ ruleset_id, name, description }`.

**Write - delete.** `POST /monitoring_policy/deleteRuleset`.

**Identity rewrite (replicate).** Heavy:
- `actions[].action_value` for `apply_template` carries the destination tenant's `server_template` ID
- `actions[].action_value` for `assign_to_group` carries `server_group` ID
- Clauses' `match_value` for `device_type` carries the noun-options' encoded `[sub_type]...` string - stable cross-tenant
- Clauses' `match_value` for `attribute` carries a textkey + value pair - textkey stable (system attrs) or per-tenant (customer-defined attribute types)

**Restore-mode semantics.** MPW writes have no built-in idempotence; re-creating a deleted ruleset gets a new id. Anything that referenced the old id (e.g. another MPW's chain, manual applyPolicy calls in scheduled tasks) won't auto-rebind. v1 restore would re-create and re-stitch.

**Dependency order.** Templates + server groups must exist first.

**Gaps.** None major. MPW auto-apply on onboard is native FortiMonitor behavior (confirmed FMN-202 2026-05-20), so newly-replicated MPWs DO take effect on subsequent onboards without further toolkit action.

---

### 5. Notification schedules

**Read.** `GET /v2/notification_schedule` (paged).

**Write.** `POST /v2/notification_schedule` + `PUT /v2/notification_schedule/{id}`. Schema TBD - not captured in this investigation. Schema discovery project at `~/Projects/fortimonitor-schema-discovery/` is the source of truth.

**Identity rewrite (replicate).** Schedules reference contacts and / or users; URL rewrites cascade through.

**Restore-mode semantics.** TBD - need to verify whether deleting a schedule is recoverable from an export.

**Dependency order.** Contacts / users must exist first.

**Gaps.** Investigation depth on schedule schema is light; this would need its own discovery sub-ticket before implementation.

---

### 6. Users, teams, contacts, escalation chains

**Read.** `GET /v2/user`, `GET /v2/team`, `GET /v2/contact`, `GET /v2/escalation_chain` - all paged. Per FMN-135 capture, contacts and users live in separate id spaces; the contact_id from `user.contact_info[].url` is NOT the user.id.

**Write.** `POST /v2/user` etc. v2 schema for create is mostly clean; passwords and SSO links not exportable.

**Identity rewrite (replicate).** Cascade:
- User -> contact_info[] (URLs to /v2/contact) -> contacts
- Team -> members[] (URLs to /v2/user)
- Escalation chain -> levels[] -> contacts + schedules
- Status of `last_login` and `created_on` is read-only metadata; do not write back

**Restore-mode semantics.** Re-creating a deleted user gets a new id; references in teams + escalation chains need re-stitch. Same caveat as MPWs.

**Dependency order.** Contacts before users, contacts + schedules before escalation chains, users before teams.

**Gaps.**
- **Passwords are not exportable.** Replicate mode requires operator to send password-reset emails to each user post-replicate, or rely on SSO (out of scope for v1).
- **SSO mappings** are tenant-specific; users authenticated via SSO have empty password fields, and the SSO config (class 7) must be in place before SSO users can log in.
- v2 `/account_history` returns HTTP 500 on at least one production tenant (memory: `fortimonitor_v2_list_wrapper_keys`). Audit trail of user creation is not reliable.

---

### 7. SSO configuration

**Read.** Session-auth admin form at Teams & Activity > Integrations > Edit SSO Configuration. Per FMN-139 (memory `fortimonitor_sso_admin_form.md`), 11 System Roles + per-field paste. **No XML import**, so the toolkit can paste fields one at a time but cannot bulk-import an XML metadata blob.

**Write.** Session-auth POST per field; toolkit would replay each field set.

**Identity rewrite (replicate).** IdP-side configuration (assertion URLs, certificate, etc.) is tenant-specific in BOTH directions: the IdP also has to point at the destination tenant's ACS URL. **Operator handles the IdP-side change**; toolkit can only replicate the FortiMonitor-side fields.

**Restore-mode semantics.** Same as replicate for the FortiMonitor side; restore on the same tenant means the IdP-side already points correctly.

**Gaps.** Cert / private-key material is not exportable from the SSO admin form in plaintext. v1 should treat SSO as **bring-your-own**: export records the System-Role mappings and labels; cert + IdP URLs are operator-supplied placeholders.

---

### 8. Integrations (Slack, webhook, etc.)

**Read.** `GET /v2/integration` lists configured integrations with their type + metadata. Auth secrets (Slack tokens, webhook signing secrets) are **never returned** in clear text.

**Write.** `POST /v2/integration` per type; requires operator to supply the secret material.

**Identity rewrite.** Per integration. Slack channel IDs are tenant-of-Slack-workspace (not FortiMonitor tenant), so they may transfer cleanly. Webhook URLs may be tenant-agnostic.

**Restore-mode semantics.** Secrets are unrecoverable without operator re-entry. Restore can re-stitch the integration metadata; operator pastes secrets in.

**Gaps.** Same as SSO: secrets exit the tenant as placeholders. Snapshot format should encode `secret: "<placeholder>"` explicitly so operator can grep + replace before re-import.

---

### 9. Custom server attribute types

**Read.** `GET /v2/server_attribute_type` - returns `{ id, name, textkey, resourceUrl }` per type. Already implemented as `PanoptaClient.listAttributeTypes()`.

**Write.** `POST /v2/server_attribute_type` body `{ name, textkey }`. Returns 201.

**Identity rewrite (replicate).** Type URL differs cross-tenant but `textkey` is stable - that's the cross-tenant key. Restore on same tenant keeps the URL.

**Restore-mode semantics.** Easy. Re-creating a deleted type with the same textkey is fine; any per-server `server_attribute` rows that referenced the deleted type's URL would need re-stitch (see class 10).

**Dependency order.** None outbound; this is a leaf.

**Gaps.** Built-in attribute types ("Model", "Operating System") live inline on `/v2/server` records and never appear in this catalog (memory `idp_data_field_path_findings`). They are NOT writable via this surface; the underlying device populates them.

---

### 10. Server attributes (values per server)

**Read.** `GET /v2/server/{id}/server_attribute` - paged. Already implemented as `PanoptaClient.listServerAttributes(serverId)`.

**Write.** `POST /v2/server/{id}/server_attribute` body `{ server_attribute_type (URL), value }`. Already implemented as `PanoptaClient.createServerAttribute()`.

**Identity rewrite (replicate).** Type URL + server URL both need destination rewrites. Type URL by textkey lookup (class 9); server URL by some cross-tenant identity (name match? attribute match? operator-specified mapping?).

**Restore-mode semantics.** Re-POSTing an attribute with the same type + value is fine; the value-set on a server is multi-value per type, so duplicates would land. Restore should delete-then-recreate, OR diff first.

**Gaps.** Server identity cross-tenant is the hard part - see class 11 (servers proper).

---

### 11. Servers (instances proper)

**Outside this investigation's scope.** Snapshot of which servers exist + their configurations is the BPA Audit's job, which is read-only. Replicating servers across tenants is a different problem: it requires re-onboarding each device (Fabric registration, OnSight registration, SNMP credentials, etc.) - that's a runtime concern, not a configuration concern.

For replicate mode v1: assume the destination tenant has its own (already-onboarded) servers, and what's being replicated is the configuration AROUND them (templates, attributes, tags, MPWs targeting them, etc.). Mapping source-tenant servers to destination-tenant servers is **operator-supplied**: provide a CSV mapping or fuzzy-match by name + attribute pattern.

---

### 12. Tags (assignments per server)

**Read.** Inline on `GET /v2/server/{id}` as the `tags` field (array of strings).

**Write.** `PUT /v2/server/{id}` with the updated `tags` array, routed through `sanitizeServerBodyForPut()` (FMN-206). Already implemented in `addServerTag` / `removeServerTag`.

**Identity rewrite.** Tag strings are tenant-portable - no rewrite needed.

**Restore-mode semantics.** PUT replaces the whole tag list. Restore overwrites; cleaner than the per-attribute multi-value model.

**Dependency order.** Server must exist first.

**Gaps.** None.

---

### 13. Status pages

**Read.** `GET /v2/status_page` returns **HTTP 405** on at least some production tenants (memory `fortimonitor_v2_list_wrapper_keys`). Behaves as if list-by-GET is unsupported for that account.

**Write.** Unverified.

**Investigation status.** Blocked on 405. Either the tenant has a permission flag we're missing, or the v2 endpoint is unreliable. v1 should treat status pages as **out of scope** with a clear explanation in the export doc.

---

### 14. Dashboards / scheduled reports

**Read.** No documented v2 endpoint. Session-auth UI is the only surface.

**Investigation status.** Out of scope for v1. Worth a separate discovery ticket if operator wants this in a v2 of the export tool.

---

## Snapshot format

### Versioning

`{ schema_version: "1.0", exported_at: "...", source_tenant_origin: "https://...", classes: { ... } }`. Schema bumps on:
- New classes added
- Existing class write surface changes (e.g. v2 finally exposes status pages)
- Identity-rewrite contract changes

Import code should hard-error on a `schema_version` newer than it knows about. Older versions can be migrated forward in-toolkit.

### Self-contained vs reference-by-URL

**Self-contained** is required for replicate mode (URLs are useless cross-tenant). For restore mode it works too (the source-tenant URLs still resolve, but self-contained avoids a fork in the import code path). One code path, less to maintain.

The snapshot stores destination-agnostic identifiers:
- For named-by-textkey resources (attribute types): textkey
- For named-only resources (server groups, templates, MPWs, contacts): name
- For URL-referenced resources inside a record: a synthetic `_ref` pointer to the in-snapshot resource. Import code resolves `_ref` to the destination tenant's actual URL.

Example:
```json
{
  "server_groups": [{ "_id": "g1", "name": "Production", "_parent": null }],
  "server_templates": [{ "_id": "t1", "name": "Edge FortiGate", "_server_group": "g1", "template_type": "fabric_template" }]
}
```

### Sensitive material

- **Passwords**: placeholder. Operator triggers password-reset emails post-replicate.
- **SSO cert / private keys**: placeholder. Operator re-enters in the SSO admin form.
- **Slack tokens / webhook secrets**: placeholder. Operator re-enters per integration.
- **API keys** (the toolkit's own auth surface): the snapshot is per-Chrome-profile and lives in `chrome.storage.local`; not in the export file.

Each placeholder is emitted as the literal string `"__OPERATOR_REENTRY__"` so a downstream tool can grep for unfilled slots.

### Size

Large tenants may export tens of MB. Snapshot is JSON; gzip the file at write-time. Chrome's Blob + `URL.createObjectURL` already supports 100+ MB exports per the FMN-154 snapshot diff tool. No streaming required at v1 scale.

---

## Dependency order for import

Strict topological order. Skip any class the snapshot didn't include.

1. Server attribute types
2. Server groups (root first, then children by parent depth)
3. Contacts
4. Users
5. Teams
6. Notification schedules
7. Escalation chains
8. SSO configuration (operator confirms IdP-side is ready first)
9. Integrations (operator pastes secrets)
10. Server templates (FortiGate-shape; other Fabric types in a second pass per FMN-211)
11. Default-template mappings per server group
12. Per-server tags + attributes + parent_group + applied templates (for servers that exist on the destination tenant)
13. Monitoring-policy workflows

Skipping the per-server step in replicate mode is fine: the toolkit can land everything above and the operator runs MPW.applyPolicy or the Bulk Action Composer "Apply toolkit-managed policies" pattern post-import.

---

## Suggested follow-up tickets

Sized so each has a clean acceptance criterion. Operator picks the order; the dependency block at top of this doc is just an analytical recommendation.

| Ticket | Scope |
|---|---|
| (a) | **Snapshot reader/writer module.** Pure-data classes + schema v1.0 contract. Versioning, gzip handling, sensitive-material placeholder convention. No network. Heavy unit tests. |
| (b) | **Export tool: green-zone classes.** Server groups + attribute types + attribute values + tags + default-template mappings. Reads via existing PanoptaClient methods. Writes the snapshot. One commit. |
| (c) | **Import tool: green-zone classes.** Reads a snapshot, applies in dependency order. Same-tenant restore mode first (URLs honored as-is); replicate mode added in a follow-up. |
| (d) | **Replicate-mode identity rewrites: green-zone.** Cross-tenant URL rewrites for the green-zone classes. Operator picks the destination tenant via a logged-into-two-tabs flow. |
| (e) | **Export+import: server templates.** Brings in the session-auth `createServerTemplate` + `editAgentMetric` path. Order-dependency on (b)/(c). |
| (f) | **Export+import: monitoring-policy workflows.** Action_value rewrites cascade through (e)'s template id mapping. |
| (g) | **Export+import: users + teams + contacts + escalation + schedules.** The hard cascade. Probably its own multi-ticket sub-epic. |
| (h) | **Sensitive-material UX.** Post-import diff showing every `__OPERATOR_REENTRY__` slot the operator needs to fill (integrations, SSO cert, etc.) with deep-links to the right admin pages. |

Out of scope for any of the above:
- Status pages (FortiMonitor v2 405)
- Dashboards / scheduled reports (no documented endpoint)
- Continuous sync between tenants (this is point-in-time; the diff tool's job is different)

---

## Out-of-band notes

- The toolkit is frontend-only (memory `no_fortimonitor_api.md`); both source and destination tenants must be open in this Chrome profile during a replicate run. The snapshot file is the handoff between the two.
- FortiMonitor v2 has no cross-tenant scope; each tenant looks like a separate origin. The toolkit's existing tenant-resolver (FMN-144) can already discover the destination origin from a logged-in tab.
- Some endpoints are known-unreliable on production tenants (`/v2/account_history` 500s, `/v2/status_page` 405s, observed FMN-133). Each affected class above flags this.
- Default Monitoring Templates (the FortiMonitor-shipped stock templates) are detectable by their server_group name (`Default Monitoring Templates`, memory FMN-135). Restore + replicate should both skip them: same-tenant restore would no-op (they exist); cross-tenant replicate should not duplicate them.
