// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// MonitoringPolicyAnalyzer port (FMN-132).
// Source: fortimonitor_audit.py / class MonitoringPolicyAnalyzer.

import { counter, mostCommon, extractTrailingId } from './_helpers.js';

const NAMING_TOP_LIMIT = 15;
const NAMING_MIN_OCCURRENCES = 3;
const FQDN_TOP_LIMIT = 5;
const FQDN_MIN_OCCURRENCES = 3;
const AFFECTED_PREVIEW_LIMIT = 5;

/**
 * @typedef {Object} MonitoringPolicyResult
 * @property {Object[]} naming_patterns
 * @property {Object[]} group_template_mapping
 * @property {Object[]} automation_rules
 */

export function analyzeMonitoringPolicy(inventory = {}) {
  const servers = Array.isArray(inventory.servers) ? inventory.servers : [];
  const groupDetails = inventory.server_group_details ?? {};
  const templates = Array.isArray(inventory.server_templates) ? inventory.server_templates : [];

  return {
    naming_patterns: detectNamingPatterns(servers),
    group_template_mapping: analyzeGroupTemplates(groupDetails, templates),
    automation_rules: suggestAutomationRules(servers, groupDetails)
  };
}

function detectNamingPatterns(servers) {
  const names = servers.map((s) => String(s?.name ?? s?.fqdn ?? ''));
  if (names.length === 0) return [];

  // Tokenize on - _ . , strip digits, uppercase, count anything 2+ chars long.
  const tokens = [];
  for (const name of names) {
    if (!name) continue;
    for (const part of name.split(/[-_.]/)) {
      const cleaned = part.replace(/\d+/g, '').toUpperCase();
      if (cleaned.length >= 2) tokens.push(cleaned);
    }
  }
  const patternCounts = mostCommon(counter(tokens), NAMING_TOP_LIMIT);

  const results = [];
  for (const { key: pattern, count } of patternCounts) {
    if (count < NAMING_MIN_OCCURRENCES) continue;
    const patternLower = pattern.toLowerCase();
    const matching = names.filter((n) => n.toLowerCase().includes(patternLower));
    results.push({
      pattern: `*${pattern}*`,
      match_count: count,
      examples: matching.slice(0, 3).join(', '),
      observation: `${count} server names contain the token '${pattern}'.`
    });
  }
  return results;
}

function analyzeGroupTemplates(groupDetails, _templates) {
  const results = [];
  for (const [gid, detail] of Object.entries(groupDetails)) {
    const gname = detail?.name || `Group #${gid}`;
    const tmpl = detail?.server_template;
    const members = Array.isArray(detail?.server_list) ? detail.server_list : [];
    const memberCount = members.length;
    const hasTemplate = Boolean(tmpl);
    let templateLabel;
    if (tmpl && typeof tmpl === 'object') templateLabel = tmpl.name || 'Unknown';
    else templateLabel = String(tmpl || 'None');
    results.push({
      group: gname,
      id: gid,
      member_count: memberCount,
      has_template: hasTemplate,
      template: templateLabel,
      observation: hasTemplate ? '' : 'No monitoring template assigned to this group.'
    });
  }
  return results;
}

function suggestAutomationRules(servers, groupDetails) {
  const rules = [];

  // Rule 1: ungrouped servers
  const groupedServers = new Set();
  for (const detail of Object.values(groupDetails)) {
    const members = Array.isArray(detail?.server_list) ? detail.server_list : [];
    for (const m of members) {
      if (m && typeof m === 'object') {
        groupedServers.add(String(m.id ?? ''));
      } else if (typeof m === 'string') {
        const mid = extractTrailingId(m);
        if (mid != null) groupedServers.add(mid);
      }
    }
  }
  const ungroupedNames = [];
  for (const s of servers) {
    const sid = String(s?.id ?? '');
    if (sid && !groupedServers.has(sid)) {
      ungroupedNames.push(s?.name ?? sid);
    }
  }
  if (ungroupedNames.length > 0) {
    const preview = ungroupedNames.slice(0, AFFECTED_PREVIEW_LIMIT).join(', ');
    const more = ungroupedNames.length > AFFECTED_PREVIEW_LIMIT ? '...' : '';
    rules.push({
      rule: 'Ungrouped servers',
      description: `${ungroupedNames.length} server(s) are not in any group.`,
      affected: preview + more,
      observation: `No automation rule currently assigns these ${ungroupedNames.length} server(s) to a group.`
    });
  }

  // Rule 2: groups without a template
  const noTemplateGroups = [];
  for (const [gid, detail] of Object.entries(groupDetails)) {
    if (!detail?.server_template) {
      noTemplateGroups.push(detail?.name || `Group #${gid}`);
    }
  }
  if (noTemplateGroups.length > 0) {
    rules.push({
      rule: 'Groups without a template',
      description: `${noTemplateGroups.length} group(s) have no monitoring template.`,
      affected: noTemplateGroups.slice(0, AFFECTED_PREVIEW_LIMIT).join(', '),
      observation: `No automation rule currently applies a template to these ${noTemplateGroups.length} group(s).`
    });
  }

  // Rule 3: shared FQDN domains
  const fqdnPatterns = new Map();
  for (const s of servers) {
    const fqdn = s?.fqdn;
    if (typeof fqdn !== 'string' || !fqdn) continue;
    const parts = fqdn.split('.');
    if (parts.length < 2) continue;
    const domain = parts.slice(-2).join('.');
    fqdnPatterns.set(domain, (fqdnPatterns.get(domain) ?? 0) + 1);
  }
  const topDomains = [...fqdnPatterns.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, FQDN_TOP_LIMIT);
  for (const [domain, count] of topDomains) {
    if (count < FQDN_MIN_OCCURRENCES) continue;
    rules.push({
      rule: `Shared FQDN domain '${domain}'`,
      description: `${count} servers share the domain '${domain}'.`,
      affected: `${count} servers`,
      observation: `${count} servers share '${domain}' but no automation rule groups by FQDN.`
    });
  }

  return rules;
}
