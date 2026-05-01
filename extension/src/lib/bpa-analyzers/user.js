// Unofficial FortiMonitor Toolkit - Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// UserAnalyzer port (FMN-132). Source: fortimonitor_audit.py / class UserAnalyzer.

import { counter } from './_helpers.js';

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
  const details = users.map((u) => buildDetail(u, frontend));

  // Sort oldest-created first (mirrors Python). Missing created defaults to
  // sort-after.
  details.sort((a, b) => {
    const ac = a.created || '9999';
    const bc = b.created || '9999';
    return ac < bc ? -1 : ac > bc ? 1 : 0;
  });

  const issues = [];
  const namesLower = counter(details.map((d) => String(d.name).toLowerCase()));
  for (const [name, cnt] of namesLower) {
    if (cnt > 1) {
      issues.push(`Possible duplicate user: '${name}' appears ${cnt} times`);
    }
  }

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

function buildDetail(u, frontend) {
  const name = u?.display_name || u?.name || u?.username || 'Unknown';
  const email = u?.email || u?.username || 'N/A';
  const created = u?.created ?? 'Unknown';
  let contactMethods = 0;
  if (Array.isArray(u?.contact_info)) contactMethods = u.contact_info.length;
  // FMN-135: when frontend (session-auth) data is present, prefer the
  // EditUser page's last_login / created_on values over the v2 fields
  // and the manual-entry fallback. The v2 API does not surface
  // last_login at all; created_on overlaps with v2's `created` but the
  // frontend version is human-formatted whereas v2 returns ISO. Keep
  // both views available so the viewer / consumers can pick.
  const idStr = u?.id != null ? String(u.id) : null;
  const fe = frontend && idStr && frontend[idStr] ? frontend[idStr] : null;
  const last_login = fe?.last_login ?? '';
  const last_login_manual = !fe?.last_login;
  const created_on_frontend = fe?.created_on ?? '';
  return {
    name,
    email,
    created,
    created_on: created_on_frontend,
    contact_methods: contactMethods,
    id: u?.id ?? '?',
    last_login,
    last_login_manual,
    roles: Array.isArray(u?.roles) ? u.roles : [],
    active_assessment: ''            // Manual entry - engineer assessment
  };
}
