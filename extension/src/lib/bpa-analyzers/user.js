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
  const details = users.map(buildDetail);

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

function buildDetail(u) {
  const name = u?.display_name || u?.name || u?.username || 'Unknown';
  const email = u?.email || u?.username || 'N/A';
  const created = u?.created ?? 'Unknown';
  let contactMethods = 0;
  if (Array.isArray(u?.contact_info)) contactMethods = u.contact_info.length;
  return {
    name,
    email,
    created,
    contact_methods: contactMethods,
    id: u?.id ?? '?',
    last_login: '',                  // Manual entry - not in API
    last_login_manual: true,
    roles: Array.isArray(u?.roles) ? u.roles : [],
    active_assessment: ''            // Manual entry - engineer assessment
  };
}
