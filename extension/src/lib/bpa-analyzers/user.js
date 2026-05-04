// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// UserAnalyzer port (FMN-132). Source: fortimonitor_audit.py / class UserAnalyzer.

import { userKeyOf, deriveActiveAssessment } from './_helpers.js';

/**
 * @typedef {Object} UserResult
 * @property {number} total
 * @property {Object[]} details
 * @property {Object|null} primary_user
 * @property {string[]} issues
 */

/** @param {Object} inventory */
export function analyzeUsers(inventory = {}) {
  const users = Array.isArray(inventory.users) ? inventory.users : [];
  const frontend = (inventory && typeof inventory.frontend_user_data === 'object')
    ? inventory.frontend_user_data
    : null;
  const now = Date.now();
  const details = users.map((u) => buildDetail(u, frontend, now));

  // Sort oldest-created first (mirrors Python). Missing created defaults to
  // sort-after.
  details.sort((a, b) => {
    const ac = a.created || '9999';
    const bc = b.created || '9999';
    return ac < bc ? -1 : ac > bc ? 1 : 0;
  });

  // FMN-135 follow-up (2026-05-01): the duplicate-name check was dropped
  // because it fires on legitimate setups in real tenants (e.g. an
  // operator with multiple anonaddy aliases for testing all named the
  // same display name). Real duplicate detection would need to compare
  // by something stronger than display_name. Until then, the noise is
  // worse than the signal.
  const issues = [];

  const noContact = details.filter((d) => d.contact_methods === 0);
  if (noContact.length > 0) {
    issues.push(`${noContact.length} user(s) have no contact methods configured`);
  }

  let primary = null;
  if (details.length > 0) {
    primary = details.reduce((best, d) =>
      (d.contact_methods > (best?.contact_methods ?? -Infinity) ? d : best),
      null
    );
  }

  return {
    total: users.length,
    details,
    primary_user: primary,
    issues
  };
}

function buildDetail(u, frontend, now) {
  const name = u?.display_name || u?.name || u?.username || 'Unknown';
  const email = u?.email || u?.username || 'N/A';
  const created = u?.created ?? 'Unknown';
  let contactMethods = 0;
  if (Array.isArray(u?.contact_info)) contactMethods = u.contact_info.length;
  // FMN-135 / FMN-143: source last_login + created_on from the
  // session-auth frontend fetcher. v2 API exposes neither field. The
  // join key (userKeyOf) must match the fetcher's keying. Empty string
  // when unavailable; the viewer renders 'N/A' (no manual fallback).
  const idStr = userKeyOf(u);
  const fe = frontend && idStr && frontend[idStr] ? frontend[idStr] : null;
  const last_login = fe?.last_login ?? '';
  const created_on_frontend = fe?.created_on ?? '';
  return {
    name,
    email,
    created,
    created_on: created_on_frontend,
    contact_methods: contactMethods,
    id: u?.id ?? idStr ?? '?',
    last_login,
    roles: Array.isArray(u?.roles) ? u.roles : [],
    active_assessment: deriveActiveAssessment(last_login || null, now)
  };
}
